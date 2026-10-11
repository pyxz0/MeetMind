import {
  BadRequestException,
  Body,
  Controller,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common'

import { AiService } from './ai.service'

@Controller('ai')
export class AiController {
  constructor(
    private readonly aiService: AiService,
  ) {}

  /** 根据会议原文生成新的 AI 会议纪要 */
  @Post('generate')
  async generate(
    @Body('content') content: string,
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
    )
  }

  /** 重新生成已有会议的 AI 纪要 */
  @Post('regenerate/:id')
  async regenerate(
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.aiService.regenerateMeetingSummary(
      id,
    )
  }
}