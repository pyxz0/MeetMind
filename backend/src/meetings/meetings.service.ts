import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import {
  Meeting,
  Prisma,
  TodoStatus,
  MeetingCompletionStatus,
} from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { isOverdue, parseDeadlineAt } from './deadline';
import { mapMeetingSummary } from './meeting.mapper';
import { buildMeetingMarkdown, markdownFilename } from './meeting-markdown';
import { MeetingAudioService } from './meeting-audio.service';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth.decorators';
import { PERMISSIONS, roleHasPermission } from '../auth/permissions';
import {
  assertCanEditTodos,
  assertCanManageMembers,
  assertCanOwn,
  assertCanRead,
  assertCanToggleAudio,
  assertCanWrite,
  computeMeetingCapabilities,
  hasGlobalMeetingAccess,
  type MeetingAccess,
  type MeetingCapabilities,
} from './meetings.access';

/** 是否具备「编辑任意会议」的全局权限 */
const roleHasUpdateAll = (role: AuthenticatedUser['role']) =>
  roleHasPermission(role, PERMISSIONS.MEETING_UPDATE_ALL);

/** 前端保存纪要时允许提交的字段；标题、决策和待办均可省略。 */
export interface CreateMeetingInput {
  title?: string;
  content: string;
  summary?: string | null;
  decisions?: string[];
  todos?: Array<{
    content: string;
    assignee?: string | null;
    /** 结构化负责人；AI 只给姓名，落库前按「唯一同名」解析 */
    assigneeUserId?: number | null;
    reviewerId?: number | null;
    deadline?: string | null;
    /** ISO 日期；解析不了的自然语言只保留 deadline 文本 */
    deadlineAt?: string | null;
  }>;
}

/** 截止日期解析放在 deadline.ts（纯函数、可单测），这里只负责调用 */

/**
 * 把「姓名文本」解析成唯一用户 ID。
 *
 * 只认唯一同名：重名一律返回 null，交人工指定 —— 现在的 includes 匹配
 * 会把「张三丰」认成「张三」，这是要修掉的核心问题，不能用同样的猜法替代。
 */
async function resolveUniqueUserIds(
  prisma: PrismaService,
  names: string[],
): Promise<Map<string, number>> {
  const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))];

  if (!unique.length) return new Map();

  const users = await prisma.user.findMany({
    where: { name: { in: unique }, isActive: true },
    select: { id: true, name: true },
  });

  const counts = new Map<string, number>();

  for (const user of users) {
    counts.set(user.name, (counts.get(user.name) ?? 0) + 1);
  }

  const result = new Map<string, number>();

  for (const user of users) {
    if (counts.get(user.name) === 1) {
      result.set(user.name, user.id);
    }
  }

  return result;
}

// 所有读取接口都按录入顺序返回决策和待办，避免数据库默认顺序不确定。
const meetingInclude = {
  decisions: { orderBy: { sortOrder: 'asc' as const } },
  todos: {
    orderBy: { sortOrder: 'asc' as const },
    include: {
      assigneeUser: { select: { id: true, name: true } },
      reviewer: { select: { id: true, name: true } },
      // 验收要点：勾选进度随待办一起返回，详情页不用再发一次请求
      checkItems: {
        orderBy: { sortOrder: 'asc' as const },
        select: {
          id: true,
          content: true,
          done: true,
          doneById: true,
          doneAt: true,
          doneBy: { select: { id: true, name: true } },
        },
      },
      /**
       * 只带最近一次提交。
       * 详情页只需要展示「待验收 / 被打回」，完整时间线走独立接口，
       * 否则每场会议的待办都会把全部历史提交查出来。
       */
      submissions: {
        orderBy: { createdAt: 'desc' as const },
        take: 1,
        select: {
          id: true,
          status: true,
          note: true,
          attemptNo: true,
          submitterId: true,
          reviewerId: true,
          rejectReason: true,
          reviewedAt: true,
          createdAt: true,
          submitter: { select: { id: true, name: true } },
          _count: { select: { attachments: true } },
        },
      },
    },
  },
  // 负责人（可多位）与成员随会议一起返回
  leaders: {
    select: { user: { select: { id: true, name: true, phone: true } } },
    orderBy: { createdAt: 'asc' as const },
  },
  members: {
    select: { user: { select: { id: true, name: true, phone: true } } },
    orderBy: { createdAt: 'asc' as const },
  },
};

/**
 * 生成「只包含当前用户本人共享记录」的 include。
 *
 * 不能统一 include 全部 shares：那会把别人的授权也查出来，
 * 既浪费又容易误判当前用户的权限级别。
 */
const meetingIncludeFor = (userId: number) => ({
  ...meetingInclude,
  shares: {
    where: { userId },
    select: { permission: true },
  },
});

/** 负责人/成员统一取这三个字段 */
const USER_BRIEF_SELECT = { id: true, name: true, phone: true } as const;

/** 列表查询参数 */
export interface MeetingListQuery {
  page?: number;
  pageSize?: number;
  keyword?: string;
  status?: string;
  /** 起始日期 YYYY-MM-DD（按创建时间） */
  from?: string;
  /** 结束日期 YYYY-MM-DD（含当天） */
  to?: string;
  /** 只看置顶 */
  pinned?: boolean;
  /** 只看未开始的预约会议 */
  upcoming?: boolean;
  /** 创建时间排序方向 */
  sort?: 'newest' | 'oldest';
}

@Injectable()
export class MeetingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audioService: MeetingAudioService,
    private readonly audit: AuditService,
  ) { }

  /** 创建会议并通过嵌套写入原文、摘要、决策和待办，保证一次提交完成。 */
  async create(input: CreateMeetingInput, user: AuthenticatedUser) {
    const todos = input.todos ?? [];

    /**
     * AI 只给「负责人姓名」，这里按唯一同名解析成 userId。
     * 重名不猜，留空由人工指定 —— 猜错比留空更难发现。
     */
    const nameToId = await resolveUniqueUserIds(
      this.prisma,
      todos.map((todo) => todo.assignee ?? ''),
    );

    const meeting = await this.prisma.meeting.create({
      data: {
        title: input.title?.trim() || '未命名会议',
        content: input.content,
        summary: input.summary ?? null,
        status: 'READY',
        // 归属者为当前登录用户，是数据隔离的依据
        ownerId: user.id,
        // 「每场会议至少一位负责人」：创建者默认成为首位负责人，后续可追加
        leaders: { create: [{ userId: user.id }] },
        audioOpen: true,
        decisions: {
          create: (input.decisions ?? []).map((content, sortOrder) => ({
            content,
            sortOrder,
          })),
        },
        todos: {
          create: todos.map((todo, sortOrder) => ({
            content: todo.content,
            assignee: todo.assignee ?? null,
            assigneeUserId:
              todo.assigneeUserId ??
              (todo.assignee ? nameToId.get(todo.assignee.trim()) ?? null : null),
            reviewerId: todo.reviewerId ?? null,
            deadline: todo.deadline ?? null,
            deadlineAt: todo.deadlineAt
              ? parseDeadlineAt(todo.deadlineAt)
              : parseDeadlineAt(todo.deadline),
            sortOrder,
          })),
        },
      },
      include: meetingInclude,
    });

    /**
     * 嵌套写入不经过 syncMeetingCompletionStatus，
     * 所以要在这里按刚写入的待办补一次状态推算，
     * 否则“带着待办一起创建的会议”会一直停在 NOT_STARTED。
     */
    const completionStatus = this.resolveCompletionStatus(
      meeting.completionStatus,
      meeting.todos.map((todo) => todo.status),
    );

    const finalMeeting =
      completionStatus === meeting.completionStatus
        ? meeting
        : await this.prisma.meeting.update({
          where: { id: meeting.id },
          data: { completionStatus },
          include: meetingInclude,
        });

    /**
     * 统一走 toApiRecord：创建响应也要带能力位与负责人/成员字段，
     * 否则前端拿到的是缺字段的裸记录，与其它接口不一致。
     */
    return this.toApiRecord(
      finalMeeting,
      'owner',
      user,
      computeMeetingCapabilities({
        user,
        access: 'owner',
        audioOpen: finalMeeting.audioOpen,
      }),
    );
  }

  /**
   * 创建正式会议（预约会议）。
   *
   * 与临时会议的区别：有 scheduledAt，开会时间前 20 分钟内
   * 参会人员会在收件箱收到提醒。
   * 会议原文此时为空，开会后再补充或直接生成纪要。
   */
  async createScheduled(
    input: {
      title?: string;
      scheduledAt: string;
      leaderIds?: number[];
      memberIds?: number[];
    },
    user: AuthenticatedUser,
  ) {
    const when = new Date(input.scheduledAt);

    if (Number.isNaN(when.getTime())) {
      throw new BadRequestException('开会时间格式不正确');
    }

    // 允许 1 分钟误差，避免刚选完时间点提交就被判过期
    if (when.getTime() < Date.now() - 60_000) {
      throw new BadRequestException('开会时间不能早于当前时间');
    }

    const leaderIds = this.normalizeIds(input.leaderIds);
    const memberIds = this.normalizeIds(input.memberIds);

    // 没有指定负责人时由创建者担任，保证「至少一位负责人」
    const finalLeaderIds = leaderIds.length ? leaderIds : [user.id];

    await this.assertUsersUsable([...finalLeaderIds, ...memberIds]);

    const meeting = await this.prisma.meeting.create({
      data: {
        title: input.title?.trim() || '未命名会议',
        content: '',
        summary: null,
        status: 'READY',
        ownerId: user.id,
        scheduledAt: when,
        leaders: { create: finalLeaderIds.map((userId) => ({ userId })) },
        members: { create: memberIds.map((userId) => ({ userId })) },
      },
      include: meetingInclude,
    });

    return this.toApiRecord(
      meeting,
      'owner',
      user,
      computeMeetingCapabilities({
        user,
        access: 'owner',
        audioOpen: meeting.audioOpen,
      }),
    );
  }

  /**
   * 修改未开始会议的预约信息（标题、开会时间、负责人、成员）。
   *
   * 允许改全部内容的前提是「会议还没开始」：
   * 一旦到了开会时间，人员与时间再变会误导参会者，因此禁止。
   *
   * 修改成功后给「受影响的人 + 当前全部参会人员」发变更消息，
   * 被移出会议的人也会收到一条单独的告知。
   */
  async updateScheduled(
    id: number,
    input: {
      title?: string;
      scheduledAt?: string;
      leaderIds?: number[];
      memberIds?: number[];
    },
    user: AuthenticatedUser,
  ) {
    await assertCanWrite(this.prisma, user, id);

    const current = await this.prisma.meeting.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        scheduledAt: true,
        leaders: { select: { userId: true } },
        members: { select: { userId: true } },
      },
    });

    if (!current) {
      throw new NotFoundException('会议记录不存在');
    }

    if (!current.scheduledAt) {
      throw new BadRequestException('只有预约的正式会议可以修改预约信息');
    }

    if (current.scheduledAt.getTime() <= Date.now()) {
      throw new BadRequestException('会议已开始，不能再修改预约信息');
    }

    const data: Prisma.MeetingUpdateInput = {};

    if (input.title !== undefined) {
      const title = input.title.trim();

      if (!title) {
        throw new BadRequestException('会议标题不能为空');
      }

      if (title.length > 200) {
        throw new BadRequestException('会议标题不能超过200个字符');
      }

      data.title = title;
    }

    if (input.scheduledAt !== undefined) {
      const when = new Date(input.scheduledAt);

      if (Number.isNaN(when.getTime())) {
        throw new BadRequestException('开会时间格式不正确');
      }

      if (when.getTime() < Date.now() - 60_000) {
        throw new BadRequestException('开会时间不能早于当前时间');
      }

      data.scheduledAt = when;
    }

    const nextLeaderIds =
      input.leaderIds !== undefined
        ? this.normalizeIds(input.leaderIds)
        : current.leaders.map((l) => l.userId);

    const nextMemberIds =
      input.memberIds !== undefined
        ? this.normalizeIds(input.memberIds)
        : current.members.map((m) => m.userId);

    // 每场会议至少要有一位负责人
    if (!nextLeaderIds.length) {
      throw new BadRequestException('至少需要一位负责人');
    }

    await this.assertUsersUsable([...nextLeaderIds, ...nextMemberIds]);

    // ---- 变更摘要，用于消息正文 ----
    const changes: string[] = [];

    if (data.title && data.title !== current.title) {
      changes.push(`名称改为「${data.title as string}」`);
    }

    if (data.scheduledAt) {
      const when = data.scheduledAt as Date;

      if (when.getTime() !== current.scheduledAt.getTime()) {
        changes.push(`开会时间改为 ${this.formatDateTime(when)}`);
      }
    }

    const beforeLeaderIds = current.leaders.map((l) => l.userId);
    const beforeMemberIds = current.members.map((m) => m.userId);

    const leadersChanged = !this.sameIdSet(beforeLeaderIds, nextLeaderIds);
    const membersChanged = !this.sameIdSet(beforeMemberIds, nextMemberIds);

    if (leadersChanged || membersChanged) {
      const names = await this.userNames([
        ...nextLeaderIds,
        ...nextMemberIds,
      ]);

      if (leadersChanged) {
        changes.push(
          `负责人：${nextLeaderIds.map((x) => names.get(x) ?? `#${x}`).join('、')}`,
        );
      }

      if (membersChanged) {
        const memberText = nextMemberIds.length
          ? nextMemberIds.map((x) => names.get(x) ?? `#${x}`).join('、')
          : '暂无';

        changes.push(`参会成员：${memberText}`);
      }
    }

    if (!changes.length) {
      throw new BadRequestException('没有需要修改的内容');
    }

    // ---- 保存 ----
    await this.prisma.$transaction(async (tx) => {
      await tx.meeting.update({ where: { id }, data });

      if (input.leaderIds !== undefined) {
        await tx.meetingLeader.deleteMany({ where: { meetingId: id } });
        await tx.meetingLeader.createMany({
          data: nextLeaderIds.map((userId) => ({ meetingId: id, userId })),
          skipDuplicates: true,
        });
      }

      if (input.memberIds !== undefined) {
        await tx.meetingMember.deleteMany({ where: { meetingId: id } });
        await tx.meetingMember.createMany({
          data: nextMemberIds.map((userId) => ({ meetingId: id, userId })),
          skipDuplicates: true,
        });
      }
    });

    // ---- 发消息 ----
    const finalTitle =
      (data.title as string | undefined) ?? current.title;

    const recipients = new Set<number>([
      ...beforeLeaderIds,
      ...beforeMemberIds,
      ...nextLeaderIds,
      ...nextMemberIds,
    ]);

    // 自己改的自己不用再收一次消息
    recipients.delete(user.id);

    const stillParticipating = new Set<number>([
      ...nextLeaderIds,
      ...nextMemberIds,
    ]);

    const summary = changes.join('；');

    await this.prisma.meetingNotice.createMany({
      data: [...recipients].map((userId) => ({
        userId,
        meetingId: id,
        content: stillParticipating.has(userId)
          ? `会议「${finalTitle}」信息已更新：${summary}`
          : `你已被移出会议「${finalTitle}」`,
      })),
    });

    return this.findOne(id, user);
  }

  /** 两组 id 是否完全一致（顺序无关） */
  private sameIdSet(a: number[], b: number[]) {
    const sa = [...new Set(a)].sort((x, y) => x - y);
    const sb = [...new Set(b)].sort((x, y) => x - y);

    return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
  }

  /** 批量取用户姓名，供消息正文使用 */
  private async userNames(ids: number[]) {
    if (!ids.length) return new Map<number, string>();

    const users = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, name: true },
    });

    return new Map(users.map((u) => [u.id, u.name]));
  }

  /** 消息里用的时间格式：10/21 09:00 */
  private formatDateTime(date: Date) {
    const pad = (n: number) => String(n).padStart(2, '0');

    return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(
      date.getHours(),
    )}:${pad(date.getMinutes())}`;
  }

  /** 去重并过滤非法 id */
  private normalizeIds(ids?: number[]) {
    if (!Array.isArray(ids)) return [];

    return [...new Set(ids)].filter(
      (id) => typeof id === 'number' && Number.isInteger(id) && id > 0,
    );
  }

  /** 校验账号存在且未停用，避免把停用账号设为负责人/成员 */
  private async assertUsersUsable(ids: number[]) {
    if (!ids.length) return;

    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, isActive: true },
    });

    if (users.length !== ids.length) {
      throw new NotFoundException('指定的参会人员中有账号不存在');
    }

    if (users.some((u) => !u.isActive)) {
      throw new BadRequestException('指定的参会人员中有账号已被停用');
    }
  }

  /** 手动将会议内容保存到草稿箱 */  async createDraft(
    input: { title?: string; content: string },
    user: AuthenticatedUser,
  ) {
    if (!input.content?.trim()) {
      throw new BadRequestException('会议内容不能为空');
    }

    const draft = await this.prisma.meeting.create({
      data: {
        title: input.title?.trim() || '会议草稿',
        content: input.content.trim(),
        summary: null,
        status: 'DRAFT',
        completionStatus: 'NOT_STARTED',
        // 草稿同样有归属者，否则草稿箱会跨用户可见
        ownerId: user.id,
        // 草稿也要满足「至少一位负责人」
        leaders: { create: [{ userId: user.id }] },
      },
      include: meetingInclude,
    });

    return this.toApiRecord(
      draft,
      'owner',
      user,
      computeMeetingCapabilities({
        user,
        access: 'owner',
        audioOpen: draft.audioOpen,
      }),
    );
  }

  /** 手动修改会议完成状态 */
  async updateMeetingCompletionStatus(
    id: number,
    completionStatus: MeetingCompletionStatus,
    user: AuthenticatedUser,
  ) {
    const allowedStatuses: MeetingCompletionStatus[] = [
      'NOT_STARTED',
      'IN_PROGRESS',
      'COMPLETED',
      'CANCELLED',
    ];

    if (!allowedStatuses.includes(completionStatus)) {
      throw new BadRequestException('无效的会议完成状态');
    }

    await assertCanWrite(this.prisma, user, id);

    const current = await this.prisma.meeting.findUnique({
      where: { id },
      select: { completionStatus: true },
    })

    if (!current) {
      throw new NotFoundException('会议记录不存在')
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.meeting.update({
        where: { id },
        data: {
          completionStatus,
        },
        select: {
          id: true,
          title: true,
          completionStatus: true,
        },
      })

      /**
       * 状态真的变了才留痕：重复点同一个状态不该在记录里堆噪声。
       * 这条记录是「谁手动改的」，自动流转由 todo_events 说明来源。
       */
      if (current.completionStatus !== completionStatus) {
        await tx.meetingEvent.create({
          data: {
            meetingId: id,
            actorId: user.id,
            type: 'status_changed',
            fromStatus: current.completionStatus,
            toStatus: completionStatus,
          },
        })
      }

      return updated
    })
  }

  /** 会议状态变更记录：谁、何时、从什么状态改成了什么 */
  async listMeetingEvents(meetingId: number, user: AuthenticatedUser) {
    await assertCanRead(this.prisma, user, meetingId)

    const rows = await this.prisma.meetingEvent.findMany({
      where: { meetingId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        type: true,
        fromStatus: true,
        toStatus: true,
        createdAt: true,
        actor: { select: { id: true, name: true } },
      },
    })

    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      fromStatus: row.fromStatus,
      toStatus: row.toStatus,
      createdAt: row.createdAt.toISOString(),
      actor: row.actor,
    }))
  }

  /** 修改会议标题 */
  async updateMeeting(
    id: number,
    data: {
      title: string;
    },
    user: AuthenticatedUser,
  ) {
    await assertCanWrite(this.prisma, user, id);

    const title = data.title?.trim();

    if (!title) {
      throw new BadRequestException('会议标题不能为空');
    }

    if (title.length > 200) {
      throw new BadRequestException('会议标题不能超过200个字符');
    }

    return this.prisma.meeting.update({
      where: { id },
      data: { title }
    });
  }

  /**
   * 置顶 / 取消置顶会议。
   *
   * pinned 为 true 时记录置顶时间（多条置顶按“最近置顶优先”排序），
   * 为 false 时清空该时间。
   */
  async updatePinned(id: number, pinned: boolean, user: AuthenticatedUser) {
    await assertCanWrite(this.prisma, user, id);

    const meeting = await this.prisma.meeting.findUnique({
      where: { id },
      select: { id: true, pinnedAt: true },
    });

    if (!meeting) {
      throw new NotFoundException('会议记录不存在');
    }

    // 已经是目标状态时不刷新置顶时间，避免重复点击把顺序打乱。
    if (pinned && meeting.pinnedAt) {
      return {
        id: meeting.id,
        pinnedAt: meeting.pinnedAt.toISOString(),
      };
    }

    if (!pinned && !meeting.pinnedAt) {
      return {
        id: meeting.id,
        pinnedAt: null,
      };
    }

    const updated = await this.prisma.meeting.update({
      where: { id },
      data: {
        pinnedAt: pinned ? new Date() : null,
      },
      select: {
        id: true,
        pinnedAt: true,
      },
    });

    return {
      id: updated.id,
      pinnedAt: updated.pinnedAt?.toISOString() ?? null,
    };
  }

  /** 编辑待办事项 */
  async updateTodo(
    id: number,
    data: {
      content?: string
      assignee?: string
      assigneeUserId?: number | null
      reviewerId?: number | null
      deadline?: string
      deadlineAt?: string | null
    },
    user: AuthenticatedUser,
  ) {
    const todo = await this.prisma.todo.findUnique({
      where: { id }
    })

    if (!todo) {
      throw new NotFoundException('待办事项不存在')
    }

    // 待办本身没有归属字段，权限跟着所属会议走
    await assertCanWrite(this.prisma, user, todo.meetingId);

    // 负责人的文本与 ID 必须同时变，否则会出现「显示张三、实际指派给李四」
    let assignee: string | null | undefined = data.assignee
    let assigneeUserId = todo.assigneeUserId

    if (data.assigneeUserId !== undefined) {
      assigneeUserId = data.assigneeUserId

      if (data.assigneeUserId === null) {
        assignee = null
      } else {
        const target = await this.prisma.user.findUnique({
          where: { id: data.assigneeUserId },
          select: { name: true, isActive: true },
        })

        if (!target) throw new NotFoundException('指定的负责人不存在')
        if (!target.isActive) throw new BadRequestException('该账号已停用，不能担任负责人')

        assignee = target.name
      }
    }

    // 截止时间：优先用显式 deadlineAt，否则尝试从文本解析
    let deadlineAt = todo.deadlineAt
    if (data.deadlineAt !== undefined) {
      deadlineAt = data.deadlineAt === null ? null : parseDeadlineAt(data.deadlineAt)
    } else if (data.deadline !== undefined) {
      deadlineAt = parseDeadlineAt(data.deadline)
    }

    // 未指定验收人（传了 null）时，默认会议负责人（多个时默认创建者）
    let resolvedReviewerId: number | null | undefined
    if (data.reviewerId !== undefined) {
      resolvedReviewerId = data.reviewerId ?? (await this.resolveDefaultReviewerId(todo.meetingId))

      if (resolvedReviewerId) {
        const reviewer = await this.prisma.user.findUnique({
          where: { id: resolvedReviewerId },
          select: { isActive: true },
        })

        if (!reviewer) throw new NotFoundException('指定的验收人不存在')
        if (!reviewer.isActive) throw new BadRequestException('该账号已停用，不能担任验收人')
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.todo.update({
        where: { id },
        data: {
          ...(data.content !== undefined && {
            content: data.content
          }),
          ...(assignee !== undefined && {
            assignee
          }),
          ...(data.assigneeUserId !== undefined && {
            assigneeUserId
          }),
          ...(resolvedReviewerId !== undefined && {
            reviewerId: resolvedReviewerId
          }),
          ...(data.deadline !== undefined && {
            deadline: data.deadline
          }),
          ...(data.deadlineAt !== undefined || data.deadline !== undefined
            ? { deadlineAt }
            : {}),
        }
      })

      // 换了负责人或验收人，都要保证对方能打开这场会议，否则只会拿到 404
      const memberIds = [updated.assigneeUserId, updated.reviewerId].filter(
        (userId): userId is number => !!userId,
      )

      for (const userId of [...new Set(memberIds)]) {
        await tx.meetingMember.upsert({
          where: {
            meetingId_userId: {
              meetingId: todo.meetingId,
              userId,
            },
          },
          create: {
            meetingId: todo.meetingId,
            userId,
          },
          update: {},
        })
      }

      await tx.todoEvent.create({
        data: {
          todoId: id,
          actorId: user.id,
          type:
            data.assigneeUserId !== undefined || data.reviewerId !== undefined
              ? 'assigned'
              : data.deadline !== undefined || data.deadlineAt !== undefined
                ? 'deadline_changed'
                : 'updated',
          fromStatus: todo.status,
          toStatus: updated.status,
          metadata: {
            before: {
              assignee: todo.assignee,
              assigneeUserId: todo.assigneeUserId,
              reviewerId: todo.reviewerId,
              deadline: todo.deadline,
            },
            after: {
              assignee: updated.assignee,
              assigneeUserId: updated.assigneeUserId,
              reviewerId: updated.reviewerId,
              deadline: updated.deadline,
            },
          } as Prisma.InputJsonValue,
        },
      })

      return updated
    })
  }

  /** 获取正式会议和草稿箱统计 */
  async getStats(user: AuthenticatedUser) {
    // 统计同样受数据隔离约束：只看自己可见范围内的数据
    const visible = this.visibleMeetingWhere(user);

    /**
     * 正式会议（历史口径）：排除手动草稿与 AI 失败，且排除「尚未开始的预约会议」。
     * 预约时间已过或未设预约时间的会议才算入历史。
     */
    const formalMeeting: Prisma.MeetingWhereInput = {
      AND: [
        visible,
        { status: { notIn: ['DRAFT', 'FAILED'] } },
        {
          OR: [{ scheduledAt: null }, { scheduledAt: { lte: new Date() } }],
        },
      ],
    };

    /** 尚未开始的预约会议：单独作为「未开始」分段统计，不计入历史会议总数 */
    const upcomingMeeting: Prisma.MeetingWhereInput = {
      AND: [
        visible,
        { status: { notIn: ['DRAFT', 'FAILED'] } },
        { scheduledAt: { gt: new Date() } },
      ],
    };

    const draftMeeting: Prisma.MeetingWhereInput = {
      AND: [visible, { status: { in: ['DRAFT', 'FAILED'] } }],
    };

    // 待办/决策没有归属字段，通过所属会议间接过滤
    const visibleTodo: Prisma.TodoWhereInput = {
      meeting: { is: visible },
    };

    const visibleDecision: Prisma.DecisionWhereInput = {
      meeting: { is: visible },
    };

    const [
      totalMeetings,
      draftMeetings,
      notStartedMeetings,
      inProgressMeetings,
      completedMeetings,
      cancelledMeetings,
      totalTodos,
      completedTodos,
      pendingReviewTodos,
      overdueTodos,
      reworkCount,
      acceptedSamples,
      totalDecisions,
    ] = await Promise.all([
      // 会议总数（历史口径）：排除草稿、AI 失败与尚未开始的预约会议
      this.prisma.meeting.count({ where: formalMeeting }),

      // 草稿箱数量：手动草稿 + AI 生成失败
      this.prisma.meeting.count({ where: draftMeeting }),

      // 未开始：只统计尚未开始的预约会议（历史口径里不该有未开始）
      this.prisma.meeting.count({
        where: { AND: [upcomingMeeting, { completionStatus: 'NOT_STARTED' }] },
      }),

      // 进行中：IN_PROGRESS，或「预约已过但仍停在 NOT_STARTED」的遗留会议
      this.prisma.meeting.count({
        where: {
          AND: [
            formalMeeting,
            {
              OR: [
                { completionStatus: 'IN_PROGRESS' },
                {
                  completionStatus: 'NOT_STARTED',
                  scheduledAt: { lte: new Date() },
                },
              ],
            },
          ],
        },
      }),

      this.prisma.meeting.count({
        where: { AND: [formalMeeting, { completionStatus: 'COMPLETED' }] },
      }),

      this.prisma.meeting.count({
        where: { AND: [formalMeeting, { completionStatus: 'CANCELLED' }] },
      }),

      this.prisma.todo.count({ where: visibleTodo }),

      this.prisma.todo.count({
        where: { AND: [visibleTodo, { status: 'COMPLETED' }] },
      }),

      // 待验收：不计入完成率，但要在看板上单独露出，否则「完成率」会被误读
      this.prisma.todo.count({
        where: { AND: [visibleTodo, { status: 'SUBMITTED' }] },
      }),

      // 逾期：过了截止时间且仍未完成（含待验收，提交了但没验收也算没交付完）
      this.prisma.todo.count({
        where: {
          AND: [
            visibleTodo,
            { deadlineAt: { not: null, lt: new Date() } },
            { status: { notIn: ['COMPLETED', 'CANCELLED'] } },
          ],
        },
      }),

      // 返工次数：被打回的提交数
      this.prisma.todoSubmission.count({
        where: { status: 'REJECTED', todo: { meeting: visible } },
      }),

      // 平均验收时长：只取最近 500 条，避免统计把整张表拖进来
      this.prisma.todoSubmission.findMany({
        where: {
          status: 'ACCEPTED',
          reviewedAt: { not: null },
          todo: { meeting: visible },
        },
        select: { createdAt: true, reviewedAt: true },
        orderBy: { reviewedAt: 'desc' },
        take: 500,
      }),

      this.prisma.decision.count({ where: visibleDecision }),
    ])

    const reviewHours = acceptedSamples
      .map((row) => {
        if (!row.reviewedAt) return null

        const hours = (row.reviewedAt.getTime() - row.createdAt.getTime()) / 3_600_000

        return hours >= 0 ? hours : null
      })
      .filter((hours): hours is number => hours !== null)

    const avgReviewHours = reviewHours.length
      ? Math.round((reviewHours.reduce((sum, h) => sum + h, 0) / reviewHours.length) * 10) / 10
      : null

    return {
      totalMeetings,
      draftMeetings,
      notStartedMeetings,
      inProgressMeetings,
      completedMeetings,
      cancelledMeetings,
      totalTodos,
      completedTodos,
      pendingReviewTodos,
      overdueTodos,
      reworkCount,
      avgReviewHours,
      totalDecisions,
    }
  }

  /**
   * 构造「当前用户可见会议」的查询条件。
   *
   * 普通用户：自己拥有的 ∪ 自己负责的 ∪ 自己参与的 ∪ 别人共享给自己的
   * 管理员及以上：全部会议
   *
   * 所有列表查询都走这里，避免某条查询漏掉数据隔离。
   */
  private visibleMeetingWhere(user: AuthenticatedUser): Prisma.MeetingWhereInput {
    if (hasGlobalMeetingAccess(user)) {
      return {};
    }

    return {
      OR: [
        { ownerId: user.id },
        // 负责人（可多位）与成员都能在列表里看到与自己相关的会议
        { leaders: { some: { userId: user.id } } },
        { members: { some: { userId: user.id } } },
        { shares: { some: { userId: user.id } } },
      ],
    };
  }

  /**
   * 查询历史会议（分页 + 服务端筛选）。
   *
   * 默认排除未开始的预约会议 —— 它们属于"待办日程"，由首页展示；
   * 传 upcoming=true 时反过来只取未开始的会议。
   */
  async findAll(user: AuthenticatedUser, query: MeetingListQuery = {}) {
    const now = new Date();
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Math.trunc(query.pageSize ?? 20)));

    const conditions: Prisma.MeetingWhereInput[] = [
      this.visibleMeetingWhere(user),
      { status: { notIn: ['FAILED', 'DRAFT'] } },
    ];

    if (query.upcoming) {
      conditions.push({ scheduledAt: { gt: now } });
    } else {
      // 已开始的会议：没有预约时间，或预约时间已过
      conditions.push({
        OR: [{ scheduledAt: null }, { scheduledAt: { lte: now } }],
      });
    }

    if (query.pinned) {
      conditions.push({ pinnedAt: { not: null } });
    }

    /**
     * 关键词检索覆盖「标题 + 摘要 + 原文 + 决策 + 待办」。
     *
     * 列表只返回摘要字段，所以这里用 Prisma 的关系过滤（some）直接命中子表，
     * 不需要把 decisions / todos 一起读出来；命中位置由前端提示说明。
     */
    if (query.keyword?.trim()) {
      const keyword = query.keyword.trim();

      conditions.push({
        OR: [
          { title: { contains: keyword, mode: 'insensitive' } },
          { summary: { contains: keyword, mode: 'insensitive' } },
          { content: { contains: keyword, mode: 'insensitive' } },
          {
            decisions: {
              some: { content: { contains: keyword, mode: 'insensitive' } },
            },
          },
          {
            todos: {
              some: { content: { contains: keyword, mode: 'insensitive' } },
            },
          },
        ],
      });
    }

    if (query.status) {
      conditions.push({
        completionStatus: query.status as MeetingCompletionStatus,
      });
    }

    if (query.from || query.to) {
      const createdAt: Prisma.DateTimeFilter = {};

      if (query.from) createdAt.gte = new Date(`${query.from}T00:00:00`);
      if (query.to) {
        createdAt.lt = new Date(
          new Date(`${query.to}T00:00:00`).getTime() + 24 * 60 * 60 * 1000,
        );
      }

      conditions.push({ createdAt });
    }

    const where: Prisma.MeetingWhereInput = { AND: conditions };

    // 置顶永远排在最前，其余按用户选择的创建时间方向
    const createdDirection: Prisma.SortOrder =
      query.sort === 'oldest' ? 'asc' : 'desc';

    const [rows, total, pinnedTotal] = await Promise.all([
      this.prisma.meeting.findMany({
        where,
        orderBy: [
          { pinnedAt: { sort: 'desc', nulls: 'last' } },
          { createdAt: createdDirection },
        ],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          title: true,
          summary: true,
          completionStatus: true,
          status: true,
          scheduledAt: true,
          pinnedAt: true,
          createdAt: true,
          ownerId: true,
          audioOpen: true,
          leaders: { select: { user: { select: USER_BRIEF_SELECT } } },
          members: { select: { user: { select: USER_BRIEF_SELECT } } },
          shares: {
            where: { userId: user.id },
            select: { permission: true },
          },
          _count: { select: { decisions: true, todos: true } },
        },
      }),
      this.prisma.meeting.count({ where }),
      // 当前筛选下的置顶总数，供列表上方的统计文案使用
      this.prisma.meeting.count({ where: { AND: [...conditions, { pinnedAt: { not: null } }] } }),
    ]);

    return {
      items: rows.map((row) => {
        const access = this.resolveAccessFromRow(row, user);
        const capabilities = computeMeetingCapabilities({
          user,
          access,
          audioOpen: row.audioOpen,
        });

        // 历史列表不出现「未开始」：预约已过但仍停在 NOT_STARTED 的遗留会议，按进行中展示
        const completionStatus =
          row.completionStatus === 'NOT_STARTED' &&
          (row.scheduledAt === null || row.scheduledAt <= new Date())
            ? 'IN_PROGRESS'
            : row.completionStatus;

        return mapMeetingSummary(
          { ...row, completionStatus },
          access,
          capabilities,
        );
      }),
      total,
      pinnedTotal,
      page,
      pageSize,
      hasMore: page * pageSize < total,
    };
  }

  /** 从列表行推断当前用户的访问级别（与 resolveMeetingAccess 同规则） */
  private resolveAccessFromRow(
    row: {
      ownerId: number;
      leaders?: Array<{ user: { id: number } }>;
      members?: Array<{ user: { id: number } }>;
      shares?: Array<{ permission: 'READ' | 'EDIT' }>;
    },
    user: AuthenticatedUser,
  ): MeetingAccess {
    if (row.ownerId === user.id) return 'owner';
    if (row.leaders?.some((l) => l.user.id === user.id)) return 'leader';
    if (row.members?.some((m) => m.user.id === user.id)) return 'member';
    if (row.shares?.some((s) => s.permission === 'EDIT')) return 'edit';
    if (hasGlobalMeetingAccess(user)) {
      return roleHasUpdateAll(user.role) ? 'edit' : 'read';
    }

    return 'read';
  }

  /** 查询草稿箱会议；AI 生成失败的会议会保留在这里。 */
  async findDrafts(user: AuthenticatedUser) {
    const meetings = await this.prisma.meeting.findMany({
      where: {
        AND: [
          this.visibleMeetingWhere(user),
          { status: { in: ['FAILED', 'DRAFT'] } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      include: meetingIncludeFor(user.id),
    });

    return this.toApiRecordList(meetings, user);
  }

  /** 查询单条会议详情；无权访问时同样返回 404，避免探测会议是否存在。 */
  async findOne(id: number, user: AuthenticatedUser) {
    const { access, capabilities } = await assertCanRead(
      this.prisma,
      user,
      id,
    );

    const meeting = await this.prisma.meeting.findUnique({
      where: { id },
      include: meetingIncludeFor(user.id),
    });

    if (!meeting) throw new NotFoundException('会议记录不存在');

    return this.toApiRecord(meeting, access, user, capabilities);
  }

  /**
   * 导出会议纪要（Markdown）。
   *
   * 直接复用 findOne：访问权限、能力位与关联数据都在那一层校验过，
   * 这里不另写一套判断，避免出现「详情打不开、导出却拿得到」的旁路。
   */
  async exportMarkdown(id: number, user: AuthenticatedUser) {
    const meeting = await this.findOne(id, user);

    return {
      filename: markdownFilename(meeting.title, meeting.id),
      content: buildMeetingMarkdown(meeting),
    };
  }

  /**
   * 追加一位负责人。
   *
   * 负责人可以有多个；同一个人也可同时是成员。
   * 重复添加按幂等处理。
   */
  async addLeader(id: number, leaderUserId: number, user: AuthenticatedUser) {
    await assertCanManageMembers(this.prisma, user, id);

    const target = await this.prisma.user.findUnique({
      where: { id: leaderUserId },
      select: { id: true, isActive: true },
    });

    if (!target) {
      throw new NotFoundException('指定为负责人的用户不存在');
    }

    if (!target.isActive) {
      throw new BadRequestException('该账号已被停用，不能担任负责人');
    }

    await this.prisma.meetingLeader.upsert({
      where: { meetingId_userId: { meetingId: id, userId: leaderUserId } },
      create: { meetingId: id, userId: leaderUserId },
      update: {},
    });

    return this.findLeaders(id);
  }

  /**
   * 移除一位负责人。
   *
   * 每场会议至少要保留一位负责人，移除最后一位会被拒绝。
   */
  async removeLeader(
    id: number,
    leaderUserId: number,
    user: AuthenticatedUser,
  ) {
    const access = await assertCanManageMembers(this.prisma, user, id);

    const leaders = await this.prisma.meetingLeader.findMany({
      where: { meetingId: id },
      select: { userId: true },
    });

    if (!leaders.some((l) => l.userId === leaderUserId)) {
      throw new NotFoundException('该用户不是本会议的负责人');
    }

    if (leaders.length <= 1) {
      throw new BadRequestException('每场会议至少要保留一位负责人');
    }

    /**
     * 移除自己后若既非创建者也不是成员，会失去访问权，
     * 直接拒绝并提示先把自己加为成员。
     */
    if (
      leaderUserId === user.id &&
      access.access === 'leader'
    ) {
      const selfMember = await this.prisma.meetingMember.findUnique({
        where: { meetingId_userId: { meetingId: id, userId: user.id } },
        select: { id: true },
      });

      if (!selfMember) {
        throw new BadRequestException(
          '移除自己后你将失去该会议的访问权限，请先把自己加为成员',
        );
      }
    }

    await this.prisma.meetingLeader.deleteMany({
      where: { meetingId: id, userId: leaderUserId },
    });

    return this.findLeaders(id);
  }

  /** 负责人列表 */
  async listLeaders(id: number) {
    const leaders = await this.prisma.meetingLeader.findMany({
      where: { meetingId: id },
      select: { user: { select: { id: true, name: true, phone: true } } },
      orderBy: { createdAt: 'asc' },
    });

    return leaders.map((l) => l.user);
  }

  /** 带读取权限校验的负责人列表查询 */
  async findLeaders(id: number) {
    return this.listLeaders(id);
  }

  /**
   * 删除会议；外键会级联清理决策、待办、成员与共享记录。
   *
   * 只有归属者或具备全局删除权限的管理员可删除，
   * 「被共享者」与成员不能删别人的会议。
   */
  async remove(id: number, user: AuthenticatedUser) {
    await assertCanOwn(this.prisma, user, id);

    // 录音是磁盘文件，不参与外键级联，必须在删除记录前单独清理。
    await this.audioService.removeAudioByMeetingId(id);

    // 交付物附件同理：删除记录后文件会变成孤儿
    await this.removeTodoAttachmentFiles(id);

    await this.prisma.meeting.delete({ where: { id } });

    await this.audit.record(user, {
      action: 'meeting.delete',
      resourceType: 'meeting',
      resourceId: id,
    });
  }

  /**
   * 添加会议成员。
   *
   * 负责人与创建者也可以被加为成员（需求明确允许），
   * 不做互斥校验；重复添加按幂等处理。
   */
  async addMember(
    id: number,
    memberUserId: number,
    user: AuthenticatedUser,
  ) {
    await assertCanManageMembers(this.prisma, user, id);

    const target = await this.prisma.user.findUnique({
      where: { id: memberUserId },
      select: { id: true, name: true, phone: true, isActive: true },
    });

    if (!target) {
      throw new NotFoundException('要添加的用户不存在');
    }

    if (!target.isActive) {
      throw new BadRequestException('该账号已被停用，不能加入会议');
    }

    await this.prisma.meetingMember.upsert({
      where: {
        meetingId_userId: { meetingId: id, userId: memberUserId },
      },
      create: { meetingId: id, userId: memberUserId },
      update: {},
    });

    return this.listMembers(id);
  }

  /** 移除会议成员。移除负责人不影响其负责人身份。 */
  async removeMember(
    id: number,
    memberUserId: number,
    user: AuthenticatedUser,
  ) {
    await assertCanManageMembers(this.prisma, user, id);

    await this.prisma.meetingMember.deleteMany({
      where: { meetingId: id, userId: memberUserId },
    });

    return this.listMembers(id);
  }

  /** 会议成员列表 */
  async listMembers(id: number) {
    const members = await this.prisma.meetingMember.findMany({
      where: { meetingId: id },
      select: { user: { select: { id: true, name: true, phone: true } } },
      orderBy: { createdAt: 'asc' },
    });

    return members.map((m) => m.user);
  }

  /** 带读取权限校验的成员列表查询（接口用） */
  async findMembers(id: number, user: AuthenticatedUser) {
    await assertCanRead(this.prisma, user, id);

    return this.listMembers(id);
  }

  /**
   * 控制会议录音是否对非负责人开放。
   *
   * 只有负责人、创建者或超级管理员可操作；
   * 关闭后成员与共享者既看不到播放器，也无法通过音频接口取流。
   */
  async updateAudioOpen(
    id: number,
    audioOpen: boolean,
    user: AuthenticatedUser,
  ) {
    await assertCanToggleAudio(this.prisma, user, id);

    if (typeof audioOpen !== 'boolean') {
      throw new BadRequestException('audioOpen 必须是布尔值');
    }

    const updated = await this.prisma.meeting.update({
      where: { id },
      data: { audioOpen },
      select: { id: true, audioOpen: true },
    });

    return updated;
  }

  /** 更新待办事项状态。 */
  async updateTodoStatus(
    id: number,
    status: TodoStatus,
    user: AuthenticatedUser,
  ) {
    const allowedStatuses: TodoStatus[] = [
      'OPEN',
      'IN_PROGRESS',
      'SUBMITTED',
      'COMPLETED',
      'CANCELLED',
    ];

    if (!allowedStatuses.includes(status)) {
      throw new BadRequestException('无效的待办状态');
    }

    const todo = await this.prisma.todo.findUnique({
      where: { id },
    });

    if (!todo) {
      throw new NotFoundException('待办事项不存在');
    }

    /**
     * 状态只能由「该事项的验收人」或「会议负责人」修改。
     *
     * 验收人是这条待办的责任判定人，改状态等于给结论；
     * 会议负责人对整场会议的所有事项都有处置权（含创建者，不含共享编辑者）。
     * 超管是唯一的全局例外：它本来就拥有全部数据的处置权。
     */
    const access = await assertCanRead(this.prisma, user, todo.meetingId)

    const isMeetingLeader =
      access.access === 'owner' || access.leaderIds.includes(user.id)

    /** 该事项的验收人；未指定验收人时只有会议负责人能改 */
    const isTodoReviewer = todo.reviewerId !== null && todo.reviewerId === user.id

    if (!isMeetingLeader && !isTodoReviewer && user.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException(
        '只有该事项的验收人或会议负责人可以修改状态',
      );
    }

    /**
     * 只剩一个后门要堵：不能直接把状态改成 SUBMITTED
     * （必须走提交，才能留下交付记录）。
     */
    if (status === 'SUBMITTED') {
      throw new BadRequestException('请通过「提交」操作进入待验收');
    }

    if (todo.status === 'SUBMITTED') {
      throw new ConflictException('该待办正在等待验收，请先验收或撤回');
    }

    /**
     * 有验收人时也允许直接勾「已完成」，但要分清是不是验收人本人做的：
     * - 验收人本人勾完成 = 他给出结论，等同验收通过（不额外记审计）
     * - 会议负责人 / 超管代完成 = 跳过了验收环节，写一条审计留痕
     *
     * 这里刻意不补造 ACCEPTED 提交记录：没有真实交付却补一条，
     * 会把返工次数、平均验收时长这些统计口径弄脏。
     */
    const forceComplete =
      status === 'COMPLETED' && todo.reviewerId !== null && !isTodoReviewer

    // 待办状态与会议状态必须一起变，否则会出现
    // “待办全完成但会议仍显示进行中”的不一致状态。
    const [updated, completionStatus] = await this.prisma.$transaction(
      async (tx) => {
        const next = await tx.todo.update({
          where: { id },
          data: { status },
        });

        await tx.todoEvent.create({
          data: {
            todoId: id,
            actorId: user.id,
            type: status === 'IN_PROGRESS' && todo.status === 'COMPLETED'
              ? 'reopened'
              : 'status_changed',
            fromStatus: todo.status,
            toStatus: status,
            ...(forceComplete && {
              metadata: {
                forced: true,
                reviewerId: todo.reviewerId,
              } as Prisma.InputJsonValue,
            }),
          },
        })

        return [
          next,
          await this.syncMeetingCompletionStatus(tx, todo.meetingId),
        ] as const;
      },
    );

    if (forceComplete) {
      await this.audit.record(user, {
        action: 'todo.complete_forced',
        resourceType: 'meeting',
        resourceId: todo.meetingId,
        metadata: { todoId: id, reviewerId: todo.reviewerId },
      })
    }

    return {
      id: updated.id,
      meetingId: updated.meetingId,
      content: updated.content,
      assignee: updated.assignee,
      assigneeUserId: updated.assigneeUserId,
      reviewerId: updated.reviewerId,
      deadline: updated.deadline,
      deadlineAt: updated.deadlineAt?.toISOString() ?? null,
      status: updated.status,
      /** 同步后的会议完成状态，供前端立即刷新表头，无需重新拉取整个会议。 */
      meetingCompletionStatus: completionStatus,
    };
  }
  /* =========================
     待办交付与验收
     ========================= */

  /**
   * 提交交付。
   *
   * 权限：负责人本人，或会议负责人代为提交。
   * 有验收人时进入 SUBMITTED；验收人就是提交人时自动通过（不制造自己审自己的假流程）。
   */
  async submitTodo(todoId: number, note: string | undefined, user: AuthenticatedUser) {
    const todo = await this.prisma.todo.findUnique({
      where: { id: todoId },
      select: {
        id: true,
        meetingId: true,
        content: true,
        status: true,
        assigneeUserId: true,
        reviewerId: true,
        // 没有验收人时要通知会议负责人
        meeting: { select: { leaders: { select: { userId: true } } } },
      },
    })

    if (!todo) throw new NotFoundException('待办事项不存在')

    // 读权限校验放在前面：与会议无关的人统一 404
    await assertCanRead(this.prisma, user, todo.meetingId)

    /**
     * 提交是负责人的动作，负责人也不能代交。
     * 代交会让「谁承诺的、谁交付的」错位；需要别人接手时，先改派负责人。
     */
    if (todo.assigneeUserId !== user.id) {
      throw new ForbiddenException(
        todo.assigneeUserId
          ? '只有该待办的负责人可以提交'
          : '该待办还没有指定负责人，请先指派后再提交',
      )
    }

    if (todo.status !== 'OPEN' && todo.status !== 'IN_PROGRESS') {
      throw new ConflictException('只有未完成的待办可以提交')
    }

    const autoAccept = todo.reviewerId === user.id
    const nextStatus: TodoStatus = autoAccept ? 'COMPLETED' : 'SUBMITTED'

    const [submission, completionStatus] = await this.prisma.$transaction(
      async (tx) => {
        const attemptNo =
          (await tx.todoSubmission.count({ where: { todoId } })) + 1

        const created = await tx.todoSubmission.create({
          data: {
            todoId,
            submitterId: user.id,
            reviewerId: todo.reviewerId,
            note: note?.trim() || null,
            status: autoAccept ? 'ACCEPTED' : 'PENDING',
            attemptNo,
            reviewedAt: autoAccept ? new Date() : null,
          },
        })

        const moved = await tx.todo.updateMany({
          where: { id: todoId, status: { in: ['OPEN', 'IN_PROGRESS'] } },
          data: { status: nextStatus },
        })

        if (!moved.count) {
          throw new ConflictException('待办状态已变化，请刷新后重试')
        }

        await tx.todoEvent.create({
          data: {
            todoId,
            actorId: user.id,
            type: 'submitted',
            fromStatus: todo.status,
            toStatus: nextStatus,
            submissionId: created.id,
            metadata: { attemptNo, autoAccepted: autoAccept } as Prisma.InputJsonValue,
          },
        })

        if (autoAccept) {
          await tx.todoEvent.create({
            data: {
              todoId,
              actorId: user.id,
              type: 'accepted',
              fromStatus: 'SUBMITTED',
              toStatus: 'COMPLETED',
              submissionId: created.id,
              metadata: { autoAccepted: true } as Prisma.InputJsonValue,
            },
          })
        } else {
          // 没有验收人时通知会议负责人，避免提交后无人处理
          const recipients = todo.reviewerId
            ? [todo.reviewerId]
            : todo.meeting.leaders.map((l) => l.userId)

          await this.notifyTodo(
            tx,
            todo.meetingId,
            recipients.filter((id) => id !== user.id),
            'todo_submitted',
            `待办「${todo.content ?? ''}」已提交，等待验收`,
          )
        }

        return [
          created,
          await this.syncMeetingCompletionStatus(tx, todo.meetingId),
        ] as const
      },
    )

    return {
      id: submission.id,
      todoId,
      status: submission.status,
      attemptNo: submission.attemptNo,
      meetingCompletionStatus: completionStatus,
    }
  }

  /** 撤回提交：仅待验收状态、仅提交人（或会议负责人） */
  async withdrawSubmission(submissionId: number, user: AuthenticatedUser) {
    const submission = await this.loadSubmission(submissionId)

    // 先做读权限校验：与会议无关的人统一 404，不泄露提交是否存在
    await assertCanRead(this.prisma, user, submission.todo.meetingId)

    /**
     * 撤回是提交人的动作，负责人也不能代撤。
     * 负责人要反悔验收流程，应该用「打回」而不是替提交人撤回。
     */
    if (submission.submitterId !== user.id) {
      throw new ForbiddenException('只有提交人本人可以撤回')
    }

    const [updated, completionStatus] = await this.prisma.$transaction(
      async (tx) => {
        const claimed = await tx.todoSubmission.updateMany({
          where: { id: submissionId, status: 'PENDING' },
          data: { status: 'WITHDRAWN' },
        })

        if (!claimed.count) {
          throw new ConflictException('该提交已处理，无法撤回')
        }

        await tx.todo.updateMany({
          where: { id: submission.todoId, status: 'SUBMITTED' },
          data: { status: 'IN_PROGRESS' },
        })

        await tx.todoEvent.create({
          data: {
            todoId: submission.todoId,
            actorId: user.id,
            type: 'withdrawn',
            fromStatus: 'SUBMITTED',
            toStatus: 'IN_PROGRESS',
            submissionId,
          },
        })

        return [
          await tx.todoSubmission.findUniqueOrThrow({ where: { id: submissionId } }),
          await this.syncMeetingCompletionStatus(tx, submission.todo.meetingId),
        ] as const
      },
    )

    return { id: updated.id, status: updated.status, meetingCompletionStatus: completionStatus }
  }

  /** 验收通过：提交人不能验自己（提交时已自动通过），负责人可代验收并留审计 */
  async acceptSubmission(submissionId: number, user: AuthenticatedUser) {
    const submission = await this.loadSubmission(submissionId)
    await this.assertCanReview(submission, user, 'accept')

    const [updated, completionStatus, uncheckedChecklist] = await this.prisma.$transaction(
      async (tx) => {
        const claimed = await tx.todoSubmission.updateMany({
          where: { id: submissionId, status: 'PENDING' },
          data: { status: 'ACCEPTED', reviewedAt: new Date() },
        })

        if (!claimed.count) {
          throw new ConflictException('该提交已处理，请刷新后重试')
        }

        const moved = await tx.todo.updateMany({
          where: { id: submission.todoId, status: 'SUBMITTED' },
          data: { status: 'COMPLETED' },
        })

        if (!moved.count) {
          throw new ConflictException('待办状态已变化，请刷新后重试')
        }

        await tx.todoEvent.create({
          data: {
            todoId: submission.todoId,
            actorId: user.id,
            type: 'accepted',
            fromStatus: 'SUBMITTED',
            toStatus: 'COMPLETED',
            submissionId,
            metadata: {
              forced: submission.reviewerId !== user.id,
            } as Prisma.InputJsonValue,
          },
        })

        await this.notifyTodo(
          tx,
          submission.todo.meetingId,
          [submission.submitterId],
          'todo_accepted',
          `待办「${submission.todo.content}」已验收通过`,
        )

        // 清单只是提示：未勾完也允许通过，但把未勾数量带回去让前端说明
        const uncheckedChecklist = await tx.todoCheckItem.count({
          where: { todoId: submission.todoId, done: false },
        })

        return [
          await tx.todoSubmission.findUniqueOrThrow({ where: { id: submissionId } }),
          await this.syncMeetingCompletionStatus(tx, submission.todo.meetingId),
          uncheckedChecklist,
        ] as const
      },
    )

    if (submission.reviewerId !== user.id) {
      await this.audit.record(user, {
        action: 'todo.accept_forced',
        resourceType: 'meeting',
        resourceId: submission.todo.meetingId,
        metadata: { todoId: submission.todoId, submissionId },
      })
    }

    return {
      id: updated.id,
      status: updated.status,
      meetingCompletionStatus: completionStatus,
      /** 还有几条验收要点没勾；前端据此提示「未勾完也通过了」 */
      uncheckedChecklist,
    }
  }

  /** 打回：原因必填（≥5 字），待办退回进行中 */
  async rejectSubmission(
    submissionId: number,
    reason: string,
    user: AuthenticatedUser,
  ) {
    const text = (reason ?? '').trim()

    if (text.length < 5) {
      throw new BadRequestException('请填写至少 5 个字的打回原因')
    }

    const submission = await this.loadSubmission(submissionId)
    await this.assertCanReview(submission, user, 'reject')

    const [updated, completionStatus] = await this.prisma.$transaction(
      async (tx) => {
        const claimed = await tx.todoSubmission.updateMany({
          where: { id: submissionId, status: 'PENDING' },
          data: {
            status: 'REJECTED',
            rejectReason: text,
            reviewedAt: new Date(),
          },
        })

        if (!claimed.count) {
          throw new ConflictException('该提交已处理，请刷新后重试')
        }

        await tx.todo.updateMany({
          where: { id: submission.todoId, status: 'SUBMITTED' },
          data: { status: 'IN_PROGRESS' },
        })

        await tx.todoEvent.create({
          data: {
            todoId: submission.todoId,
            actorId: user.id,
            type: 'rejected',
            fromStatus: 'SUBMITTED',
            toStatus: 'IN_PROGRESS',
            submissionId,
            metadata: { reason: text } as Prisma.InputJsonValue,
          },
        })

        await this.notifyTodo(
          tx,
          submission.todo.meetingId,
          [submission.submitterId],
          'todo_rejected',
          `待办「${submission.todo.content}」被打回：${text}`,
        )

        return [
          await tx.todoSubmission.findUniqueOrThrow({ where: { id: submissionId } }),
          await this.syncMeetingCompletionStatus(tx, submission.todo.meetingId),
        ] as const
      },
    )

    return { id: updated.id, status: updated.status, meetingCompletionStatus: completionStatus }
  }

  /** 某条待办的提交时间线（含附件元信息） */
  async listTodoSubmissions(todoId: number, user: AuthenticatedUser) {
    const todo = await this.prisma.todo.findUnique({
      where: { id: todoId },
      select: {
        meetingId: true,
        assigneeUserId: true,
        reviewerId: true,
      },
    })

    if (!todo) throw new NotFoundException('待办事项不存在')

    const access = await assertCanRead(this.prisma, user, todo.meetingId)

    /**
     * 只有与这条待办直接相关的人能看提交内容：
     * 负责人（提交对象）、验收人、会议负责人/创建者、超管。
     * 其他成员与共享者只能看到「第几次、什么时候、什么状态」。
     */
    const relatedToTodo =
      access.access === 'owner' ||
      access.leaderIds.includes(user.id) ||
      todo.assigneeUserId === user.id ||
      todo.reviewerId === user.id ||
      user.role === 'SUPER_ADMIN'

    const rows = await this.prisma.todoSubmission.findMany({
      where: { todoId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        note: true,
        attemptNo: true,
        rejectReason: true,
        reviewedAt: true,
        createdAt: true,
        submitterId: true,
        submitter: { select: { id: true, name: true } },
        reviewer: { select: { id: true, name: true } },
        attachments: {
          select: {
            id: true,
            fileName: true,
            mimeType: true,
            sizeBytes: true,
            createdAt: true,
          },
        },
      },
    })

    return rows.map((row) => {
      const createdAt = row.createdAt.toISOString()

      // 提交人本人即使后来被改派，也仍然能看到自己交过的东西
      const canViewContent = relatedToTodo || row.submitterId === user.id

      if (!canViewContent) {
        return {
          id: row.id,
          status: row.status,
          attemptNo: row.attemptNo,
          createdAt,
          reviewedAt: null,
          note: null,
          rejectReason: null,
          // 提交人属于元信息：让成员知道是谁交的，但看不到交了什么
          submitter: row.submitter,
          reviewer: null,
          attachments: [],
          canViewContent: false,
        }
      }

      return {
        id: row.id,
        status: row.status,
        attemptNo: row.attemptNo,
        createdAt,
        reviewedAt: row.reviewedAt?.toISOString() ?? null,
        note: row.note,
        rejectReason: row.rejectReason,
        submitter: row.submitter,
        reviewer: row.reviewer,
        attachments: row.attachments.map((a) => ({
          ...a,
          createdAt: a.createdAt.toISOString(),
          url: `/api/meetings/todos/${todoId}/submissions/${row.id}/attachments/${a.id}`,
        })),
        canViewContent: true,
      }
    })
  }

  /** 待办流转时间线 */
  async listTodoEvents(todoId: number, user: AuthenticatedUser) {
    const todo = await this.prisma.todo.findUnique({
      where: { id: todoId },
      select: {
        meetingId: true,
        assigneeUserId: true,
        reviewerId: true,
      },
    })

    if (!todo) throw new NotFoundException('待办事项不存在')

    const access = await assertCanRead(this.prisma, user, todo.meetingId)

    const relatedToTodo =
      access.access === 'owner' ||
      access.leaderIds.includes(user.id) ||
      todo.assigneeUserId === user.id ||
      todo.reviewerId === user.id ||
      user.role === 'SUPER_ADMIN'

    const rows = await this.prisma.todoEvent.findMany({
      where: { todoId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        type: true,
        fromStatus: true,
        toStatus: true,
        submissionId: true,
        metadata: true,
        createdAt: true,
        actor: { select: { id: true, name: true } },
      },
    })

    return rows.map((row) => ({
      ...row,
      // 打回原因属于提交内容，无关的人只看到「被打回」这个事实
      metadata:
        !relatedToTodo && row.type === 'rejected' ? null : row.metadata,
      createdAt: row.createdAt.toISOString(),
    }))
  }

  /**
   * 给某次提交追加交付物。
   *
   * 约束：仅提交人本人或会议负责人可加；仅待验收状态可加（验收后再加会让验收结论失效）。
   * 单次提交最多 5 个文件，单文件大小由控制器层的 multer 限制。
   */
  async addSubmissionAttachment(
    submissionId: number,
    file: { originalname: string; mimetype: string; size: number; path: string; filename: string },
    user: AuthenticatedUser,
  ) {
    const submission = await this.loadSubmission(submissionId)
    const access = await assertCanRead(
      this.prisma,
      user,
      submission.todo.meetingId,
    )

    const isLeader =
      access.access === 'owner' ||
      access.leaderIds.includes(user.id) ||
      access.capabilities.canEdit

    if (submission.submitterId !== user.id && !isLeader) {
      throw new ForbiddenException('只有提交人本人或会议负责人可以补充交付物')
    }

    if (submission.status !== 'PENDING') {
      throw new ConflictException('该提交已处理，不能再补充交付物')
    }

    const count = await this.prisma.todoAttachment.count({
      where: { submissionId },
    })

    if (count >= 5) {
      throw new BadRequestException('单次提交最多 5 个附件')
    }

    const created = await this.prisma.todoAttachment.create({
      data: {
        submissionId,
        fileName: file.originalname.slice(0, 255),
        mimeType: file.mimetype.slice(0, 128) || 'application/octet-stream',
        sizeBytes: file.size,
        // 相对 backend 运行目录保存，换机器后仍能定位
        storedPath: `uploads/todos/${submissionId}/${file.filename}`,
      },
    })

    await this.prisma.todoEvent.create({
      data: {
        todoId: submission.todoId,
        actorId: user.id,
        type: 'attachment_added',
        submissionId,
        metadata: { attachmentId: created.id, fileName: created.fileName } as Prisma.InputJsonValue,
      },
    })

    return {
      id: created.id,
      fileName: created.fileName,
      mimeType: created.mimeType,
      sizeBytes: created.sizeBytes,
      url: `/api/meetings/todos/${submission.todoId}/submissions/${submissionId}/attachments/${created.id}`,
    }
  }

  /** 校验下载权限并返回磁盘位置 */
  async resolveSubmissionAttachment(
    todoId: number,
    submissionId: number,
    attachmentId: number,
    user: AuthenticatedUser,
  ) {
    const attachment = await this.prisma.todoAttachment.findFirst({
      where: {
        id: attachmentId,
        submissionId,
        submission: { todoId },
      },
      select: {
        id: true,
        fileName: true,
        mimeType: true,
        storedPath: true,
        submission: {
          select: {
            submitterId: true,
            todo: {
              select: {
                meetingId: true,
                assigneeUserId: true,
                reviewerId: true,
              },
            },
          },
        },
      },
    })

    if (!attachment) throw new NotFoundException('附件不存在')

    const access = await assertCanRead(
      this.prisma,
      user,
      attachment.submission.todo.meetingId,
    )

    /**
     * 附件是提交内容的一部分：只有负责人、验收人、会议负责人/创建者、超管，
     * 以及该次提交的提交人本人可以下载。其他成员只能看到「有几次提交」。
     */
    const canView =
      access.access === 'owner' ||
      access.leaderIds.includes(user.id) ||
      attachment.submission.submitterId === user.id ||
      attachment.submission.todo.assigneeUserId === user.id ||
      attachment.submission.todo.reviewerId === user.id ||
      user.role === 'SUPER_ADMIN'

    if (!canView) {
      throw new ForbiddenException('只有与该待办相关的人员可以查看提交内容')
    }

    return {
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      absolutePath: join(process.cwd(), attachment.storedPath),
    }
  }

  /**
   * 删除会议前清理交付物文件。
   *
   * 附件是磁盘文件，不参与外键级联；记录删了文件还在，uploads 卷会攒孤儿。
   * 清理失败只记日志，不能因此挡住删除。
   */
  async removeTodoAttachmentFiles(meetingId: number) {
    const attachments = await this.prisma.todoAttachment.findMany({
      where: { submission: { todo: { meetingId } } },
      select: { storedPath: true },
    })

    for (const attachment of attachments) {
      try {
        await unlink(join(process.cwd(), attachment.storedPath))
      } catch {
        // 文件已不存在或权限不足：不影响数据库记录的级联删除
      }
    }
  }

  /* =========================
     验收要点（清单）
     ========================= */

  /**
   * 覆盖式设置验收要点。
   *
   * 待验收期间禁止修改：验收人正在按清单核对，这时换清单等于移动球门。
   * 最多 20 条，单条 200 字；空数组表示清空。
   */
  async setTodoChecklist(todoId: number, items: string[], user: AuthenticatedUser) {
    const todo = await this.prisma.todo.findUnique({
      where: { id: todoId },
      select: { meetingId: true, status: true },
    })

    if (!todo) throw new NotFoundException('待办事项不存在')

    await assertCanWrite(this.prisma, user, todo.meetingId)

    if (todo.status === 'SUBMITTED') {
      throw new ConflictException('待验收期间不能修改验收要点，请先验收或撤回')
    }

    const contents = items
      .map((item) => (item ?? '').trim())
      .filter(Boolean)
      .slice(0, 20)
      .map((item) => item.slice(0, 200))

    const rows = await this.prisma.$transaction(async (tx) => {
      await tx.todoCheckItem.deleteMany({ where: { todoId } })

      if (contents.length) {
        await tx.todoCheckItem.createMany({
          data: contents.map((content, sortOrder) => ({
            todoId,
            content,
            sortOrder,
          })),
        })
      }

      await tx.todoEvent.create({
        data: {
          todoId,
          actorId: user.id,
          type: 'checklist_updated',
          metadata: { count: contents.length } as Prisma.InputJsonValue,
        },
      })

      return tx.todoCheckItem.findMany({
        where: { todoId },
        orderBy: { sortOrder: 'asc' },
        select: {
          id: true,
          content: true,
          done: true,
          doneById: true,
          doneAt: true,
          doneBy: { select: { id: true, name: true } },
        },
      })
    })

    return {
      todoId,
      checklist: rows.map((row) => ({
        id: row.id,
        content: row.content,
        done: row.done,
        doneById: row.doneById ?? null,
        doneByName: row.doneBy?.name ?? null,
        doneAt: row.doneAt?.toISOString() ?? null,
      })),
    }
  }

  /** 勾选 / 取消一条验收要点；不改待办状态 */
  async toggleTodoCheckItem(
    todoId: number,
    itemId: number,
    done: boolean,
    user: AuthenticatedUser,
  ) {
    const item = await this.prisma.todoCheckItem.findFirst({
      where: { id: itemId, todoId },
      select: {
        id: true,
        content: true,
        todo: { select: { meetingId: true } },
      },
    })

    if (!item) throw new NotFoundException('验收要点不存在')

    // 成员也可以勾：清单是核对工具，不应该只有负责人能打勾
    await assertCanEditTodos(this.prisma, user, item.todo.meetingId)

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.todoCheckItem.update({
        where: { id: itemId },
        data: {
          done,
          doneById: done ? user.id : null,
          doneAt: done ? new Date() : null,
        },
      })

      await tx.todoEvent.create({
        data: {
          todoId,
          actorId: user.id,
          type: done ? 'check_checked' : 'check_unchecked',
          metadata: { itemId, content: item.content } as Prisma.InputJsonValue,
        },
      })

      return next
    })

    return {
      id: updated.id,
      done: updated.done,
      doneByName: done ? user.name : null,
      doneAt: updated.doneAt?.toISOString() ?? null,
    }
  }

  /** 读取提交及其待办、会议归属，供验收类操作复用 */
  private async loadSubmission(submissionId: number) {
    const submission = await this.prisma.todoSubmission.findUnique({
      where: { id: submissionId },
      select: {
        id: true,
        status: true,
        submitterId: true,
        reviewerId: true,
        todoId: true,
        todo: {
          select: {
            content: true,
            meetingId: true,
          },
        },
      },
    })

    if (!submission) throw new NotFoundException('提交记录不存在')

    return submission
  }

  /** 谁能验收：指定验收人，或会议创建者/负责人/管理员（代验收） */
  private async assertCanReview(
    submission: SubmissionForReview,
    user: AuthenticatedUser,
    action: 'accept' | 'reject',
  ) {
    const access = await assertCanRead(
      this.prisma,
      user,
      submission.todo.meetingId,
    )

    const allowed =
      submission.reviewerId === user.id ||
      access.access === 'owner' ||
      access.leaderIds.includes(user.id) ||
      access.capabilities.canEdit

    if (!allowed) {
      throw new ForbiddenException(
        action === 'accept'
          ? '只有验收人或会议负责人可以确认通过'
          : '只有验收人或会议负责人可以打回',
      )
    }

    /**
     * 自己不能验自己。
     * 验收人等于提交人时提交阶段已自动通过，走不到这里；
     * 这一条挡的是「创建者/负责人给自己的交付盖章」。
     */
    if (submission.submitterId === user.id) {
      throw new ForbiddenException('不能验收自己提交的交付，请让其他负责人或验收人处理')
    }

    if (submission.status !== 'PENDING') {
      throw new ConflictException('该提交已处理，请刷新后重试')
    }
  }

  /** 写一条待办相关的收件箱消息；没有收件人就跳过 */
  private async notifyTodo(
    tx: Prisma.TransactionClient,
    meetingId: number,
    userIds: number[],
    kind: string,
    content: string,
  ) {
    const targets = [...new Set(userIds)].filter((id) => Number.isFinite(id))

    if (!targets.length) return

    await tx.meetingNotice.createMany({
      data: targets.map((userId) => ({
        userId,
        meetingId,
        kind,
        content,
      })),
    })
  }

  /**
   * 根据待办完成情况推算会议应处的状态。
   *
   * 规则（双向）：
   * - 会议存在待办且全部已处理完 → COMPLETED
   * - 还有待处理待办 → IN_PROGRESS
   * - 没有任何待办 → 保持原状态（没有待办就没有“全部完成”可谈）
   * - 会议已被手动取消 → 保持 CANCELLED，不覆盖用户意图
   *
   * 待办是否算“已处理完”的策略集中在这里：
   * CANCELLED 视为不再需要处理，因此不阻挡会议完成。
   * 若希望已取消的待办也阻挡完成，把数组改成 ['COMPLETED'] 即可。
   */
  private readonly SETTLED_TODO_STATUSES: TodoStatus[] = [
    'COMPLETED',
    'CANCELLED',
  ];

  /** 纯函数形式的判定规则，方便创建路径与同步路径复用同一套逻辑。 */
  private resolveCompletionStatus(
    current: MeetingCompletionStatus,
    todoStatuses: TodoStatus[],
  ): MeetingCompletionStatus {
    if (current === 'CANCELLED') {
      return current;
    }

    if (todoStatuses.length === 0) {
      return current;
    }

    const allSettled = todoStatuses.every((status) =>
      this.SETTLED_TODO_STATUSES.includes(status),
    );

    return allSettled ? 'COMPLETED' : 'IN_PROGRESS';
  }

  private async syncMeetingCompletionStatus(
    tx: Prisma.TransactionClient,
    meetingId: number,
  ): Promise<MeetingCompletionStatus> {
    const meeting = await tx.meeting.findUnique({
      where: { id: meetingId },
      select: { completionStatus: true },
    });

    if (!meeting) {
      throw new NotFoundException('会议记录不存在');
    }

    // 用户主动取消的会议不参与自动流转。
    if (meeting.completionStatus === 'CANCELLED') {
      return meeting.completionStatus;
    }

    const todos = await tx.todo.findMany({
      where: { meetingId },
      select: { status: true },
    });

    const next = this.resolveCompletionStatus(
      meeting.completionStatus,
      todos.map((todo) => todo.status),
    );

    if (next === meeting.completionStatus) {
      return next;
    }

    await tx.meeting.update({
      where: { id: meetingId },
      data: { completionStatus: next },
    });

    return next;
  }
  /**
   * 解析待办的默认验收人：未指定验收人时，取会议负责人；负责人有多个时取创建者。
   * 返回 null 仅当会议既没有负责人也没有创建者（理论上不会发生）。
   */
  private async resolveDefaultReviewerId(meetingId: number): Promise<number | null> {
    const meeting = await this.prisma.meeting.findUnique({
      where: { id: meetingId },
      select: {
        ownerId: true,
        leaders: { select: { userId: true }, orderBy: { createdAt: 'asc' as const } },
      },
    })

    if (!meeting) throw new NotFoundException('会议不存在')

    const leaderIds = meeting.leaders.map((l) => l.userId)

    if (leaderIds.length === 0) return meeting.ownerId
    if (leaderIds.length === 1) return leaderIds[0]

    // 多个负责人：默认创建者；创建者不在负责人列表时，退回第一个负责人
    return leaderIds.includes(meeting.ownerId) ? meeting.ownerId : leaderIds[0]
  }

  async createTodo(
    meetingId: number,
    data: {
      content: string;
      assignee?: string;
      assigneeUserId?: number | null;
      reviewerId?: number | null;
      deadline?: string;
      deadlineAt?: string | null;
    },
    user: AuthenticatedUser,
  ) {
    await assertCanWrite(this.prisma, user, meetingId);

    // 指定了负责人 ID 就以账号姓名为准，文本只作展示
    let assignee = data.assignee?.trim() || null

    if (data.assigneeUserId) {
      const target = await this.prisma.user.findUnique({
        where: { id: data.assigneeUserId },
        select: { name: true, isActive: true },
      })

      if (!target) throw new NotFoundException('指定的负责人不存在')
      if (!target.isActive) throw new BadRequestException('该账号已停用，不能担任负责人')

      assignee = target.name
    }

    // 未指定验收人时，默认会议负责人（多个时默认创建者）
    let reviewerId = data.reviewerId ?? null
    if (!reviewerId) {
      reviewerId = await this.resolveDefaultReviewerId(meetingId)
    }

    if (reviewerId) {
      const reviewer = await this.prisma.user.findUnique({
        where: { id: reviewerId },
        select: { isActive: true },
      })

      if (!reviewer) throw new NotFoundException('指定的验收人不存在')
      if (!reviewer.isActive) throw new BadRequestException('该账号已停用，不能担任验收人')
    }

    // 新增的待办一定是未完成状态，因此会议不再是“全部完成”。
    const [todo, completionStatus] = await this.prisma.$transaction(
      async (tx) => {
        const created = await tx.todo.create({
          data: {
            meetingId,
            content: data.content.trim(),
            assignee,
            assigneeUserId: data.assigneeUserId ?? null,
            reviewerId: reviewerId ?? null,
            deadline: data.deadline?.trim() || null,
            deadlineAt: data.deadlineAt
              ? parseDeadlineAt(data.deadlineAt)
              : parseDeadlineAt(data.deadline),
            status: 'OPEN',
            sortOrder: 0,
          },
        });

        await tx.todoEvent.create({
          data: {
            todoId: created.id,
            actorId: user.id,
            type: 'created',
            toStatus: 'OPEN',
            metadata: {
              assigneeUserId: created.assigneeUserId,
              reviewerId: created.reviewerId,
            } as Prisma.InputJsonValue,
          },
        })

        // 负责人与验收人都必须能看到这场会议，否则打开待办只会拿到 404
        const membersToAdd = [created.assigneeUserId, created.reviewerId].filter(
          (userId): userId is number => !!userId,
        )

        for (const userId of [...new Set(membersToAdd)]) {
          await tx.meetingMember.upsert({
            where: { meetingId_userId: { meetingId, userId } },
            create: { meetingId, userId },
            update: {},
          })
        }

        return [
          created,
          await this.syncMeetingCompletionStatus(tx, meetingId),
        ] as const;
      },
    );

    return {
      id: todo.id,
      meetingId: todo.meetingId,
      content: todo.content,
      assignee: todo.assignee,
      assigneeUserId: todo.assigneeUserId,
      reviewerId: todo.reviewerId,
      deadline: todo.deadline,
      deadlineAt: todo.deadlineAt?.toISOString() ?? null,
      status: todo.status,
      meetingCompletionStatus: completionStatus,
    };
  }
  /** 删除单条待办事项 */
  async removeTodo(id: number, user: AuthenticatedUser) {
    const todo = await this.prisma.todo.findUnique({
      where: { id },
    });

    if (!todo) {
      throw new NotFoundException('待办事项不存在');
    }

    await assertCanWrite(this.prisma, user, todo.meetingId);

    // 删掉的若是最后一项未完成待办，会议同样应变为已完成。
    const completionStatus = await this.prisma.$transaction(
      async (tx) => {
        await tx.todo.delete({
          where: { id },
        });

        return this.syncMeetingCompletionStatus(tx, todo.meetingId);
      },
    );

    return {
      message: '待办事项删除成功',
      id,
      meetingId: todo.meetingId,
      meetingCompletionStatus: completionStatus,
    };
  }

  /**
   * 批量转换列表：根据归属关系计算每条的访问级别与能力位。
   *
   * shares 已在查询时按当前用户过滤（meetingIncludeFor），
   * 因此只需看本人的那条授权即可判定 edit / read。
   */
  private toApiRecordList(
    meetings: Array<MeetingWithRelations>,
    user: AuthenticatedUser,
  ) {
    return meetings.map((meeting) => {
      let access: MeetingAccess;

      if (meeting.ownerId === user.id) {
        access = 'owner';
      } else if (meeting.leaders?.some((l) => l.user.id === user.id)) {
        access = 'leader';
      } else if (meeting.members?.some((m) => m.user.id === user.id)) {
        access = 'member';
      } else if (meeting.shares?.some((s) => s.permission === 'EDIT')) {
        // 共享明确给了编辑权
        access = 'edit';
      } else if (hasGlobalMeetingAccess(user)) {
        // 管理员及以上，无显式共享时仍可按全局权限编辑
        access = roleHasUpdateAll(user.role) ? 'edit' : 'read';
      } else {
        access = 'read';
      }

      const capabilities = computeMeetingCapabilities({
        user,
        access,
        audioOpen: meeting.audioOpen,
      });

      return this.toApiRecord(meeting, access, user, capabilities);
    });
  }

  /** 转换 Prisma 字段名及关联数据，维持现有 Vue 页面所需的 API 结构。 */
  private toApiRecord(
    meeting: MeetingWithRelations,
    access: MeetingAccess,
    user: AuthenticatedUser,
    capabilities: MeetingCapabilities,
  ) {
    const audioUrl = meeting.audioUrl ?? null;

    return {
      id: meeting.id,
      title: meeting.title,
      content: meeting.content,
      summary: meeting.summary ?? '',
      completionStatus: meeting.completionStatus,
      /**
       * 录音地址。未开放且当前用户无权听时返回 null，
       * 避免前端拿到地址后仍能直接播放。
       * 真正播放走鉴权接口 /api/meetings/:id/audio。
       */
      audioUrl: capabilities.canListenAudio && audioUrl
        ? `/api/meetings/${meeting.id}/audio`
        : null,
      audioDurationSec: meeting.audioDurationSec ?? null,
      /** 正式会议的开会时间；为空表示临时会议 */
      scheduledAt: meeting.scheduledAt?.toISOString() ?? null,
      /** 录音是否对非负责人开放（前端用于渲染开关状态） */
      audioOpen: meeting.audioOpen,
      /** 是否存在录音（与是否有权听无关，用于展示“有录音但未开放”） */
      hasAudio: !!audioUrl,
      // 置顶时间；为空表示未置顶。前端据此把置顶会议排在最前。
      pinnedAt: meeting.pinnedAt?.toISOString() ?? null,
      isDraft:
        meeting.status === 'FAILED' ||
        meeting.status === 'DRAFT',

      // ---- 负责人与成员 ----
      leaders: (meeting.leaders ?? []).map((l) => ({
        id: l.user.id,
        name: l.user.name,
        phone: l.user.phone,
      })),
      members: (meeting.members ?? []).map((m) => ({
        id: m.user.id,
        name: m.user.name,
        phone: m.user.phone,
      })),

      // ---- 权限相关字段，前端据此决定按钮是否可点 ----
      /** 归属者 ID，用于判断“是我的会议” */
      ownerId: meeting.ownerId,
      /** 当前用户的实际访问级别 */
      access,
      ...capabilities,

      decisions: meeting.decisions.map((decision) => decision.content),
      todos: meeting.todos.map((todo) => {
        const latest = todo.submissions?.[0] ?? null
        const leaderIds = (meeting.leaders ?? []).map((l) => l.user.id)
        const isMeetingLeader = access === 'owner' || leaderIds.includes(user.id)
        const isLeaderLike =
          access === 'owner' ||
          leaderIds.includes(user.id) ||
          capabilities.canEdit

        const isAssignee = todo.assigneeUserId === user.id
        const unfinished = todo.status === 'OPEN' || todo.status === 'IN_PROGRESS'

        return {
          id: todo.id,
          content: todo.content,
          assignee: todo.assignee ?? undefined,
          /** 结构化负责人；为空说明只留了姓名文本（AI 没能唯一匹配到账号） */
          assigneeUserId: todo.assigneeUserId ?? null,
          assigneeName: todo.assigneeUser?.name ?? todo.assignee ?? null,
          /** 验收人；为空表示这条待办不需要验收 */
          reviewerId: todo.reviewerId ?? null,
          reviewerName: todo.reviewer?.name ?? null,
          deadline: todo.deadline ?? undefined,
          deadlineAt: todo.deadlineAt?.toISOString() ?? null,
          /** 逾期：过了截止时间且未完成（含待验收） */
          overdue: isOverdue(todo.deadlineAt, todo.status),
          /** 验收要点：只是清单，不改变状态机 */
          checklist: (todo.checkItems ?? []).map((item) => ({
            id: item.id,
            content: item.content,
            done: item.done,
            doneById: item.doneById ?? null,
            doneByName: item.doneBy?.name ?? null,
            doneAt: item.doneAt?.toISOString() ?? null,
          })),
          checklistTotal: todo.checkItems?.length ?? 0,
          checklistDone: todo.checkItems?.filter((item) => item.done).length ?? 0,
          status: todo.status,
          /** 最近一次提交（待验收 / 被打回时前端据此渲染角标与时间线入口） */
          latestSubmission: latest
            ? {
              id: latest.id,
              status: latest.status,
              note: latest.note,
              attemptNo: latest.attemptNo,
              submitterId: latest.submitterId,
              submitterName: latest.submitter?.name ?? null,
              rejectReason: latest.rejectReason,
              reviewedAt: latest.reviewedAt?.toISOString() ?? null,
              createdAt: latest.createdAt.toISOString(),
              attachmentCount: latest._count?.attachments ?? 0,
            }
            : null,
          /** 改状态：该事项的验收人、会议负责人，或超级管理员 */
          canChangeStatus:
            todo.status !== 'SUBMITTED' &&
            (isMeetingLeader ||
              (todo.reviewerId !== null && todo.reviewerId === user.id) ||
              user.role === 'SUPER_ADMIN'),
          /** 提交：只有该待办的负责人 */
          canSubmit: unfinished && isAssignee,
          /** 能否查看提交内容（说明、附件、打回原因） */
          canViewSubmissionContent:
            isAssignee ||
            todo.reviewerId === user.id ||
            isMeetingLeader ||
            user.role === 'SUPER_ADMIN',
          /** 验收人：指定验收人，或负责人/管理员代验收 */
          canReview:
            todo.status === 'SUBMITTED' &&
            latest?.status === 'PENDING' &&
            (todo.reviewerId === user.id || isLeaderLike),
          /** 撤回：只有提交人本人，负责人也不行 */
          canWithdraw:
            todo.status === 'SUBMITTED' &&
            latest?.status === 'PENDING' &&
            latest.submitterId === user.id,
        }
      }),
      created_at: meeting.createdAt.toISOString(),
    };
  }
}

/** 验收操作需要的最小提交视图 */
interface SubmissionForReview {
  id: number;
  status: string;
  submitterId: number;
  reviewerId: number | null;
  todoId: number;
  todo: { content: string; meetingId: number };
}

/** 列表/详情查询统一带回的基础关联与归属字段 */
type UserBrief = { id: number; name: string; phone: string };

type MeetingWithRelations = Meeting & {
  decisions: Array<{ content: string; sortOrder: number }>;
  todos: Array<{
    id: number;
    content: string;
    assignee: string | null;
    assigneeUserId: number | null;
    reviewerId: number | null;
    deadline: string | null;
    deadlineAt: Date | null;
    status: TodoStatus;
    sortOrder: number;
    assigneeUser?: { id: number; name: string } | null;
    reviewer?: { id: number; name: string } | null;
    checkItems?: Array<{
      id: number;
      content: string;
      done: boolean;
      doneById: number | null;
      doneAt: Date | null;
      doneBy?: { id: number; name: string } | null;
    }>;
    submissions?: Array<{
      id: number;
      status: string;
      note: string | null;
      attemptNo: number;
      submitterId: number;
      reviewerId: number | null;
      rejectReason: string | null;
      reviewedAt: Date | null;
      createdAt: Date;
      submitter?: { id: number; name: string };
      _count?: { attachments: number };
    }>;
  }>;
  leaders?: Array<{ user: UserBrief }>;
  members?: Array<{ user: UserBrief }>;
  shares?: Array<{ permission: 'READ' | 'EDIT' }>;
};
