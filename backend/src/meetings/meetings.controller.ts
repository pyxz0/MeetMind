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
import {
  CurrentUser,
  RequirePermissions,
  type AuthenticatedUser,
} from '../auth/auth.decorators';
import { PERMISSIONS } from '../auth/permissions';

@Controller('meetings')
export class MeetingsController {
  constructor(private readonly meetingsService: MeetingsService) { }

  /** 校验前端传入的纪要结构，再交给业务服务进行关联保存。 */
  @Post()
  @RequirePermissions(PERMISSIONS.MEETING_CREATE)
  create(@Body() body: CreateMeetingInput, @CurrentUser() user: AuthenticatedUser) {
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

    return this.meetingsService.create(body, user);
  }

  /** 创建正式会议（预约开会时间） */
  @Post('scheduled')
  @RequirePermissions(PERMISSIONS.MEETING_CREATE)
  createScheduled(
    @Body()
    body: {
      title?: string;
      scheduledAt?: string;
      leaderIds?: number[];
      memberIds?: number[];
    },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!body?.scheduledAt || typeof body.scheduledAt !== 'string') {
      throw new BadRequestException('scheduledAt 不能为空');
    }

    return this.meetingsService.createScheduled(
      {
        title: body.title,
        scheduledAt: body.scheduledAt,
        leaderIds: body.leaderIds,
        memberIds: body.memberIds,
      },
      user,
    );
  }

  /** 手动将会议内容保存到草稿箱 */
  @Post('drafts')
  @RequirePermissions(PERMISSIONS.MEETING_CREATE)
  createDraft(
    @Body()
    body: {
      title?: string;
      content: string;
    },
    @CurrentUser() user: AuthenticatedUser,
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

    return this.meetingsService.createDraft(body, user);
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
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!body || typeof body.content !== 'string' || !body.content.trim()) {
      throw new BadRequestException('待办内容不能为空');
    }

    return this.meetingsService.createTodo(id, body, user);
  }

  /** 编辑待办事项 */
  @Patch('todos/:id')
  updateTodo(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: {
      content?: string
      assignee?: string
      deadline?: string
    },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.meetingsService.updateTodo(id, body, user)
  }

  /** 手动修改会议完成状态 */
  @Patch(':id/completion-status')
  updateMeetingCompletionStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { completionStatus: string },
    @CurrentUser() user: AuthenticatedUser,
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
      user,
    );
  }

  /** 置顶 / 取消置顶会议 */
  @Patch(':id/pin')
  updatePinned(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { pinned: boolean },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!body || typeof body.pinned !== 'boolean') {
      throw new BadRequestException('pinned 必须是布尔值');
    }

    return this.meetingsService.updatePinned(id, body.pinned, user);
  }

  /** 修改会议标题 */
  @Patch(':id')
  updateMeeting(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { title: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!body || typeof body.title !== 'string' || !body.title.trim()) {
      throw new BadRequestException('会议标题不能为空');
    }

    if (body.title.trim().length > 200) {
      throw new BadRequestException('会议标题不能超过200个字符');
    }

    return this.meetingsService.updateMeeting(id, body, user);
  }

  /** 追加负责人（可多位） */
  @Post(':id/leaders')
  addLeader(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { userId?: number },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const userId = body?.userId;

    if (typeof userId !== 'number' || !Number.isInteger(userId) || userId <= 0) {
      throw new BadRequestException('userId 必须是正整数');
    }

    return this.meetingsService.addLeader(id, userId, user);
  }

  /** 移除负责人；至少要保留一位 */
  @Delete(':id/leaders/:userId')
  removeLeader(
    @Param('id', ParseIntPipe) id: number,
    @Param('userId', ParseIntPipe) userId: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.meetingsService.removeLeader(id, userId, user);
  }

  /** 控制录音是否对非负责人开放 */
  @Patch(':id/audio-open')
  updateAudioOpen(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { audioOpen?: boolean },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (typeof body?.audioOpen !== 'boolean') {
      throw new BadRequestException('audioOpen 必须是布尔值');
    }

    return this.meetingsService.updateAudioOpen(id, body.audioOpen, user);
  }

  /** 会议成员列表 */
  @Get(':id/members')
  listMembers(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.meetingsService.findMembers(id, user);
  }

  /** 添加会议成员 */
  @Post(':id/members')
  addMember(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { userId?: number },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const userId = body?.userId;

    if (typeof userId !== 'number' || !Number.isInteger(userId) || userId <= 0) {
      throw new BadRequestException('userId 必须是正整数');
    }

    return this.meetingsService.addMember(id, userId, user);
  }

  /** 移除会议成员 */
  @Delete(':id/members/:userId')
  removeMember(
    @Param('id', ParseIntPipe) id: number,
    @Param('userId', ParseIntPipe) userId: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.meetingsService.removeMember(id, userId, user);
  }

  /** 获取所有历史会议，顺序和输出格式由业务服务统一处理。 */
  @Get()
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.meetingsService.findAll(user);
  }

  /** 获取草稿箱中的会议 */
  @Get('drafts')
  findDrafts(@CurrentUser() user: AuthenticatedUser) {
    return this.meetingsService.findDrafts(user);
  }

  /** 获取会议统计数据 */
  @Get('stats')
  getStats(@CurrentUser() user: AuthenticatedUser) {
    return this.meetingsService.getStats(user);
  }

  /** 通过整数 ID 查询单条会议；ParseIntPipe 会拦截非数字路径参数。 */
  @Get(':id')
  findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.meetingsService.findOne(id, user);
  }

  /** 删除会议及其关联内容，并返回无响应体的 204 状态。 */
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.meetingsService.remove(id, user);
  }

  /** 更新指定待办事项的处理状态。 */
  @Patch('todos/:id/status')
  updateTodoStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { status: string },
    @CurrentUser() user: AuthenticatedUser,
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
      user,
    );
  }

  /** 删除单条待办事项 */
  @Delete('todos/:id')
  removeTodo(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.meetingsService.removeTodo(id, user);
  }
}
