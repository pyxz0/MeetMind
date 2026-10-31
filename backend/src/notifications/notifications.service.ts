import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { MailService } from '../common/mail.service';
import {
  buildDigestHtml,
  buildDigestSubject,
  buildDigestText,
  type DigestItem,
} from './digest';

/** 只补发这个时间窗内的提醒，避免上线时把历史积压一次性轰出去 */
const BACKFILL_WINDOW_MS = 48 * 60 * 60 * 1000;

/** 单轮最多处理多少条，防止一次扫描把内存和 SMTP 连接打满 */
const BATCH_LIMIT = 200;

/**
 * 邮件提醒投递。
 *
 * 设计上是**站内消息的消费者**，不是替代品：
 * InboxService 照旧把提醒写进 meeting_notices，这里只负责把没发出去的那些
 * 走邮件送出去。好处是邮件挂了站内信照样在，反过来站内信也不会因为
 * SMTP 超时而延迟 —— 两条链路互不阻塞。
 *
 * 幂等靠 meeting_notices.emailed_at 的「先抢占再发信」：
 * 抢到才发，发失败回滚成 null，下一轮重试。
 */
@Injectable()
export class NotificationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationsService.name);
  private timer: NodeJS.Timeout | null = null;
  /** 上一轮还没跑完就不开下一轮，避免慢 SMTP 把任务堆起来 */
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  onModuleInit() {
    if (!this.mail.configured) {
      this.logger.warn(
        '未配置 SMTP，邮件提醒不会发出（站内收件箱不受影响）',
      );
      return;
    }

    // 启动先补一轮：服务停机期间产生的提醒不该丢
    void this.flush();

    this.timer = setInterval(() => {
      void this.flush();
    }, 2 * 60 * 1000);

    this.logger.log('邮件提醒已启用，每 2 分钟扫描一次未投递消息');
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 扫描并投递。
   *
   * 返回统计，方便手动触发时确认效果（测试与排查用）。
   */
  async flush(): Promise<{ delivered: number; skipped: number }> {
    if (!this.mail.configured || this.running) {
      return { delivered: 0, skipped: 0 };
    }

    this.running = true;

    try {
      const pending = await this.prisma.meetingNotice.findMany({
        where: {
          emailedAt: null,
          createdAt: { gte: new Date(Date.now() - BACKFILL_WINDOW_MS) },
        },
        orderBy: { createdAt: 'desc' },
        take: BATCH_LIMIT,
        select: {
          id: true,
          userId: true,
          content: true,
          meetingId: true,
          meeting: { select: { title: true } },
        },
      });

      if (!pending.length) {
        return { delivered: 0, skipped: 0 };
      }

      // 按人聚合成一封，别让一个人同时收到五封
      const byUser = new Map<number, typeof pending>();

      for (const row of pending) {
        const list = byUser.get(row.userId);

        if (list) {
          list.push(row);
        } else {
          byUser.set(row.userId, [row]);
        }
      }

      const users = await this.prisma.user.findMany({
        where: { id: { in: [...byUser.keys()] } },
        select: {
          id: true,
          name: true,
          email: true,
          notifyEmail: true,
          isActive: true,
        },
      });

      const userMap = new Map(users.map((user) => [user.id, user]));

      let delivered = 0;
      let skipped = 0;

      for (const [userId, rows] of byUser) {
        const user = userMap.get(userId);

        /**
         * 没绑邮箱 / 关了开关 / 账号停用：直接把消息标记成「已处理」。
         * 不标记的话，这批消息会被下一轮反复扫到，日志里全是噪音。
         */
        if (!user || !user.email || !user.notifyEmail || !user.isActive) {
          await this.markHandled(rows.map((row) => row.id));
          skipped += rows.length;
          continue;
        }

        const claimed = await this.claim(rows.map((row) => row.id));

        if (!claimed.length) {
          continue;
        }

        const items: DigestItem[] = claimed.map((id) => {
          const row = rows.find((item) => item.id === id)!;

          return {
            content: row.content,
            meetingId: row.meetingId,
            meetingTitle: row.meeting.title,
          };
        });

        const payload = {
          recipientName: user.name,
          publicUrl:
            process.env.APP_PUBLIC_URL?.trim() || 'http://localhost:5173',
          items,
          total: items.length,
        };

        const ok = await this.mail.sendDigest(
          user.email,
          buildDigestSubject(items, items.length),
          buildDigestText(payload),
          buildDigestHtml(payload),
        );

        if (ok) {
          delivered += claimed.length;
        } else {
          // 失败回滚，别把消息永久标记成已发
          await this.release(claimed);
        }
      }

      if (delivered > 0) {
        this.logger.log(`已通过邮件发出 ${delivered} 条提醒`);
      }

      if (skipped > 0) {
        this.logger.debug(`跳过 ${skipped} 条（未绑邮箱 / 已关闭提醒）`);
      }

      return { delivered, skipped };
    } catch (error) {
      // 定时任务失败不能影响主流程，只记日志
      this.logger.error('邮件提醒投递失败', error as Error);

      return { delivered: 0, skipped: 0 };
    } finally {
      this.running = false;
    }
  }

  /**
   * 抢占：只有 emailed_at 还是 null 的才算抢到。
   *
   * 逐条而不是批量，是因为批量 updateMany 只返回总数、拿不到具体 id，
   * 而发信必须知道每条的内容。这里的量级是「每人几条」，不值得为它优化。
   */
  private async claim(ids: number[]): Promise<number[]> {
    const claimed: number[] = [];

    for (const id of ids) {
      const result = await this.prisma.meetingNotice.updateMany({
        where: { id, emailedAt: null },
        data: { emailedAt: new Date() },
      });

      if (result.count > 0) {
        claimed.push(id);
      }
    }

    return claimed;
  }

  /** 发信失败：撤回标记，下一轮重试 */
  private async release(ids: number[]) {
    await this.prisma.meetingNotice.updateMany({
      where: { id: { in: ids } },
      data: { emailedAt: null },
    });
  }

  /** 无邮箱或已关闭提醒：标记成已处理，不再重复扫描 */
  private async markHandled(ids: number[]) {
    await this.prisma.meetingNotice.updateMany({
      where: { id: { in: ids }, emailedAt: null },
      data: { emailedAt: new Date() },
    });
  }
}
