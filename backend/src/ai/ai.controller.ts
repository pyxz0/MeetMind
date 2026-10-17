import {
  BadRequestException,
  Body,
  Controller,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common'

import { AiService } from './ai.service'
import {
  CurrentUser,
  RequirePermissions,
  type AuthenticatedUser,
} from '../auth/auth.decorators'
import { PERMISSIONS } from '../auth/permissions'

@Controller('ai')
export class AiController {
  constructor(
    private readonly aiService: AiService,
  ) {}

  /**
   * 根据会议原文生成新的 AI 会议纪要。
   *
   * 必须登录：该接口会消耗模型额度，匿名可调等同于把 API Key 公开。
   * 生成的会议归属当前用户。
   */
  @Post('generate')
  @RequirePermissions(PERMISSIONS.MEETING_CREATE)
  async generate(
    @Body('content') content: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (
      !content ||
      typeof content !== 'string' ||
      !content.trim()
    ) {
      throw new BadRequestException(
        '会议内容不能为空',
      )
    }

    return this.aiService.generateMeetingSummary(
      content,
      user,
    )
  }

  /** 重新生成已有会议的 AI 纪要，需要该会议的写权限 */
  @Post('regenerate/:id')
  @RequirePermissions(PERMISSIONS.MEETING_CREATE)
  async regenerate(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.aiService.regenerateMeetingSummary(
      id,
      user,
    )
  }
}
