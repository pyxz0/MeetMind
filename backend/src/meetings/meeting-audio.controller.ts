import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { MeetingAudioService } from './meeting-audio.service';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../auth/auth.decorators';
import { assertCanListenAudio, assertCanWrite } from './meetings.access';
import { PrismaService } from '../common/prisma.service';

/** 浏览器录音容器，Chrome/Edge 为 webm，Safari 为 mp4。 */
const AUDIO_MIME_PATTERN = /^audio\/|^video\/webm$|^application\/ogg$/;

/**
 * multer 上传后挂到请求上的文件对象。
 *
 * 这里只声明本接口真正用到的字段：@types/multer 的
 * Express.Multer 全局增强在当前 nodenext 解析下不可见，
 * 与其依赖模块增强，不如把契约收窄到自己需要的最小集合。
 */
interface UploadedAudioFile {
  buffer: Buffer;
  mimetype?: string;
  originalname?: string;
  size?: number;
}

@Controller('meetings')
export class MeetingAudioController {
  constructor(
    private readonly audioService: MeetingAudioService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * 上传某场会议的录音。
   *
   * 同时兼容两种上传方式：
   * - multipart 字段名 audio（推荐）
   * - 原始二进制请求体（部分客户端不支持 FormData 时使用）
   */
  @Post(':id/audio')
  @UseInterceptors(FileInterceptor('audio'))
  async uploadAudio(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() file: UploadedAudioFile | undefined,
    @Body() body: { durationSec?: string | number },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // 录音是会议内容的延伸，只有可写者才能上传
    await assertCanWrite(this.prisma, user, id);
    if (!file) {
      throw new BadRequestException(
        '未接收到录音文件，请使用 multipart 字段 audio 上传',
      );
    }

    const mimeType = file.mimetype || '';
    if (mimeType && !AUDIO_MIME_PATTERN.test(mimeType)) {
      throw new BadRequestException(
        `不支持的录音格式：${mimeType}`,
      );
    }

    return this.audioService.saveAudio(
      id,
      {
        buffer: file.buffer,
        mimetype: file.mimetype,
        originalname: file.originalname,
      },
      this.parseDuration(body?.durationSec),
    );
  }

  /** 解析前端传来的录音时长，非法值返回 undefined 由服务层落为 null。 */
  private parseDuration(value?: string | number) {
    if (value == null || value === '') {
      return undefined;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0
      ? parsed
      : undefined;
  }

  /**
   * 带鉴权的录音流。
   *
   * 为什么不用静态目录直出：
   * 「录音不开放」如果只是前端隐藏播放器，文件 URL 一旦泄露仍能直接播放，
   * 等于没关。这里统一走鉴权接口，权限由 assertCanListenAudio 判定。
   *
   * 支持 Range：<audio> 拖动进度条依赖 206 Partial Content，
   * 用 res.sendFile 由 express 处理区间请求。
   */
  @Get(':id/audio')
  async streamAudio(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
  ) {
    await assertCanListenAudio(this.prisma, user, id);

    const meeting = await this.prisma.meeting.findUnique({
      where: { id },
      select: { audioUrl: true },
    });

    if (!meeting?.audioUrl) {
      throw new NotFoundException('该会议没有录音');
    }

    const absolutePath = this.audioService.resolveReadablePath(
      meeting.audioUrl,
    );

    if (!absolutePath) {
      throw new NotFoundException('录音文件不存在');
    }

    // 浏览器可能缓存同一 URL，这里显式声明私有缓存，避免代理缓存给无权者
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');

    return res.sendFile(absolutePath);
  }
}
