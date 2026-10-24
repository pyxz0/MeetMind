import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.decorators';
import { hasGlobalMeetingAccess } from '../meetings/meetings.access';
import { isOverdue } from '../meetings/deadline';

/** 通知类型：被加为负责人 / 被加为成员 / 被共享 / 落库的会议消息 */
export type InboxNotificationType =
  | 'leader'
  | 'member'
  | 'share'
  | 'notice';

export interface InboxNotification {
  /** 同类记录的稳定标识，供前端做 key */
  key: string;
  type: InboxNotificationType;
  meetingId: number;
  meetingTitle: string;
  /** 共享时的授权人，其余类型为空 */
  actorName: string | null;
  /** 共享权限，仅 share 类型有值 */
  permission: 'READ' | 'EDIT' | null;
  /** 会议开始时间，仅 reminder 类型有值 */
  scheduledAt: string | null;
  /** 消息正文，仅 notice 类型有值 */
  content: string | null;
  createdAt: string;
  read: boolean;
}

export interface InboxTodo {
  id: number;
  meetingId: number;
  meetingTitle: string;
  content: string;
  assignee: string | null;
  deadline: string | null;
  /** 结构化截止时间；逾期排序用 */
  deadlineAt: string | null;
  /** 已过截止时间且未完成 */
  overdue: boolean;
  status: 'OPEN' | 'IN_PROGRESS';
  /** 待办负责人文本里包含我的名字 */
  mine: boolean;
  /** 所在会议由我负责 */
  leaderOwned: boolean;
}

/**
 * 交付相关的收件箱条目。
 *
 * 两种来源：
 * - reviews  待我验收（PENDING 且验收人是我，或未指定验收人而我是负责人）
 * - rejected 被我打回、需要我重新提交
 *
 * 这类条目是「待办的事」而不是消息，标记已读不会让它消失。
 */
export interface InboxReview {
  submissionId: number;
  todoId: number;
  meetingId: number;
  meetingTitle: string;
  todoContent: string;
  assignee: string | null;
  submitterName: string;
  attemptNo: number;
  submittedAt: string;
  rejectReason: string | null;
  /** 待验收也能看出逾期：过了截止时间还在等验收 */
  deadlineAt: string | null;
  overdue: boolean;
}

@Injectable()
export class InboxService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InboxService.name);
  private timer: NodeJS.Timeout | null = null;
  /** 上一次扫描「超时未验收」的时间戳，控制扫描频率 */
  private lastSubmissionSweep = 0;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 每分钟扫一次「即将开始的会议」，到期就发提醒。
   *
   * 关键点：提醒必须由服务端在到期时刻主动发出，
   * 这样消息里的时间是「真正发送到该账号的时间」，
   * 而不是用户碰巧打开收件箱的时间。
   */
  onModuleInit() {
    // 启动先跑一次，补上服务停机期间错过的提醒
    void this.sendDueReminders();
    void this.sendSubmissionReminders();
    this.lastSubmissionSweep = Date.now();

    this.timer = setInterval(() => {
      void this.sendDueReminders();

      // 催办是「按天」的量级，没必要每分钟扫一次提交表
      if (Date.now() - this.lastSubmissionSweep >= 5 * 60 * 1000) {
        this.lastSubmissionSweep = Date.now();
        void this.sendSubmissionReminders();
      }
    }, 60_000);
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 扫描所有到期会议，给负责人与成员发提醒。
   *
   * 幂等：部分唯一索引 (user_id, meeting_id) WHERE kind='reminder'
   * 保证同一会议对同一人只会有一条提醒。
   */
  async sendDueReminders() {
    const WINDOW_BEFORE_MS = 20 * 60 * 1000;
    const GRACE_AFTER_MS = 60 * 60 * 1000;
    const now = Date.now();

    try {
      const meetings = await this.prisma.meeting.findMany({
        where: {
          scheduledAt: {
            not: null,
            // 开会前 20 分钟已到（含开会后 1 小时宽限）
            gte: new Date(now - GRACE_AFTER_MS),
            lte: new Date(now + WINDOW_BEFORE_MS),
          },
        },
        select: {
          id: true,
          title: true,
          scheduledAt: true,
          leaders: { select: { userId: true } },
          members: { select: { userId: true } },
        },
        take: 200,
      });

      if (!meetings.length) {
        return;
      }

      const rows: Array<{
        userId: number;
        meetingId: number;
        kind: string;
        content: string;
      }> = [];

      const pad = (n: number) => String(n).padStart(2, '0');

      for (const meeting of meetings) {
        const scheduledAt = meeting.scheduledAt as Date;
        const when = `${pad(scheduledAt.getMonth() + 1)}/${pad(
          scheduledAt.getDate(),
        )} ${pad(scheduledAt.getHours())}:${pad(scheduledAt.getMinutes())}`;

        const recipients = new Set([
          ...meeting.leaders.map((l) => l.userId),
          ...meeting.members.map((m) => m.userId),
        ]);

        for (const userId of recipients) {
          rows.push({
            userId,
            meetingId: meeting.id,
            kind: 'reminder',
            content: `会议「${meeting.title}」将于 ${when} 开始，请准时参加`,
          });
        }
      }

      if (!rows.length) {
        return;
      }

      const result = await this.prisma.meetingNotice.createMany({
        data: rows,
        // 已发过的跳过，保证幂等
        skipDuplicates: true,
      });

      if (result.count > 0) {
        this.logger.log(`已发送 ${result.count} 条会议开始提醒`);
      }
    } catch (error) {
      // 定时任务失败不能影响接口，只记日志
      this.logger.error('发送会议提醒失败', error as Error);
    }
  }

  /**
   * 待验收超过 24 小时催办一次。
   *
   * 幂等：先用 updateMany 抢占 reminder_sent_at，抢到才发消息；
   * 多实例或并发扫描都不会重复催办。
   */
  async sendSubmissionReminders() {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

    try {
      const rows = await this.prisma.todoSubmission.findMany({
        where: {
          status: 'PENDING',
          reminderSentAt: null,
          createdAt: { lte: cutoff },
        },
        select: {
          id: true,
          reviewerId: true,
          todo: {
            select: {
              content: true,
              meetingId: true,
              meeting: {
                select: {
                  title: true,
                  leaders: { select: { userId: true } },
                },
              },
            },
          },
        },
        take: 200,
      });

      let sent = 0;

      for (const row of rows) {
        const claimed = await this.prisma.todoSubmission.updateMany({
          where: { id: row.id, status: 'PENDING', reminderSentAt: null },
          data: { reminderSentAt: new Date() },
        });

        if (!claimed.count) continue;

        // 没有验收人就催会议负责人，别让待验收悬着
        const recipients = row.reviewerId
          ? [row.reviewerId]
          : row.todo.meeting.leaders.map((leader) => leader.userId);

        const targets = [...new Set(recipients)];

        if (!targets.length) continue;

        await this.prisma.meetingNotice.createMany({
          data: targets.map((userId) => ({
            userId,
            meetingId: row.todo.meetingId,
            kind: 'todo_review_overdue',
            content: `待办「${row.todo.content}」已提交超过 24 小时，仍在等待你验收`,
          })),
        });

        sent += targets.length;
      }

      if (sent > 0) {
        this.logger.log(`已发送 ${sent} 条待验收催办`);
      }
    } catch (error) {
      // 定时任务失败不能影响接口，只记日志
      this.logger.error('发送待验收催办失败', error as Error);
    }
  }

  /**
   * 收件箱数据。
   *
   * 通知直接从「负责人 / 成员 / 共享」三类关系派生，
   * 不额外建通知表 —— 关系本身就是事实，避免双写不一致。
   */
  async getInbox(user: AuthenticatedUser) {
    const [
      leaders,
      members,
      shares,
      todoItems,
      reviewItems,
      seenAt,
      readRows,
      notices,
    ] = await Promise.all([
        this.prisma.meetingLeader.findMany({
          where: { userId: user.id },
          select: {
            createdAt: true,
            meeting: { select: { id: true, title: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: 100,
        }),
        this.prisma.meetingMember.findMany({
          where: { userId: user.id },
          select: {
            createdAt: true,
            meeting: { select: { id: true, title: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: 100,
        }),
        this.prisma.meetingShare.findMany({
          where: { userId: user.id },
          select: {
            createdAt: true,
            permission: true,
            meeting: { select: { id: true, title: true } },
            grantedBy: { select: { name: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: 100,
        }),
        this.collectTodos(user),
        this.collectReviews(user),
        this.prisma.user.findUnique({
          where: { id: user.id },
          select: { inboxSeenAt: true },
        }),
        this.prisma.inboxRead.findMany({
          where: { userId: user.id },
          select: { itemKey: true },
        }),
        this.prisma.meetingNotice.findMany({
          where: { userId: user.id },
          select: {
            id: true,
            content: true,
            createdAt: true,
            meeting: { select: { id: true, title: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: 100,
        }),
      ]);

    const seenAtDate = seenAt?.inboxSeenAt ?? null

    /** 已单独点开过的通知 */
    const readKeys = new Set(readRows.map((row) => row.itemKey));

    const isRead = (createdAt: Date) =>
      !!seenAtDate && createdAt.getTime() <= seenAtDate.getTime();

    const notifications: InboxNotification[] = [
      ...notices.map((row) => ({
        key: `notice-${row.id}`,
        type: 'notice' as const,
        meetingId: row.meeting.id,
        meetingTitle: row.meeting.title,
        actorName: null,
        permission: null,
        scheduledAt: null,
        content: row.content,
        createdAt: row.createdAt.toISOString(),
        read: false,
      })),
      ...leaders.map((row, index) => ({
        key: `leader-${row.meeting.id}-${index}`,
        type: 'leader' as const,
        meetingId: row.meeting.id,
        meetingTitle: row.meeting.title,
        actorName: null,
        permission: null,
        scheduledAt: null,
        content: null,
        createdAt: row.createdAt.toISOString(),
        read: isRead(row.createdAt),
      })),
      ...members.map((row, index) => ({
        key: `member-${row.meeting.id}-${index}`,
        type: 'member' as const,
        meetingId: row.meeting.id,
        meetingTitle: row.meeting.title,
        actorName: null,
        permission: null,
        scheduledAt: null,
        content: null,
        createdAt: row.createdAt.toISOString(),
        read: isRead(row.createdAt),
      })),
      ...shares.map((row, index) => ({
        key: `share-${row.meeting.id}-${index}`,
        type: 'share' as const,
        meetingId: row.meeting.id,
        meetingTitle: row.meeting.title,
        actorName: row.grantedBy?.name ?? null,
        permission: row.permission,
        scheduledAt: null,
        content: null,
        createdAt: row.createdAt.toISOString(),
        read: isRead(row.createdAt),
      })),
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      /**
       * 已读统一按「createdAt <= 已读时间」判定：
       * 提醒的 createdAt 是「开会前 20 分钟」，标记已读后自然变为已读。
       */
      .map((item) => ({
        ...item,
        // 单条已读优先，其次看「全部已读」的时间戳
        read:
          readKeys.has(item.key) ||
          isRead(new Date(item.createdAt)),
      }));

    /**
     * 待验收是「待办的事」，不是消息：标记已读不会让它消失，
     * 因此单独计入未读，避免角标与实际要做的事脱节。
     */
    const unreadCount =
      notifications.filter((n) => !n.read).length + reviewItems.reviews.length;

    return {
      notifications,
      todos: todoItems,
      /** 待我验收的提交 */
      reviews: reviewItems.reviews,
      /** 被验收人打回、需要我重新提交的待办 */
      rejected: reviewItems.rejected,
      unreadCount,
      seenAt: seenAtDate?.toISOString() ?? null,
    };
  }

  /** 标记通知已读：传 keys 只标记这几条，不传则全部标记已读 */
  async markRead(user: AuthenticatedUser, keys?: string[]) {
    const targets = Array.isArray(keys)
      ? [...new Set(keys)].filter((k) => typeof k === 'string' && k)
      : [];

    if (targets.length) {
      await this.prisma.inboxRead.createMany({
        data: targets.map((itemKey) => ({ userId: user.id, itemKey })),
        // 重复点击同一条不报错
        skipDuplicates: true,
      });

      const { unreadCount } = await this.getInbox(user);

      return { unreadCount };
    }

    const now = new Date();

    await this.prisma.user.update({
      where: { id: user.id },
      data: { inboxSeenAt: now },
    });

    return { seenAt: now.toISOString(), unreadCount: 0 };
  }

  /** 兼容旧调用：全部标记已读 */
  async markAllRead(user: AuthenticatedUser) {
    return this.markRead(user);
  }

  /** 只看未读数，供侧边栏角标使用 */
  async getUnreadCount(user: AuthenticatedUser) {
    const { unreadCount } = await this.getInbox(user);

    return { unreadCount };
  }

  /**
   * 待办提醒：只看「未完成（OPEN / IN_PROGRESS）」的待办。
   *
   * 入选条件（满足其一）：
   * - 待办负责人文本里包含我的名字（待办负责人是自由文本，只能模糊匹配）
   * - 所在会议的负责人包含我（我负责的会议里的待办由我盯着）
   */
  private async collectTodos(user: AuthenticatedUser): Promise<InboxTodo[]> {
    const meetings = await this.prisma.meeting.findMany({
      where: {
        AND: [
          this.visibleMeetingWhere(user),
          { todos: { some: { status: { in: ['OPEN', 'IN_PROGRESS'] } } } },
        ],
      },
      select: {
        id: true,
        title: true,
        leaders: { where: { userId: user.id }, select: { id: true } },
        todos: {
          where: { status: { in: ['OPEN', 'IN_PROGRESS'] } },
          select: {
            id: true,
            content: true,
            assignee: true,
            deadline: true,
            deadlineAt: true,
            status: true,
          },
          orderBy: { sortOrder: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const items: InboxTodo[] = [];

    for (const meeting of meetings) {
      const leaderOwned = meeting.leaders.length > 0;

      for (const todo of meeting.todos) {
        const mine =
          !!todo.assignee && todo.assignee.includes(user.name);

        if (!mine && !leaderOwned) {
          continue;
        }

        items.push({
          id: todo.id,
          meetingId: meeting.id,
          meetingTitle: meeting.title,
          content: todo.content,
          assignee: todo.assignee,
          deadline: todo.deadline,
          deadlineAt: todo.deadlineAt?.toISOString() ?? null,
          overdue: isOverdue(todo.deadlineAt, todo.status),
          status: todo.status as 'OPEN' | 'IN_PROGRESS',
          mine,
          leaderOwned,
        });
      }
    }

    /**
     * 排序优先级：逾期 → 指派给我 → 截止时间近的。
     * 收件箱是用来做事的，逾期的不该沉在列表底部。
     */
    return items.sort((a, b) => {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;

      if (a.mine !== b.mine) return Number(b.mine) - Number(a.mine);

      const aTime = a.deadlineAt ? Date.parse(a.deadlineAt) : Number.POSITIVE_INFINITY;
      const bTime = b.deadlineAt ? Date.parse(b.deadlineAt) : Number.POSITIVE_INFINITY;

      return aTime - bTime;
    });
  }

  /**
   * 待我验收 + 被我打回。
   *
   * 与 collectTodos 不同，这里以「提交记录」为主体：
   * 一条待办可能有多次提交，只有最近那次 PENDING 的需要处理。
   */
  private async collectReviews(
    user: AuthenticatedUser,
  ): Promise<{ reviews: InboxReview[]; rejected: InboxReview[] }> {
    const rows = await this.prisma.todoSubmission.findMany({
      where: {
        OR: [
          { status: 'PENDING' },
          { status: 'REJECTED', submitterId: user.id },
        ],
        todo: { meeting: this.visibleMeetingWhere(user) },
      },
      select: {
        id: true,
        status: true,
        attemptNo: true,
        createdAt: true,
        rejectReason: true,
        submitterId: true,
        reviewerId: true,
        submitter: { select: { name: true } },
        todo: {
          select: {
            id: true,
            content: true,
            assignee: true,
            deadlineAt: true,
            status: true,
            meeting: {
              select: {
                id: true,
                title: true,
                ownerId: true,
                leaders: { where: { userId: user.id }, select: { id: true } },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })

    const reviews: InboxReview[] = []
    const rejected: InboxReview[] = []

    for (const row of rows) {
      const isLeader =
        row.todo.meeting.ownerId === user.id ||
        row.todo.meeting.leaders.length > 0

      const item: InboxReview = {
        submissionId: row.id,
        todoId: row.todo.id,
        meetingId: row.todo.meeting.id,
        meetingTitle: row.todo.meeting.title,
        todoContent: row.todo.content,
        assignee: row.todo.assignee,
        submitterName: row.submitter.name,
        attemptNo: row.attemptNo,
        submittedAt: row.createdAt.toISOString(),
        rejectReason: row.rejectReason,
        deadlineAt: row.todo.deadlineAt?.toISOString() ?? null,
        overdue: isOverdue(row.todo.deadlineAt, row.todo.status),
      }

      if (row.status === 'PENDING') {
        // 指定了验收人就只有他能看到；没指定则落到会议负责人
        if (row.reviewerId === user.id || (row.reviewerId === null && isLeader)) {
          reviews.push(item)
        }
        continue
      }

      // REJECTED：只推给提交人，让他重新交付
      if (row.submitterId === user.id) {
        rejected.push(item)
      }
    }

    return { reviews, rejected }
  }

  /** 可见会议范围，与会议列表保持一致 */
  private visibleMeetingWhere(
    user: AuthenticatedUser,
  ): Prisma.MeetingWhereInput {
    if (hasGlobalMeetingAccess(user)) {
      return {};
    }

    return {
      OR: [
        { ownerId: user.id },
        { leaders: { some: { userId: user.id } } },
        { members: { some: { userId: user.id } } },
        { shares: { some: { userId: user.id } } },
      ],
    };
  }
}
