import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { readFile, unlink } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { PrismaService } from '../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth.decorators';
import { hasGlobalMeetingAccess } from '../meetings/meetings.access';
import {
  buildFileUrl,
  isAllowedFile,
  isTextFile,
  MAX_ASR_FILE_BYTES,
} from './asr-file-url';
import { createAsrProvider } from './providers';
import type { AsrProvider } from './providers/asr-provider';

/** 轮询间隔与总时长：一小时会议在腾讯云通常 2–5 分钟出结果 */
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;

/** 纯文本上传时截断到 20 万字，避免整本书的 txt 塞爆数据库 */
const MAX_TEXT_CHARS = 200_000;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

@Injectable()
export class AsrService implements OnModuleInit {
  private readonly logger = new Logger(AsrService.name);
  private readonly provider: AsrProvider;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {
    this.provider = createAsrProvider();
  }

  onModuleInit() {
    /**
     * 启动日志必须能一眼看出用的是哪条通道：
     * mock 会把会议内容换成占位文本，配置错了比报错更难发现。
     */
    this.logger.log(`转写通道：${this.provider.name}`);

    void this.recoverStaleJobs();
  }

  /** 进程被杀时残留的任务标记失败，避免用户对着 PENDING 一直等 */
  private async recoverStaleJobs() {
    try {
      const affected = await this.prisma.asrJob.updateMany({
        where: { status: { in: ['PENDING', 'RUNNING'] } },
        data: { status: 'FAILED', error: '服务重启，转写中断，请重新上传' },
      });

      if (affected.count > 0) {
        this.logger.warn(`启动自愈：${affected.count} 个转写任务标记为失败`);
      }
    } catch (error) {
      this.logger.error(
        `转写任务自愈失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * 上传后建任务。
   *
   * 纯文本文件不花转写费用，直接读进 transcript；
   * 音视频先落 PENDING，再丢给后台跑（与 AI 生成同样的「进程内异步」模式）。
   */
  async createFromUpload(
    user: AuthenticatedUser,
    file: {
      originalname?: string;
      storedPath: string;
      sizeBytes: number;
    },
  ) {
    const filename = (file.originalname ?? '').trim() || '未命名文件';

    if (!isAllowedFile(filename)) {
      throw new BadRequestException(
        '不支持这种文件类型，可上传 mp3 / wav / m4a / aac / flac / ogg / amr / mp4 或 txt / md',
      );
    }

    if (file.sizeBytes > MAX_ASR_FILE_BYTES) {
      throw new BadRequestException('文件超过 300MB 上限');
    }

    const base = {
      userId: user.id,
      filename: filename.slice(0, 255),
      storedPath: file.storedPath,
      sizeBytes: file.sizeBytes,
      provider: this.provider.name,
    };

    if (isTextFile(filename)) {
      const absolute = join(process.cwd(), file.storedPath);
      const content = await readFile(absolute, 'utf8');

      const job = await this.prisma.asrJob.create({
        data: {
          ...base,
          status: 'SUCCEEDED',
          transcript: content.slice(0, MAX_TEXT_CHARS),
        },
      });

      await this.audit.record(user, {
        action: 'asr.upload',
        resourceType: 'asr_job',
        resourceId: job.id,
        metadata: { filename: job.filename, sizeBytes: job.sizeBytes, mode: 'text' },
      });

      return this.toApi(job);
    }

    const job = await this.prisma.asrJob.create({
      data: { ...base, status: 'PENDING' },
    });

    await this.audit.record(user, {
      action: 'asr.upload',
      resourceType: 'asr_job',
      resourceId: job.id,
      metadata: { filename: job.filename, sizeBytes: job.sizeBytes, mode: 'asr' },
    });

    void this.run(job.id);

    return this.toApi(job);
  }

  /**
   * 转写主流程：提交 → 轮询 → 落库。
   *
   * 整段都包在 try/catch 里：任何一步失败都要把任务标成 FAILED，
   * 否则前端会永远停在 RUNNING。
   */
  private async run(jobId: number) {
    const job = await this.prisma.asrJob.findUnique({ where: { id: jobId } });

    if (!job) return;

    try {
      const url = buildFileUrl(job.id);

      if (!url) {
        throw new Error('未配置 APP_PUBLIC_URL，转写服务无法拉取文件');
      }

      const format = extname(job.filename).replace('.', '').toLowerCase();
      const { taskId } = await this.provider.submit(url, format);

      await this.prisma.asrJob.update({
        where: { id: job.id },
        data: { status: 'RUNNING', providerTaskId: taskId },
      });

      const deadline = Date.now() + POLL_TIMEOUT_MS;

      while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);

        const result = await this.provider.poll(taskId);

        if (result.status === 'running') continue;

        if (result.status === 'failed') {
          throw new Error(result.error ?? '转写失败');
        }

        await this.prisma.asrJob.update({
          where: { id: job.id },
          data: {
            status: 'SUCCEEDED',
            transcript: result.text ?? '',
            durationSec: result.durationSec ?? null,
            error: null,
          },
        });

        return;
      }

      throw new Error('转写超时（30 分钟），请稍后重试或换更小的文件');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.error(`转写任务 ${job.id} 失败：${message}`);

      await this.prisma.asrJob
        .update({
          where: { id: jobId },
          data: { status: 'FAILED', error: message.slice(0, 1000) },
        })
        .catch(() => undefined);
    }
  }

  /** 任务详情：本人或管理员可看 */
  async findOne(id: number, user: AuthenticatedUser) {
    const job = await this.prisma.asrJob.findUnique({ where: { id } });

    if (!job) {
      throw new NotFoundException('转写任务不存在');
    }

    if (job.userId !== user.id && !hasGlobalMeetingAccess(user)) {
      throw new ForbiddenException('无权查看该转写任务');
    }

    return this.toApi(job);
  }

  /** 最近的上传记录（只含自己的） */
  async listMine(user: AuthenticatedUser) {
    const jobs = await this.prisma.asrJob.findMany({
      where: { userId: user.id },
      orderBy: { id: 'desc' },
      take: 20,
    });

    return jobs.map((job) => this.toApi(job));
  }

  /** 删除任务，同时清理磁盘文件 */
  async remove(id: number, user: AuthenticatedUser) {
    const job = await this.prisma.asrJob.findUnique({ where: { id } });

    if (!job) {
      throw new NotFoundException('转写任务不存在');
    }

    if (job.userId !== user.id && !hasGlobalMeetingAccess(user)) {
      throw new ForbiddenException('无权删除该转写任务');
    }

    await this.prisma.asrJob.delete({ where: { id } });

    await unlink(join(process.cwd(), job.storedPath)).catch(() => undefined);

    return { deleted: true };
  }

  /**
   * 前端展示用结构。
   *
   * fileUrl 是带签名的地址：既给转写服务商拉取，也能让用户直接在页面里试听。
   * 一小时后过期，刷新页面会重新生成。
   */
  private toApi(job: {
    id: number;
    filename: string;
    sizeBytes: number;
    status: string;
    transcript: string | null;
    durationSec: number | null;
    error: string | null;
    provider: string;
    createdAt: Date;
  }) {
    return {
      id: job.id,
      filename: job.filename,
      sizeBytes: job.sizeBytes,
      status: job.status,
      transcript: job.transcript,
      durationSec: job.durationSec,
      error: job.error,
      provider: job.provider,
      /** 带签名的文件地址：转写服务商拉取用，前端也可以直接试听 */
      fileUrl: buildFileUrl(job.id),
      createdAt: job.createdAt.toISOString(),
    };
  }
}
