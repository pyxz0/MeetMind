import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import {
  Meeting,
  TodoStatus,
  MeetingCompletionStatus,
} from '@prisma/client';
import { PrismaService } from '../common/prisma.service';

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
  constructor(private readonly prisma: PrismaService) { }

  /** 创建会议并通过嵌套写入原文、摘要、决策和待办，保证一次提交完成。 */
  async create(input: CreateMeetingInput) {
    return this.prisma.meeting.create({
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
      orderBy: { createdAt: 'desc' },
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

    return this.prisma.todo.update({
      where: { id },
      data: { status },
      select: {
        id: true,
        meetingId: true,
        content: true,
        assignee: true,
        deadline: true,
        status: true,
      },
    });
  }
  /** 为已有会议新增待办事项。 */
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

    const todo = await this.prisma.todo.create({
      data: {
        meetingId,
        content: data.content.trim(),
        assignee: data.assignee?.trim() || null,
        deadline: data.deadline?.trim() || null,
        status: 'OPEN',
        sortOrder: 0,
      },
    });

    return {
      id: todo.id,
      meetingId: todo.meetingId,
      content: todo.content,
      assignee: todo.assignee,
      deadline: todo.deadline,
      status: todo.status,
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

    await this.prisma.todo.delete({
      where: { id },
    });

    return {
      message: '待办事项删除成功',
      id,
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
