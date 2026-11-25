import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { JobRunService } from '../system/job-run.service';
import type { AuthenticatedUser } from '../auth/auth.decorators';
import { hasTenantWideMeetingAccess } from '../meetings/meetings.access';
import { isOverdue } from '../meetings/deadline';
import { formatCstShort } from '../common/datetime';

/**
 * 收件箱待办列表的展示上限。
 *
 * 超出的不截断到「悄悄少几条」—— 命中上限会打一条 warn，
 * 让「收件箱里没有」这件事有迹可循。真正需要全量时该走待办列表页，
 * 而不是把收件箱当报表用。
 */
const INBOX_TODO_LIMIT = 200;

/**
 * 待认领池的展示上限。
 *
 * 池子比「我的待办」更容易堆东西 —— 一场会里 AI 没认出人名的待办会全部进来。
 * 超过上限说明流程本身有问题（没人指派），不是靠翻更多页能解决的。
 */
const UNCLAIMED_LIMIT = 50;

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
  /** 提交人 id：前端据此打开个人主页 */
  submitterId: number;
  submitterName: string;
  attemptNo: number;
  submittedAt: string;
  rejectReason: string | null;
  /** 待验收也能看出逾期：过了截止时间还在等验收 */
  deadlineAt: string | null;
  overdue: boolean;
  /**
   * 交付说明。
   *
   * 收件箱里要能直接看到，否则验收人得先跳进会议详情才知道对方交了什么 ——
   * 那正是「收件箱只能当通知栏」的根因。
   */
  note: string | null;
  /** 附件数量；有附件时列表上直接标出来，别让人以为只有一句话 */
  attachmentCount: number;
  /** 验收要点进度：「3/5 已勾」比「有 5 条要点」有用得多 */
  checklistTotal: number;
  checklistDone: number;
  /** 指定的验收人；与当前用户不一致说明这条是代验收 */
  reviewerId: number | null;
}

/**
 * 待认领的待办。
 *
 * 来源是「没有结构化负责人」的未完成待办 —— AI 提取时只给了「李总」「小王」
 * 这类对不上账号的称呼，或者会上根本没点谁做。这类待办以前只能在会议详情里
 * 干挂着，没人认领也就没人处理，闭环在这里断掉。
 *
 * 池子只对**可写会议**开放：只读共享给你的人看得见却点不了，不如不显示。
 */
export interface InboxUnclaimed {
  id: number;
  meetingId: number;
  meetingTitle: string;
  content: string;
  /** AI 给出的姓名文本；认领人据此判断「这是不是我」 */
  assigneeHint: string | null;
  deadline: string | null;
  deadlineAt: string | null;
  overdue: boolean;
}

@Injectable()
export class InboxService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InboxService.name);
  private timer: NodeJS.Timeout | null = null;
  /** 上一次扫描「超时未验收」的时间戳，控制扫描频率 */
  private lastSubmissionSweep = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobRunService,
  ) {}

  /**
   * 每分钟扫一次「即将开始的会议」，到期就发提醒。
   *
   * 关键点：提醒必须由服务端在到期时刻主动发出，
   * 这样消息里的时间是「真正发送到该账号的时间」，
   * 而不是用户碰巧打开收件箱的时间。
   */
  onModuleInit() {
    // 启动先跑一次，补上服务停机期间错过的提醒
    void this.runDueReminders();
    void this.runSubmissionReminders();
    this.lastSubmissionSweep = Date.now();

    this.timer = setInterval(() => {
      void this.runDueReminders();

      // 催办是「按天」的量级，没必要每分钟扫一次提交表
      if (Date.now() - this.lastSubmissionSweep >= 5 * 60 * 1000) {
        this.lastSubmissionSweep = Date.now();
        void this.runSubmissionReminders();
      }
    }, 60_000);
  }

  /** 会议开始提醒，包一层记录：失败不再静默 */
  private runDueReminders() {
    return this.jobs.track('inbox-reminder', async () => ({
      affected: await this.sendDueReminders(),
    }));
  }

  private runSubmissionReminders() {
    return this.jobs.track('submission-reminder', async () => ({
      affected: await this.sendSubmissionReminders(),
    }));
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
  async sendDueReminders(): Promise<number> {
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
          /** 通知要跟着会议的归属空间走，收件箱按空间隔离时靠它 */
          tenantId: true,
          leaders: { select: { userId: true } },
          members: { select: { userId: true } },
        },
        take: 200,
      });

      if (!meetings.length) {
        return 0;
      }

      const rows: Array<{
        tenantId: string;
        userId: number;
        meetingId: number;
        kind: string;
        content: string;
      }> = [];

      for (const meeting of meetings) {
        const scheduledAt = meeting.scheduledAt as Date;
        /**
         * 必须按 UTC+8 渲染，不能用 getHours()：
         * 容器里是 UTC，会把 14:30 的会写成 06:30，
         * 这条文案同时进收件箱和提醒邮件，写成错的比不发更糟。
         */
        const when = formatCstShort(scheduledAt);

        const recipients = new Set([
          ...meeting.leaders.map((l) => l.userId),
          ...meeting.members.map((m) => m.userId),
        ]);

        for (const userId of recipients) {
          rows.push({
            tenantId: meeting.tenantId,
            userId,
            meetingId: meeting.id,
            kind: 'reminder',
            content: `会议「${meeting.title}」将于 ${when} 开始，请准时参加`,
          });
        }
      }

      if (!rows.length) {
        return 0;
      }

      const result = await this.prisma.meetingNotice.createMany({
        data: rows,
        // 已发过的跳过，保证幂等
        skipDuplicates: true,
      });

      if (result.count > 0) {
        this.logger.log(`已发送 ${result.count} 条会议开始提醒`);
      }

      return result.count;
    } catch (error) {
      // 定时任务失败不能影响接口，只记日志；同时抛给上层记录到 job_runs
      this.logger.error('发送会议提醒失败', error as Error);
      throw error;
    }
  }

  /**
   * 待验收超过 24 小时催办一次。
   *
   * 幂等：先用 updateMany 抢占 reminder_sent_at，抢到才发消息；
   * 多实例或并发扫描都不会重复催办。
   */
  async sendSubmissionReminders(): Promise<number> {
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
                  tenantId: true,
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
            tenantId: row.todo.meeting.tenantId,
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

      return sent;
    } catch (error) {
      // 定时任务失败不能影响接口，只记日志；同时抛给上层记录到 job_runs
      this.logger.error('发送待验收催办失败', error as Error);
      throw error;
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
      unclaimedItems,
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
        this.collectUnclaimed(user),
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
      /** 还没人负责的待办：谁认谁做 */
      unclaimed: unclaimedItems,
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
        data: targets.map((itemKey) => ({
          tenantId: user.activeTenantId,
          userId: user.id,
          itemKey,
        })),
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
   * - 待办的结构化负责人是我（assigneeUserId）
   * - 我是该待办所属会议的负责人（这场会的待办都由我盯着）
   * - 兜底：assigneeUserId 没解析出来，但负责人姓名与我的账号完全一致
   *
   * 归属判定只认 assigneeUserId，不用 `assignee.includes(name)`：
   * 用户名「张三」会把「张三丰」的待办也捞进来，反向的别名（「李总」）
   * 又永远匹配不上。schema.prisma 里 Todo.assignee 的注释写的就是这件事。
   *
   * 兜底那一条不能省：AI 提取时负责人只给姓名，重名或匹配不上就留空
   * assigneeUserId。只按 ID 判定会让这批历史待办从收件箱里彻底消失，
   * 比误报更难被发现。
   *
   * 兜底只对 assigneeUserId 为空的待办生效，所以即便姓名存在包含关系
   * （张三 / 张三丰），多出来的那条也只影响「看不看得见」，不影响
   * 「能不能提交」—— 提交权始终按 assigneeUserId 判定。
   */
  private async collectTodos(user: AuthenticatedUser): Promise<InboxTodo[]> {
    const ownName = user.name?.trim();

    const ownership: Prisma.TodoWhereInput[] = [
      { assigneeUserId: user.id },
      { meeting: { is: { leaders: { some: { userId: user.id } } } } },
    ];

    if (ownName) {
      ownership.push({ assigneeUserId: null, assignee: ownName });
    }

    /**
     * 过滤直接下推到数据库。
     *
     * 旧写法是「先捞 50 场会议、把待办全拉进内存再筛」：第 51 场会议的待办
     * 永远进不了收件箱，而且是静默丢 —— 用户只会觉得「我明明有这条待办」。
     * 下推之后只取真正跟我有关的行，代价是一个覆盖索引就够。
     */
    const rows = await this.prisma.todo.findMany({
      where: {
        status: { in: ['OPEN', 'IN_PROGRESS'] },
        meeting: { is: this.visibleMeetingWhere(user) },
        OR: ownership,
      },
      select: {
        id: true,
        content: true,
        assignee: true,
        assigneeUserId: true,
        deadline: true,
        deadlineAt: true,
        status: true,
        meeting: {
          select: {
            id: true,
            title: true,
            leaders: { where: { userId: user.id }, select: { id: true } },
          },
        },
      },
      // 有截止时间的排前面；PG 的 ASC 默认把 NULL 放最后，正是想要的
      orderBy: [{ deadlineAt: 'asc' }, { id: 'asc' }],
      // 多取一条，用来判断是否被截断
      take: INBOX_TODO_LIMIT + 1,
    });

    if (rows.length > INBOX_TODO_LIMIT) {
      this.logger.warn(
        `收件箱待办超过 ${INBOX_TODO_LIMIT} 条（用户 ${user.id}），已截断展示`,
      );
    }

    const items: InboxTodo[] = rows.slice(0, INBOX_TODO_LIMIT).map((todo) => ({
      id: todo.id,
      meetingId: todo.meeting.id,
      meetingTitle: todo.meeting.title,
      content: todo.content,
      assignee: todo.assignee,
      deadline: todo.deadline,
      deadlineAt: todo.deadlineAt?.toISOString() ?? null,
      overdue: isOverdue(todo.deadlineAt, todo.status),
      status: todo.status as 'OPEN' | 'IN_PROGRESS',
      mine:
        todo.assigneeUserId === user.id ||
        (todo.assigneeUserId === null && !!ownName && todo.assignee === ownName),
      leaderOwned: todo.meeting.leaders.length > 0,
    }));

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
   * 可认领的待办：没有结构化负责人、且还没结束。
   *
   * 认领权限按「可写会议」算，不是按「可见会议」算 —— 只读共享的人
   * 在池子里看到一条却点不动，比看不见更糟。
   */
  private async collectUnclaimed(
    user: AuthenticatedUser,
  ): Promise<InboxUnclaimed[]> {
    const rows = await this.prisma.todo.findMany({
      where: {
        assigneeUserId: null,
        status: { in: ['OPEN', 'IN_PROGRESS'] },
        meeting: { is: this.writableMeetingWhere(user) },
      },
      select: {
        id: true,
        content: true,
        assignee: true,
        deadline: true,
        deadlineAt: true,
        status: true,
        meeting: { select: { id: true, title: true } },
      },
      // 快到期、已逾期的排前面；PG 的 ASC 默认 NULLS LAST
      orderBy: [{ deadlineAt: 'asc' }, { id: 'asc' }],
      take: UNCLAIMED_LIMIT,
    });

    return rows.map((todo) => ({
      id: todo.id,
      meetingId: todo.meeting.id,
      meetingTitle: todo.meeting.title,
      content: todo.content,
      assigneeHint: todo.assignee,
      deadline: todo.deadline,
      deadlineAt: todo.deadlineAt?.toISOString() ?? null,
      overdue: isOverdue(todo.deadlineAt, todo.status),
    }));
  }

  /**
   * 可写会议范围：能改这场会待办的会议。
   *
   * 与 visibleMeetingWhere 的差别只有一个：共享要 EDIT 权限。
   */
  private writableMeetingWhere(
    user: AuthenticatedUser,
  ): Prisma.MeetingWhereInput {
    if (hasTenantWideMeetingAccess(user)) {
      return {};
    }

    return {
      OR: [
        { ownerId: user.id },
        { leaders: { some: { userId: user.id } } },
        { members: { some: { userId: user.id } } },
        { shares: { some: { userId: user.id, permission: 'EDIT' } } },
      ],
    };
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
        note: true,
        _count: { select: { attachments: true } },
        submitter: { select: { name: true } },
        todo: {
          select: {
            id: true,
            content: true,
            assignee: true,
            deadlineAt: true,
            status: true,
            checkItems: { select: { done: true } },
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
        submitterId: row.submitterId,
        submitterName: row.submitter.name,
        attemptNo: row.attemptNo,
        submittedAt: row.createdAt.toISOString(),
        rejectReason: row.rejectReason,
        deadlineAt: row.todo.deadlineAt?.toISOString() ?? null,
        overdue: isOverdue(row.todo.deadlineAt, row.todo.status),
        note: row.note,
        attachmentCount: row._count.attachments,
        checklistTotal: row.todo.checkItems.length,
        checklistDone: row.todo.checkItems.filter((entry) => entry.done).length,
        reviewerId: row.reviewerId,
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
    if (hasTenantWideMeetingAccess(user)) {
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
