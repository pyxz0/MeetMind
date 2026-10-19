import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.decorators';
import { hasGlobalMeetingAccess } from '../meetings/meetings.access';

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
  status: 'OPEN' | 'IN_PROGRESS';
  /** 待办负责人文本里包含我的名字 */
  mine: boolean;
  /** 所在会议由我负责 */
  leaderOwned: boolean;
}

@Injectable()
export class InboxService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 收件箱数据。
   *
   * 通知直接从「负责人 / 成员 / 共享」三类关系派生，
   * 不额外建通知表 —— 关系本身就是事实，避免双写不一致。
   */
  async getInbox(user: AuthenticatedUser) {
    /**
     * 先补齐「到期提醒」——它需要落库以获得真实发送时间，
     * 因此必须在查询消息列表之前执行。
     */
    await this.syncDueReminders(user);

    const [
      leaders,
      members,
      shares,
      todoItems,
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

    const unreadCount = notifications.filter((n) => !n.read).length;

    return {
      notifications,
      todos: todoItems,
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
          status: todo.status as 'OPEN' | 'IN_PROGRESS',
          mine,
          leaderOwned,
        });
      }
    }

    // 指派给我的排前面
    return items.sort((a, b) => Number(b.mine) - Number(a.mine));
  }
  /**
   * 到期提醒：落库一条 message，记录真实发送时间。
   *
   * 之前是实时推算的（createdAt 取「开会前 20 分钟」），
   * 显示的并不是用户真正收到消息的时刻，看起来像假时间。
   * 现在改为到期时写入 meeting_notices（kind = 'reminder'），
   * 时间戳即落库时刻；部分唯一索引保证同一会议对同一人只发一条。
   */
  private async syncDueReminders(user: AuthenticatedUser) {
    const WINDOW_BEFORE_MS = 20 * 60 * 1000;
    const GRACE_AFTER_MS = 60 * 60 * 1000;
    const now = Date.now();

    const meetings = await this.prisma.meeting.findMany({
      where: {
        scheduledAt: {
          not: null,
          // 开会前 20 分钟已到（含开会后 1 小时宽限）
          gte: new Date(now - GRACE_AFTER_MS),
          lte: new Date(now + WINDOW_BEFORE_MS),
        },
        OR: [
          { leaders: { some: { userId: user.id } } },
          { members: { some: { userId: user.id } } },
        ],
        // 已经发过提醒的会议不再重复发
        notices: { none: { userId: user.id, kind: 'reminder' } },
      },
      select: { id: true, title: true, scheduledAt: true },
      take: 20,
    });

    if (!meetings.length) {
      return;
    }

    await this.prisma.meetingNotice.createMany({
      data: meetings.map((meeting) => {
        const scheduledAt = meeting.scheduledAt as Date;
        const pad = (n: number) => String(n).padStart(2, '0');
        const when = `${pad(scheduledAt.getMonth() + 1)}/${pad(
          scheduledAt.getDate(),
        )} ${pad(scheduledAt.getHours())}:${pad(scheduledAt.getMinutes())}`;

        return {
          userId: user.id,
          meetingId: meeting.id,
          kind: 'reminder',
          content: `会议「${meeting.title}」将于 ${when} 开始，请准时参加`,
        };
      }),
      // 并发下可能撞唯一索引，忽略即可
      skipDuplicates: true,
    });
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
