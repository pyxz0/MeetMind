import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Patch,
} from '@nestjs/common';
import { MeetingsService } from './meetings.service';
import type { CreateMeetingInput } from './meetings.service';

@Controller('meetings')
export class MeetingsController {
  constructor(private readonly meetingsService: MeetingsService) { }

  /** 校验前端传入的纪要结构，再交给业务服务进行关联保存。 */
  @Post()
  create(@Body() body: CreateMeetingInput) {
    if (!body || typeof body.content !== 'string' || !body.content.trim()) {
      throw new BadRequestException('content 不能为空');
    }
    if (body.summary != null && typeof body.summary !== 'string') {
      throw new BadRequestException('summary 必须是字符串');
    }
    if (
      body.decisions != null &&
      (!Array.isArray(body.decisions) ||
        body.decisions.some((item) => typeof item !== 'string'))
    ) {
      throw new BadRequestException('decisions 必须是字符串数组');
    }
    if (
      body.todos != null &&
      (!Array.isArray(body.todos) ||
        body.todos.some(
          (todo) =>
            !todo ||
            typeof todo.content !== 'string' ||
            (todo.assignee != null && typeof todo.assignee !== 'string') ||
            (todo.deadline != null && typeof todo.deadline !== 'string'),
        ))
    ) {
      throw new BadRequestException('todos 格式无效');
    }

    return this.meetingsService.create(body);
  }

  /** 手动将会议内容保存到草稿箱 */
  @Post('drafts')
  createDraft(
    @Body()
    body: {
      title?: string;
      content: string;
    },
  ) {
    if (
      !body ||
      typeof body.content !== 'string' ||
      !body.content.trim()
    ) {
      throw new BadRequestException('content 不能为空');
    }

    if (
      body.title != null &&
      typeof body.title !== 'string'
    ) {
      throw new BadRequestException('title 必须是字符串');
    }

    return this.meetingsService.createDraft(body);
  }

  /** 为指定会议新增待办事项 */
  @Post(':id/todos')
  createTodo(
    @Param('id', ParseIntPipe) id: number,
    @Body()
    body: {
      content: string;
      assignee?: string;
      deadline?: string;
    },
  ) {
    if (!body || typeof body.content !== 'string' || !body.content.trim()) {
      throw new BadRequestException('待办内容不能为空');
    }

    return this.meetingsService.createTodo(id, body);
  }

  /** 编辑待办事项 */
  @Patch('todos/:id')
  updateTodo(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: {
      content?: string
      assignee?: string
      deadline?: string
    }
  ) {
    return this.meetingsService.updateTodo(id, body)
  }

  /** 手动修改会议完成状态 */
  @Patch(':id/completion-status')
  updateMeetingCompletionStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { completionStatus: string },
  ) {
    const allowedStatuses = [
      'NOT_STARTED',
      'IN_PROGRESS',
      'COMPLETED',
      'CANCELLED',
    ];

    if (
      !body ||
      typeof body.completionStatus !== 'string' ||
      !allowedStatuses.includes(body.completionStatus)
    ) {
      throw new BadRequestException(
        '无效的会议完成状态',
      );
    }

    return this.meetingsService.updateMeetingCompletionStatus(
      id,
      body.completionStatus as import('@prisma/client').MeetingCompletionStatus,
    );
  }

  /** 置顶 / 取消置顶会议 */
  @Patch(':id/pin')
  updatePinned(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { pinned: boolean },
  ) {
    if (!body || typeof body.pinned !== 'boolean') {
      throw new BadRequestException('pinned 必须是布尔值');
    }

    return this.meetingsService.updatePinned(id, body.pinned);
  }

  /** 修改会议标题 */
  @Patch(':id')
  updateMeeting(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { title: string },
  ) {
    if (!body || typeof body.title !== 'string' || !body.title.trim()) {
      throw new BadRequestException('会议标题不能为空');
    }

    if (body.title.trim().length > 200) {
      throw new BadRequestException('会议标题不能超过200个字符');
    }

    return this.meetingsService.updateMeeting(id, body);
  }

  /** 获取所有历史会议，顺序和输出格式由业务服务统一处理。 */
  @Get()
  findAll() {
    return this.meetingsService.findAll();
  }

  /** 获取草稿箱中的会议 */
  @Get('drafts')
  findDrafts() {
    return this.meetingsService.findDrafts();
  }

  /** 获取会议统计数据 */
  @Get('stats')
  getStats() {
    return this.meetingsService.getStats();
  }

  /** 通过整数 ID 查询单条会议；ParseIntPipe 会拦截非数字路径参数。 */
  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.meetingsService.findOne(id);
  }

  /** 删除会议及其关联内容，并返回无响应体的 204 状态。 */
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', ParseIntPipe) id: number) {
    await this.meetingsService.remove(id);
  }

  /** 更新指定待办事项的处理状态。 */
  @Patch('todos/:id/status')
  updateTodoStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { status: string },
  ) {
    const allowedStatuses = [
      'OPEN',
      'IN_PROGRESS',
      'COMPLETED',
      'CANCELLED',
    ];

    if (
      !body ||
      typeof body.status !== 'string' ||
      !allowedStatuses.includes(body.status)
    ) {
      throw new BadRequestException('无效的待办状态');
    }

    return this.meetingsService.updateTodoStatus(
      id,
      body.status as import('@prisma/client').TodoStatus,
    );
  }

  /** 删除单条待办事项 */
  @Delete('todos/:id')
  removeTodo(@Param('id', ParseIntPipe) id: number) {
    return this.meetingsService.removeTodo(id);
  }
}
