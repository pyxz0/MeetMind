import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';

/**
 * 后台任务的执行记录。
 *
 * 为什么需要它：会议提醒、邮件投递、逾期提醒都是「发出去才有价值」的任务，
 * 但它们跑在进程内定时器里，失败只写一行 logger.error —— 没人会去看。
 * 一条提醒没发出去，用户以为没到时间，管理员以为发了，实际谁都不知道。
 */

/** 任务的静态定义：接口按这个顺序展示 */
export interface JobDefinition {
  key: string;
  label: string;
  /** 人类可读的频率说明 */
  interval: string;
  /** 超过多久没执行就认为可能卡住 */
  staleAfterMs: number;
}

export const JOB_DEFINITIONS: JobDefinition[] = [
  {
    key: 'inbox-reminder',
    label: '会议开始提醒',
    interval: '每分钟',
    staleAfterMs: 5 * 60_000,
  },
  {
    key: 'submission-reminder',
    label: '待验收催办',
    interval: '每 5 分钟',
    staleAfterMs: 20 * 60_000,
  },
  {
    key: 'notice-delivery',
    label: '提醒邮件投递',
    interval: '每 2 分钟',
    staleAfterMs: 10 * 60_000,
  },
  {
    key: 'overdue-reminder',
    label: '待办逾期提醒',
    interval: '每天 9:00 后',
    // 一天只真正跑一次，阈值放到 26 小时：9 点前的空转不该判成卡住
    staleAfterMs: 26 * 60 * 60_000,
  },
];

export interface JobOverview extends JobDefinition {
  /** 最后一次执行时间（进程内记录，重启后为 null） */
  lastRunAt: string | null;
  lastStatus: 'OK' | 'FAILED' | null;
  /** 上次实际处理了多少条 */
  lastAffected: number;
  lastDurationMs: number;
  lastError: string | null;
  /**
   * 上次是被主动跳过的（例如未配置 SMTP）。
   *
   * 必须和「没执行」区分开：否则界面上「未配置」和「定时器挂了」
   * 长得一模一样，等于换了个地方继续黑盒。
   */
  skipped: boolean;
  /** 近 24 小时有动作的次数 / 失败次数（来自数据库） */
  runs24h: number;
  failures24h: number;
  lastFailureAt: string | null;
  /** 超过预期周期没有执行 —— 定时器可能停了 */
  stale: boolean;
}

interface Snapshot {
  at: Date;
  ok: boolean;
  affected: number;
  durationMs: number;
  error?: string;
  skipped?: boolean;
}

@Injectable()
export class JobRunService {
  private readonly logger = new Logger(JobRunService.name);

  /**
   * 进程内的最近一次执行状态。
   *
   * 心跳不落库：每分钟一条会让 job_runs 一天涨到几千行，
   * 而「任务还活着吗」这个问题，内存里的时间戳就能回答。
   */
  private readonly snapshots = new Map<string, Snapshot>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 包住一次任务执行。
   *
   * 失败**不向上抛**：定时器回调里的异常会变成 unhandled rejection，
   * 轻则刷屏日志，重则打崩进程 —— 一个提醒发不出去，不该影响整个服务。
   */
  async track(
    job: string,
    fn: () => Promise<{ affected: number; skipped?: boolean }>,
  ): Promise<void> {
    const at = new Date();
    const began = Date.now();

    try {
      const result = await fn();
      const durationMs = Date.now() - began;

      this.snapshots.set(job, {
        at,
        ok: true,
        affected: result.affected,
        durationMs,
        skipped: result.skipped,
      });

      // 空跑不记：只留「真的发了东西」的痕迹
      if (result.affected > 0) {
        await this.persist(job, 'OK', result.affected, durationMs);
      }
    } catch (error) {
      const durationMs = Date.now() - began;
      const message = error instanceof Error ? error.message : String(error);

      this.snapshots.set(job, {
        at,
        ok: false,
        affected: 0,
        durationMs,
        error: message,
      });

      this.logger.error(`任务 ${job} 执行失败：${message}`);

      await this.persist(job, 'FAILED', 0, durationMs, message);
    }
  }

  /** 管理端视图：静态定义 + 内存状态 + 近 24 小时统计 */
  async overview(): Promise<JobOverview[]> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [counts, failures] = await Promise.all([
      this.prisma.jobRun.groupBy({
        by: ['job', 'status'],
        where: { ranAt: { gte: since } },
        _count: { _all: true },
      }),
      this.prisma.jobRun.findMany({
        where: { status: 'FAILED', ranAt: { gte: since } },
        orderBy: { ranAt: 'desc' },
        distinct: ['job'],
        select: { job: true, ranAt: true },
      }),
    ]);

    const countOf = (job: string, status: string) =>
      counts.find((row) => row.job === job && row.status === status)?._count
        ?._all ?? 0;

    return JOB_DEFINITIONS.map((def) => {
      const snap = this.snapshots.get(def.key);
      const failure = failures.find((row) => row.job === def.key);

      return {
        ...def,
        lastRunAt: snap?.at.toISOString() ?? null,
        lastStatus: snap ? (snap.ok ? 'OK' : 'FAILED') : null,
        lastAffected: snap?.affected ?? 0,
        lastDurationMs: snap?.durationMs ?? 0,
        lastError: snap?.error ?? null,
        skipped: snap?.skipped ?? false,
        runs24h: countOf(def.key, 'OK'),
        failures24h: countOf(def.key, 'FAILED'),
        lastFailureAt: failure?.ranAt.toISOString() ?? null,
        /**
         * 没有快照说明「启动后还没轮到它」，不算卡住；
         * 有快照但太旧，才说明定时器可能停了。
         */
        stale: snap ? Date.now() - snap.at.getTime() > def.staleAfterMs : false,
      };
    });
  }

  /** 清理旧记录，避免无限增长；由逾期提醒那类低频任务顺手调用 */
  async prune(keepDays = 30): Promise<number> {
    const before = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000);

    const result = await this.prisma.jobRun.deleteMany({
      where: { ranAt: { lt: before } },
    });

    return result.count;
  }

  private async persist(
    job: string,
    status: 'OK' | 'FAILED',
    affected: number,
    durationMs: number,
    error?: string,
  ): Promise<void> {
    try {
      await this.prisma.jobRun.create({
        data: {
          job,
          status,
          affected,
          durationMs,
          // 错误信息可能很长（堆栈），只留前 2000 字
          error: error ? error.slice(0, 2000) : null,
        },
      });
    } catch (writeError) {
      /**
       * 记录失败不能再抛：这层是「观测」，它自己坏掉不能反过来影响被观测的任务。
       * 只降级成一条 warning。
       */
      this.logger.warn(
        `写入任务记录失败（${job}）：${
          writeError instanceof Error ? writeError.message : String(writeError)
        }`,
      );
    }
  }
}
