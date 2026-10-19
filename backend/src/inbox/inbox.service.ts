import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.decorators';
import { hasGlobalMeetingAccess } from '../meetings/meetings.access';

/** 通知类型：被加为负责人 / 被加为成员 / 被共享 */
export type InboxNotificationType = 'leader' | 'member' | 'share';

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
    const [leaders, members, shares, todoItems, seenAt] = await Promise.all([
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
    ]);

    const seenAtDate = seenAt?.inboxSeenAt ?? null;

    const isRead = (createdAt: Date) =>
      !!seenAtDate && createdAt.getTime() <= seenAtDate.getTime();

    const notifications: InboxNotification[] = [
      ...leaders.map((row, index) => ({
        key: `leader-${row.meeting.id}-${index}`,
        type: 'leader' as const,
        meetingId: row.meeting.id,
        meetingTitle: row.meeting.title,
        actorName: null,
        permission: null,
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
        createdAt: row.createdAt.toISOString(),
        read: isRead(row.createdAt),
      })),
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const unreadCount = notifications.filter((n) => !n.read).length;

    return {
      notifications,
      todos: todoItems,
      unreadCount,
      seenAt: seenAtDate?.toISOString() ?? null,
    };
  }

  /** 标记通知全部已读 */
  async markAllRead(user: AuthenticatedUser) {
    const now = new Date();

    await this.prisma.user.update({
      where: { id: user.id },
      data: { inboxSeenAt: now },
    });

    return { seenAt: now.toISOString(), unreadCount: 0 };
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
