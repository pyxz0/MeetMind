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
};

@Injectable()
export class MeetingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audioService: MeetingAudioService,
  ) { }

  /** 创建会议并通过嵌套写入原文、摘要、决策和待办，保证一次提交完成。 */
  async create(input: CreateMeetingInput) {
    const meeting = await this.prisma.meeting.create({
      data: {
        title: input.title?.trim() || '未命名会议',
        content: input.content,
        summary: input.summary ?? null,
        status: 'READY',
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

    if (completionStatus === meeting.completionStatus) {
      return meeting;
    }

    return this.prisma.meeting.update({
      where: { id: meeting.id },
      data: { completionStatus },
      include: meetingInclude,
    });
  }

  /** 手动将会议内容保存到草稿箱 */
  async createDraft(input: { title?: string; content: string }) {
    if (!input.content?.trim()) {
      throw new BadRequestException('会议内容不能为空');
    }

    return this.prisma.meeting.create({
      data: {
        title: input.title?.trim() || '会议草稿',
        content: input.content.trim(),
        summary: null,
        status: 'DRAFT',
        completionStatus: 'NOT_STARTED',
      },
      include: meetingInclude,
    });
  }

  /** 手动修改会议完成状态 */
  async updateMeetingCompletionStatus(
    id: number,
    completionStatus: MeetingCompletionStatus,
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

    const meeting = await this.prisma.meeting.findUnique({
      where: { id },
    });

    if (!meeting) {
      throw new NotFoundException('会议记录不存在');
    }

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
    }
  ) {
    const meeting = await this.prisma.meeting.findUnique({
      where: { id }
    });

    if (!meeting) {
      throw new NotFoundException('会议记录不存在');
    }

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
  async updatePinned(id: number, pinned: boolean) {
    const meeting = await this.prisma.meeting.findUnique({
      where: { id },
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
    }
  ) {
    const todo = await this.prisma.todo.findUnique({
      where: { id }
    })

    if (!todo) {
      throw new NotFoundException('待办事项不存在')
    }

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
  async getStats() {
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
      this.prisma.meeting.count({
        where: {
          status: {
            notIn: ['DRAFT', 'FAILED'],
          },
        },
      }),

      // 草稿箱数量：手动草稿 + AI 生成失败
      this.prisma.meeting.count({
        where: {
          status: {
            in: ['DRAFT', 'FAILED'],
          },
        },
      }),

      // 以下会议完成状态统计，都只统计正式会议
      this.prisma.meeting.count({
        where: {
          status: {
            notIn: ['DRAFT', 'FAILED'],
          },
          completionStatus: 'NOT_STARTED',
        },
      }),

      this.prisma.meeting.count({
        where: {
          status: {
            notIn: ['DRAFT', 'FAILED'],
          },
          completionStatus: 'IN_PROGRESS',
        },
      }),

      this.prisma.meeting.count({
        where: {
          status: {
            notIn: ['DRAFT', 'FAILED'],
          },
          completionStatus: 'COMPLETED',
        },
      }),

      this.prisma.meeting.count({
        where: {
          status: {
            notIn: ['DRAFT', 'FAILED'],
          },
          completionStatus: 'CANCELLED',
        },
      }),

      this.prisma.todo.count(),

      this.prisma.todo.count({
        where: {
          status: 'COMPLETED',
        },
      }),

      this.prisma.decision.count(),
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

  /** 查询正常历史会议，不显示草稿箱中的 AI 失败记录。 */
  async findAll() {
    const meetings = await this.prisma.meeting.findMany({
      where: {
        status: {
          notIn: ['FAILED', 'DRAFT'],
        },
      },
      // 已置顶的排在最前（按置顶时间倒序），其余按创建时间倒序。
      // nulls: 'last' 让未置顶记录排在置顶记录之后。
      orderBy: [
        { pinnedAt: { sort: 'desc', nulls: 'last' } },
        { createdAt: 'desc' },
      ],
      include: meetingInclude,
    });

    return meetings.map((meeting) => this.toApiRecord(meeting));
  }

  /** 查询草稿箱会议；AI 生成失败的会议会保留在这里。 */
  async findDrafts() {
    const meetings = await this.prisma.meeting.findMany({
      where: {
        status: {
          in: ['FAILED', 'DRAFT'],
        },
      },
      orderBy: { createdAt: 'desc' },
      include: meetingInclude,
    });

    return meetings.map((meeting) => this.toApiRecord(meeting));
  }

  /** 查询单条会议详情；不存在时返回 404，而不是空值。 */
  async findOne(id: number) {
    const meeting = await this.prisma.meeting.findUnique({
      where: { id },
      include: meetingInclude,
    });
    if (!meeting) throw new NotFoundException('会议记录不存在');
    return this.toApiRecord(meeting);
  }

  /** 先检查记录是否存在，再删除；外键会级联清理决策和待办。 */
  async remove(id: number) {
    const meeting = await this.prisma.meeting.findUnique({ where: { id } });
    if (!meeting) throw new NotFoundException('会议记录不存在');

    // 录音是磁盘文件，不参与外键级联，必须在删除记录前单独清理。
    await this.audioService.removeAudioByMeetingId(id);

    await this.prisma.meeting.delete({ where: { id } });
  }
  /** 更新待办事项状态。 */
  async updateTodoStatus(id: number, status: TodoStatus) {
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
  ) {
    const meeting = await this.prisma.meeting.findUnique({
      where: { id: meetingId },
    });

    if (!meeting) {
      throw new NotFoundException('会议记录不存在');
    }

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
  async removeTodo(id: number) {
    const todo = await this.prisma.todo.findUnique({
      where: { id },
    });

    if (!todo) {
      throw new NotFoundException('待办事项不存在');
    }

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

  /** 转换 Prisma 字段名及关联数据，维持现有 Vue 页面所需的 API 结构。 */
  private toApiRecord(
    meeting: Meeting & {
      decisions: Array<{ content: string; sortOrder: number }>;
      todos: Array<{
        id: number;
        content: string;
        assignee: string | null;
        deadline: string | null;
        status: TodoStatus;
        sortOrder: number;
      }>;
    },
  ) {
    return {
      id: meeting.id,
      title: meeting.title,
      content: meeting.content,
      summary: meeting.summary ?? '',
      completionStatus: meeting.completionStatus,
      // 录音的站内相对路径；为空表示这场会议没有留存录音。
      audioUrl: meeting.audioUrl ?? null,
      audioDurationSec: meeting.audioDurationSec ?? null,
      // 置顶时间；为空表示未置顶。前端据此把置顶会议排在最前。
      pinnedAt: meeting.pinnedAt?.toISOString() ?? null,
      isDraft:
        meeting.status === 'FAILED' ||
        meeting.status === 'DRAFT',
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
