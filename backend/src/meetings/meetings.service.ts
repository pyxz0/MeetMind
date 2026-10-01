import { Injectable, NotFoundException } from '@nestjs/common';
import { Meeting, TodoStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

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
  constructor(private readonly prisma: PrismaService) {}

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

  /** 查询历史记录并按创建时间倒序排列，映射成前端使用的字段格式。 */
  async findAll() {
    const meetings = await this.prisma.meeting.findMany({
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

  /** 转换 Prisma 字段名及关联数据，维持现有 Vue 页面所需的 API 结构。 */
  private toApiRecord(
    meeting: Meeting & {
      decisions: Array<{ content: string; sortOrder: number }>;
      todos: Array<{
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
      decisions: meeting.decisions.map((decision) => decision.content),
      todos: meeting.todos.map((todo) => ({
        content: todo.content,
        assignee: todo.assignee ?? undefined,
        deadline: todo.deadline ?? undefined,
        status: todo.status,
      })),
      created_at: meeting.createdAt.toISOString(),
    };
  }
}
