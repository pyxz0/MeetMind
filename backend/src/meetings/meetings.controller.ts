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
  Put,
  Query,
} from '@nestjs/common';
import { MeetingsService } from './meetings.service';
import { AiService } from '../ai/ai.service';
import { AskMeetingDto } from '../ai/dto/ai.dto';
import {
  CompletionStatusDto,
  CreateDraftDto,
  CreateMeetingDto,
  CreateScheduledMeetingDto,
  CreateTodoDto,
  ListMeetingsQueryDto,
  AudioOpenDto,
  MeetingUserDto,
  PinMeetingDto,
  RejectSubmissionDto,
  SetChecklistDto,
  SubmitTodoDto,
  TodoStatusDto,
  ToggleCheckItemDto,
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
  constructor(
    private readonly meetingsService: MeetingsService,
    // 追问复用 AI 模块的模型客户端，但不把 AI 相关逻辑搬进会议服务
    private readonly aiService: AiService,
  ) {}

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

  /**
   * 历史会议列表：分页 + 服务端筛选。
   *
   * 默认不含未开始的预约会议（由首页展示）；upcoming=true 时反过来只取未开始的。
   * 列表只返回摘要与计数，明细请调 GET /meetings/:id。
   */
  @Get()
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListMeetingsQueryDto,
  ) {
    return this.meetingsService.findAll(user, query);
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

  /**
   * 就这份纪要提问。
   *
   * 挂在会议下而不是 /ai 下：权限本来就是按会议判定的，
   * 路径也应当说明它读的是哪一场会议。
   * 只读 —— 不改会议、不改待办，问答本身落库。
   */
  @Post(':id/ask')
  askMeeting(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AskMeetingDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.aiService.askMeeting(id, dto.question, user);
  }

  /** 追问历史（最近 30 条），打开追问面板时回填 */
  @Get(':id/chat')
  listMeetingChat(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.aiService.listMeetingChat(id, user);
  }

  /**
   * 导出会议纪要（Markdown）。
   *
   * 返回 JSON 而不是文件流：前端拿到 filename + content 后自己造 Blob 下载，
   * 这样不必把令牌塞进 URL（`<a download>` 无法携带 Authorization 头）。
   */
  @Get(':id/export')
  exportOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.meetingsService.exportMarkdown(id, user);
  }

  /** 会议状态变更记录（谁把会议状态改成了什么） */
  @Get(':id/events')
  listMeetingEvents(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.meetingsService.listMeetingEvents(id, user);
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

  /* =========================
     验收要点（清单）
     ========================= */

  /** 覆盖式设置验收要点（待验收期间禁止修改） */
  @Put('todos/:id/checklist')
  setTodoChecklist(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetChecklistDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.meetingsService.setTodoChecklist(id, dto.items, user);
  }

  /** 勾选 / 取消一条验收要点 */
  @Patch('todos/:id/checklist/:itemId')
  toggleTodoCheckItem(
    @Param('id', ParseIntPipe) id: number,
    @Param('itemId', ParseIntPipe) itemId: number,
    @Body() dto: ToggleCheckItemDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.meetingsService.toggleTodoCheckItem(id, itemId, dto.done, user);
  }

  /* =========================
     待办交付与验收
     ========================= */

  /** 提交交付：有验收人时进入待验收，否则直接完成 */
  @Post('todos/:id/submissions')
  submitTodo(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SubmitTodoDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.meetingsService.submitTodo(id, dto?.note, user);
  }

  /** 某条待办的提交时间线 */
  @Get('todos/:id/submissions')
  listTodoSubmissions(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.meetingsService.listTodoSubmissions(id, user);
  }

  /** 待办流转时间线 */
  @Get('todos/:id/events')
  listTodoEvents(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.meetingsService.listTodoEvents(id, user);
  }

  /** 撤回提交（仅待验收状态） */
  @Post('submissions/:id/withdraw')
  withdrawSubmission(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.meetingsService.withdrawSubmission(id, user);
  }

  /** 验收通过 */
  @Post('submissions/:id/accept')
  acceptSubmission(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.meetingsService.acceptSubmission(id, user);
  }

  /** 打回，原因必填 */
  @Post('submissions/:id/reject')
  rejectSubmission(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RejectSubmissionDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.meetingsService.rejectSubmission(id, dto.reason, user);
  }
}