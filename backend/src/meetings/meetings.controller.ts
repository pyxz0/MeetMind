import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { MeetingsService } from './meetings.service';
import {
  CompletionStatusDto,
  CreateDraftDto,
  CreateMeetingDto,
  CreateScheduledMeetingDto,
  CreateTodoDto,
  AudioOpenDto,
  MeetingUserDto,
  PinMeetingDto,
  TodoStatusDto,
  UpdateMeetingTitleDto,
  UpdateScheduledMeetingDto,
  UpdateTodoDto,
} from './dto/meetings.dto';
import {
  CurrentUser,
  RequirePermissions,
  type AuthenticatedUser,
} from '../auth/auth.decorators';
import { PERMISSIONS } from '../auth/permissions';

/**
 * 会议接口。
 *
 * 入参结构统一交给 DTO + 全局 ValidationPipe 校验，
 * 因此这里不再手写 if (typeof ...) 判断 —— 校验规则集中在 dto/meetings.dto.ts。
 */
@Controller('meetings')
export class MeetingsController {
  constructor(private readonly meetingsService: MeetingsService) {}

  /** 保存 AI 生成的纪要结构 */
  @Post()
  @RequirePermissions(PERMISSIONS.MEETING_CREATE)
  create(@Body() dto: CreateMeetingDto, @CurrentUser() user: AuthenticatedUser) {
    return this.meetingsService.create(dto, user);
  }

  /** 创建正式会议（预约开会时间） */
  @Post('scheduled')
  @RequirePermissions(PERMISSIONS.MEETING_CREATE)
  createScheduled(
    @Body() dto: CreateScheduledMeetingDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.meetingsService.createScheduled(dto, user);
  }

  /** 手动将会议内容保存到草稿箱 */
  @Post('drafts')
  @RequirePermissions(PERMISSIONS.MEETING_CREATE)
  createDraft(
    @Body() dto: CreateDraftDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.meetingsService.createDraft(dto, user);
  }

  /** 为指定会议新增待办事项 */
  @Post(':id/todos')
  createTodo(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateTodoDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.meetingsService.createTodo(id, dto, user);
  }

  /** 编辑待办事项 */
  @Patch('todos/:id')
  updateTodo(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateTodoDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.meetingsService.updateTodo(id, dto, user);
  }

  /** 手动修改会议完成状态 */
  @Patch(':id/completion-status')
  updateMeetingCompletionStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CompletionStatusDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.meetingsService.updateMeetingCompletionStatus(
      id,
      dto.completionStatus,
      user,
    );
  }

  /** 置顶 / 取消置顶会议 */
  @Patch(':id/pin')
  updatePinned(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PinMeetingDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.meetingsService.updatePinned(id, dto.pinned, user);
  }

  /** 修改会议标题 */
  @Patch(':id')
  updateMeeting(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateMeetingTitleDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.meetingsService.updateMeeting(id, { title: dto.title }, user);
  }

  /** 修改未开始会议的预约信息（标题 / 时间 / 负责人 / 成员） */
  @Patch(':id/schedule')
  updateScheduled(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateScheduledMeetingDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.meetingsService.updateScheduled(id, dto, user);
  }

  /** 追加负责人（可多位） */
  @Post(':id/leaders')
  addLeader(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: MeetingUserDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.meetingsService.addLeader(id, dto.userId, user);
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
    @Body() dto: AudioOpenDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.meetingsService.updateAudioOpen(id, dto.audioOpen, user);
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
    @Body() dto: MeetingUserDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.meetingsService.addMember(id, dto.userId, user);
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
    @Body() dto: TodoStatusDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.meetingsService.updateTodoStatus(id, dto.status, user);
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