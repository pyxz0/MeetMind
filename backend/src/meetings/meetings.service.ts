import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import {
  Meeting,
  Prisma,
  TodoStatus,
  MeetingCompletionStatus,
} from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { MeetingAudioService } from './meeting-audio.service';
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
  resolveMeetingAccess,
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
    deadline?: string | null;
  }>;
}

// 所有读取接口都按录入顺序返回决策和待办，避免数据库默认顺序不确定。
const meetingInclude = {
  decisions: { orderBy: { sortOrder: 'asc' as const } },
  todos: { orderBy: { sortOrder: 'asc' as const } },
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

@Injectable()
export class MeetingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audioService: MeetingAudioService,
  ) { }

  /** 创建会议并通过嵌套写入原文、摘要、决策和待办，保证一次提交完成。 */
  async create(input: CreateMeetingInput, user: AuthenticatedUser) {
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
          create: (input.todos ?? []).map((todo, sortOrder) => ({
            content: todo.content,
            assignee: todo.assignee ?? null,
            deadline: todo.deadline ?? null,
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

  /** 手动将会议内容保存到草稿箱 */
  async createDraft(
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

    return this.prisma.meeting.update({
      where: { id },
      data: {
        completionStatus,
      },
      select: {
        id: true,
        title: true,
        completionStatus: true,
      },
    });
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
      deadline?: string
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

    return this.prisma.todo.update({
      where: { id },
      data: {
        ...(data.content !== undefined && {
          content: data.content
        }),
        ...(data.assignee !== undefined && {
          assignee: data.assignee
        }),
        ...(data.deadline !== undefined && {
          deadline: data.deadline
        })
      }
    })
  }

  /** 获取正式会议和草稿箱统计 */
  async getStats(user: AuthenticatedUser) {
    // 统计同样受数据隔离约束：只看自己可见范围内的数据
    const visible = this.visibleMeetingWhere(user);

    const formalMeeting: Prisma.MeetingWhereInput = {
      AND: [visible, { status: { notIn: ['DRAFT', 'FAILED'] } }],
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
      totalDecisions,
    ] = await Promise.all([
      // 正式会议总数：排除手动草稿和 AI 生成失败记录
      this.prisma.meeting.count({ where: formalMeeting }),

      // 草稿箱数量：手动草稿 + AI 生成失败
      this.prisma.meeting.count({ where: draftMeeting }),

      // 以下会议完成状态统计，都只统计正式会议
      this.prisma.meeting.count({
        where: { AND: [formalMeeting, { completionStatus: 'NOT_STARTED' }] },
      }),

      this.prisma.meeting.count({
        where: { AND: [formalMeeting, { completionStatus: 'IN_PROGRESS' }] },
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

      this.prisma.decision.count({ where: visibleDecision }),
    ])

    return {
      totalMeetings,
      draftMeetings,
      notStartedMeetings,
      inProgressMeetings,
      completedMeetings,
      cancelledMeetings,
      totalTodos,
      completedTodos,
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

  /** 查询正常历史会议，不显示草稿箱中的 AI 失败记录。 */
  async findAll(user: AuthenticatedUser) {
    const meetings = await this.prisma.meeting.findMany({
      where: {
        AND: [
          this.visibleMeetingWhere(user),
          { status: { notIn: ['FAILED', 'DRAFT'] } },
        ],
      },
      // 已置顶的排在最前（按置顶时间倒序），其余按创建时间倒序。
      // nulls: 'last' 让未置顶记录排在置顶记录之后。
      orderBy: [
        { pinnedAt: { sort: 'desc', nulls: 'last' } },
        { createdAt: 'desc' },
      ],
      include: meetingIncludeFor(user.id),
    });

    return this.toApiRecordList(meetings, user);
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

    await this.prisma.meeting.delete({ where: { id } });
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

    // 成员允许勾选待办状态；修改待办内容仍走 assertCanWrite
    await assertCanEditTodos(this.prisma, user, todo.meetingId);

    // 待办状态与会议状态必须一起变，否则会出现
    // “待办全完成但会议仍显示进行中”的不一致状态。
    const [updated, completionStatus] = await this.prisma.$transaction(
      async (tx) => {
        const next = await tx.todo.update({
          where: { id },
          data: { status },
        });

        return [
          next,
          await this.syncMeetingCompletionStatus(tx, todo.meetingId),
        ] as const;
      },
    );

    return {
      id: updated.id,
      meetingId: updated.meetingId,
      content: updated.content,
      assignee: updated.assignee,
      deadline: updated.deadline,
      status: updated.status,
      /** 同步后的会议完成状态，供前端立即刷新表头，无需重新拉取整个会议。 */
      meetingCompletionStatus: completionStatus,
    };
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
  async createTodo(
    meetingId: number,
    data: {
      content: string;
      assignee?: string;
      deadline?: string;
    },
    user: AuthenticatedUser,
  ) {
    await assertCanWrite(this.prisma, user, meetingId);

    // 新增的待办一定是未完成状态，因此会议不再是“全部完成”。
    const [todo, completionStatus] = await this.prisma.$transaction(
      async (tx) => {
        const created = await tx.todo.create({
          data: {
            meetingId,
            content: data.content.trim(),
            assignee: data.assignee?.trim() || null,
            deadline: data.deadline?.trim() || null,
            status: 'OPEN',
            sortOrder: 0,
          },
        });

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
      deadline: todo.deadline,
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
      todos: meeting.todos.map((todo) => ({
        id: todo.id,
        content: todo.content,
        assignee: todo.assignee ?? undefined,
        deadline: todo.deadline ?? undefined,
        status: todo.status,
      })),
      created_at: meeting.createdAt.toISOString(),
    };
  }
}

/** 列表/详情查询统一带回的基础关联与归属字段 */
type UserBrief = { id: number; name: string; phone: string };

type MeetingWithRelations = Meeting & {
  decisions: Array<{ content: string; sortOrder: number }>;
  todos: Array<{
    id: number;
    content: string;
    assignee: string | null;
    deadline: string | null;
    status: TodoStatus;
    sortOrder: number;
  }>;
  leaders?: Array<{ user: UserBrief }>;
  members?: Array<{ user: UserBrief }>;
  shares?: Array<{ permission: 'READ' | 'EDIT' }>;
};
