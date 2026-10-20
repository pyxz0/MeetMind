import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';

import { AiService } from './ai.service';
import { GenerateMeetingDto } from './dto/ai.dto';
import {
  CurrentUser,
  RequirePermissions,
  type AuthenticatedUser,
} from '../auth/auth.decorators';
import { PERMISSIONS } from '../auth/permissions';

@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  /**
   * 根据会议原文生成 AI 会议纪要。
   *
   * 必须登录：该接口会消耗模型额度，匿名可调等同于把 API Key 公开。
   */
  @Post('generate')
  @RequirePermissions(PERMISSIONS.MEETING_CREATE)
  generate(
    @Body() dto: GenerateMeetingDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // 立即返回任务 id，前端轮询进度，避免长请求超时
    return this.aiService.startGeneration(dto.content, user);
  }

  /** 查询生成进度 */
  @Get('generations/:id')
  @RequirePermissions(PERMISSIONS.MEETING_READ_OWN)
  getGeneration(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.aiService.getGenerationStatus(id, user);
  }

  /** 重新生成已有会议的 AI 纪要，需要该会议的写权限 */
  @Post('regenerate/:id')
  @RequirePermissions(PERMISSIONS.MEETING_CREATE)
  regenerate(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.aiService.regenerateMeetingSummary(id, user);
  }
}