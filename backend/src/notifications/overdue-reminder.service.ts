import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { MailService } from '../common/mail.service';
import {
  cstDayKey,
  cstHour,
  daysBetweenCst,
  startOfCstDay,
} from '../common/datetime';
import {
  buildOverdueHtml,
  buildOverdueSubject,
  buildOverdueText,
  type OverdueItem,
} from './overdue-digest';

/** 每天几点（UTC+8）之后开始提醒。早上 9 点：开始一天的时候看到最有用 */
const REMIND_HOUR = 9;

/**
 * 连续提醒上限。
 *
 * 一条放了一个月的待办如果每天发一封信，用户会连整个域名一起屏蔽，
 * 结果是连真正重要的提醒也收不到。提醒 7 次还没动，说明需要人来处理，
 * 不是再来一封邮件能解决的。
 */
const MAX_NOTIFY_COUNT = 7;

/** 单轮最多扫多少条，防止异常数据把内存打满 */
const SCAN_LIMIT = 500;

/** 两次检查之间隔多久；真正的节奏由「每天一次」和数据库标记决定 */
const CHECK_INTERVAL_MS = 10 * 60 * 1000;

interface OverdueTodoRow {
  id: number;
  content: string;
  deadlineAt: Date | null;
  assigneeUserId: number | null;
  meeting: {
    id: number;
    title: string;
    leaders: { userId: number }[];
  };
}

/**
 * 待办逾期提醒。
 *
 * 与 NotificationsService 的分工：
 * - 那边消费 meeting_notices，把「站内已有的消息」发到邮箱；
 * - 这边没有站内对应物 —— 逾期只在收件箱的待办列表里，不是一条消息。
 *   所以它直接扫待办表，也不往 meeting_notices 写，避免收件箱被每日重复项撑满。
 *
 * 只提醒「该动手的人」：待办负责人。没指定负责人时才落到会议负责人，
 * 否则一个管理者管二十条待办，每天都会被别人的逾期刷屏。
 */
@Injectable()
export class OverdueReminderService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OverdueReminderService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** 已经跑过的 UTC+8 日期；只用来省掉重复查询，真正的幂等在数据库里 */
  private lastRunDay: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  onModuleInit() {
    if (!this.mail.configured) {
      this.logger.warn('未配置 SMTP，待办逾期提醒不会发出');
      return;
    }

    // 启动先检查一次：服务在 9 点之后才启动时，当天不该漏掉
    void this.runIfDue();

    this.timer = setInterval(() => {
      void this.runIfDue();
    }, CHECK_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 到点且今天还没跑过才执行。
   *
   * 为什么不是「每天 9:00 整点触发」：定时器会被重启、休眠、容器迁移打断，
   * 错过那一秒就整天不提醒。改成「过了 9 点且今天没跑过」，重启后能自己补上。
   */
  async runIfDue(now: Date = new Date()) {
    if (!this.mail.configured || this.running) {
      return { sent: 0, ran: false };
    }

    if (cstHour(now) < REMIND_HOUR) {
      return { sent: 0, ran: false };
    }

    const today = cstDayKey(now);

    if (this.lastRunDay === today) {
      return { sent: 0, ran: false };
    }

    this.running = true;

    try {
      const sent = await this.runOnce(now);

      // 只有真正跑完才记日期：中途抛错的话，下一轮还要能重试
      this.lastRunDay = today;

      return { sent, ran: true };
    } catch (error) {
      this.logger.error('逾期提醒扫描失败', error as Error);

      return { sent: 0, ran: false };
    } finally {
      this.running = false;
    }
  }

  /** 扫一轮并投递，返回成功覆盖的待办数 */
  private async runOnce(now: Date): Promise<number> {
    const dayStart = startOfCstDay(now);

    const todos = await this.prisma.todo.findMany({
      where: {
        deadlineAt: { not: null, lt: now },
        // SUBMITTED 交给「待验收超 24 小时」的催办，不在这里重复打扰验收人
        status: { in: ['OPEN', 'IN_PROGRESS'] },
        overdueNotifyCount: { lt: MAX_NOTIFY_COUNT },
        // 今天还没提醒过
        OR: [
          { overdueNotifiedAt: null },
          { overdueNotifiedAt: { lt: dayStart } },
        ],
        // 会议已经结束/取消就不用再催了
        meeting: { completionStatus: { notIn: ['CANCELLED', 'COMPLETED'] } },
      },
      select: {
        id: true,
        content: true,
        deadlineAt: true,
        assigneeUserId: true,
        meeting: {
          select: {
            id: true,
            title: true,
            leaders: { select: { userId: true } },
          },
        },
      },
      take: SCAN_LIMIT,
    });

    if (!todos.length) {
      return 0;
    }

    // 按收件人聚合：一个人当天只收一封信
    const byRecipient = new Map<number, OverdueTodoRow[]>();

    for (const todo of todos) {
      // 有结构化负责人就只找他；没有才落到会议负责人
      const recipients = todo.assigneeUserId
        ? [todo.assigneeUserId]
        : todo.meeting.leaders.map((leader) => leader.userId);

      for (const userId of new Set(recipients)) {
        const list = byRecipient.get(userId);

        if (list) {
          list.push(todo);
        } else {
          byRecipient.set(userId, [todo]);
        }
      }
    }

    if (!byRecipient.size) {
      return 0;
    }

    const users = await this.prisma.user.findMany({
      where: { id: { in: [...byRecipient.keys()] } },
      select: {
        id: true,
        name: true,
        email: true,
        notifyEmail: true,
        isActive: true,
      },
    });

    const userMap = new Map(users.map((user) => [user.id, user]));

    const delivered = new Set<number>();
    const failed = new Set<number>();

    for (const [userId, rows] of byRecipient) {
      const user = userMap.get(userId);

      /**
       * 没邮箱 / 关了提醒 / 账号停用：跳过且**不标记**。
       *
       * 和站内消息不同，逾期不是一次性事件 —— 用户明天绑了邮箱，
       * 这条待办仍然该提醒他。不标记的代价只是每天多查一次，
       * 而 lastRunDay 保证一天只跑一轮。
       */
      if (!user || !user.email || !user.notifyEmail || !user.isActive) {
        continue;
      }

      const items: OverdueItem[] = rows
        .map((row) => ({
          todoId: row.id,
          content: row.content,
          deadlineAt: row.deadlineAt as Date,
          overdueDays: Math.max(1, daysBetweenCst(row.deadlineAt as Date, now)),
          meetingId: row.meeting.id,
          meetingTitle: row.meeting.title,
        }))
        // 逾期最久的排最前，一封邮件里也先看到最该处理的
        .sort((a, b) => b.overdueDays - a.overdueDays);

      const payload = {
        recipientName: user.name,
        publicUrl:
          process.env.APP_PUBLIC_URL?.trim() || 'http://localhost:5173',
        items,
        total: items.length,
      };

      const ok = await this.mail.sendDigest(
        user.email,
        buildOverdueSubject(items, items.length),
        buildOverdueText(payload),
        buildOverdueHtml(payload),
      );

      if (ok) {
        rows.forEach((row) => delivered.add(row.id));
      } else {
        rows.forEach((row) => failed.add(row.id));
      }
    }

    /**
     * 只有「所有收件人都发成功」的待办才标记。
     *
     * 一条没有指定负责人的待办会同时发给多个会议负责人，
     * 只要有一个失败就不标记，下一轮重来 —— 宁可重复一次，
     * 也不要让某个负责人永远收不到。
     */
    const toMark = [...delivered].filter((id) => !failed.has(id));

    if (toMark.length) {
      await this.prisma.todo.updateMany({
        where: { id: { in: toMark } },
        data: { overdueNotifiedAt: now, overdueNotifyCount: { increment: 1 } },
      });
    }

    if (delivered.size) {
      this.logger.log(
        `逾期提醒已发出：${delivered.size} 条待办，覆盖 ${byRecipient.size} 人`,
      );
    }

    return delivered.size;
  }
}
