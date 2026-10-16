import {
  BadRequestException,
  Body,
  Controller,
  Param,
  ParseIntPipe,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MeetingAudioService } from './meeting-audio.service';

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
  ) {
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
}
