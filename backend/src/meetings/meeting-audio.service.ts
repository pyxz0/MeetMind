import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { existsSync } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../common/prisma.service';

/**
 * 允许的音频扩展名。
 *
 * 以浏览器实际产出的容器为准：
 * Chrome / Edge 录制 webm(opus)，Safari 录制 mp4(aac)，
 * Firefox 录制 ogg(opus)。
 */
const ALLOWED_EXTENSIONS = ['.webm', '.ogg', '.mp4', '.m4a', '.wav'] as const;

/** 单场会议录音的体积上限，避免异常请求把磁盘写满。 */
export const MAX_AUDIO_BYTES = 200 * 1024 * 1024;

/** 以 .env 的 DATABASE_URL 同级的 backend 目录为基准存放录音。 */
const UPLOAD_DIR = join(process.cwd(), 'uploads');

@Injectable()
export class MeetingAudioService {
  constructor(private readonly prisma: PrismaService) {}

  /** 确保上传目录存在，供启动时和写入前调用。 */
  async ensureUploadDir() {
    await mkdir(UPLOAD_DIR, { recursive: true });
  }

  /** 上传目录的绝对路径，main.ts 用它注册静态资源服务。 */
  getUploadDir() {
    return UPLOAD_DIR;
  }

  /** 校验会议是否存在，避免把音频写到不存在的记录上。 */
  async assertMeetingExists(meetingId: number) {
    const meeting = await this.prisma.meeting.findUnique({
      where: { id: meetingId },
      select: { id: true },
    });

    if (!meeting) {
      throw new NotFoundException('会议记录不存在');
    }
  }

  /**
   * 保存会议录音并把相对路径写回数据库。
   *
   * 重复上传会替换旧文件，同时删除磁盘上的旧录音，避免残留孤儿文件。
   */
  async saveAudio(
    meetingId: number,
    file: { buffer: Buffer; mimetype?: string; originalname?: string },
    durationSec?: number,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('录音内容不能为空');
    }

    if (file.buffer.length > MAX_AUDIO_BYTES) {
      throw new BadRequestException('录音文件过大，单场会议上限 200MB');
    }

    await this.assertMeetingExists(meetingId);
    await this.ensureUploadDir();

    // 扩展名优先取客户端文件名，其次按 MIME 推断，最后兜底 webm。
    const extension = this.resolveExtension(
      file.originalname,
      file.mimetype,
    );

    const filename = `${randomUUID()}${extension}`;
    const absolutePath = join(UPLOAD_DIR, filename);

    // 相对于 backend 的运行目录保存，便于换机器后仍能定位。
    const relativePath = join('uploads', filename).replace(/\\/g, '/');

    await writeFile(absolutePath, file.buffer);

    const previous = await this.prisma.meeting.findUnique({
      where: { id: meetingId },
      select: { audioUrl: true },
    });

    const updated = await this.prisma.meeting.update({
      where: { id: meetingId },
      data: {
        audioUrl: relativePath,
        audioDurationSec:
          durationSec != null && Number.isFinite(durationSec) && durationSec >= 0
            ? Math.round(durationSec)
            : null,
      },
      select: {
        id: true,
        audioUrl: true,
        audioDurationSec: true,
      },
    });

    // 数据库写入成功后再清理旧文件；失败也不影响本次结果。
    if (previous?.audioUrl && previous.audioUrl !== relativePath) {
      await this.removeAudioFile(previous.audioUrl);
    }

    return {
      id: updated.id,
      audioUrl: updated.audioUrl,
      audioDurationSec: updated.audioDurationSec,
      size: file.buffer.length,
    };
  }

  /** 删除会议时一并清理磁盘录音，避免文件越积越多。 */
  async removeAudioByMeetingId(meetingId: number) {
    const meeting = await this.prisma.meeting.findUnique({
      where: { id: meetingId },
      select: { audioUrl: true },
    });

    if (meeting?.audioUrl) {
      await this.removeAudioFile(meeting.audioUrl);
    }
  }

  /** 删除单个录音文件；文件已不存在时静默返回。 */
  async removeAudioFile(relativePath: string) {
    // 只允许删除 uploads 目录内的文件，防止路径穿越删到项目其他文件。
    const normalized = relativePath.replace(/\\/g, '/');
    if (!normalized.startsWith('uploads/')) {
      return;
    }

    const filename = normalized.slice('uploads/'.length);
    if (!filename || filename.includes('/') || filename.includes('..')) {
      return;
    }

    try {
      await unlink(join(UPLOAD_DIR, filename));
    } catch {
      // 文件不存在或已被删除，无需处理。
    }
  }

  /** 录音是否可读，供流式播放接口判断。 */
  resolveReadablePath(relativePath: string) {
    const normalized = relativePath.replace(/\\/g, '/');
    if (!normalized.startsWith('uploads/')) {
      return null;
    }

    const filename = normalized.slice('uploads/'.length);
    if (!filename || filename.includes('/') || filename.includes('..')) {
      return null;
    }

    const absolutePath = join(UPLOAD_DIR, filename);
    return existsSync(absolutePath) ? absolutePath : null;
  }

  private resolveExtension(
    originalName?: string,
    mimeType?: string,
  ) {
    const fromName = originalName
      ? extname(originalName).toLowerCase()
      : '';

    if (
      ALLOWED_EXTENSIONS.includes(
        fromName as (typeof ALLOWED_EXTENSIONS)[number],
      )
    ) {
      return fromName;
    }

    const mimeMap: Record<string, string> = {
      'audio/webm': '.webm',
      'audio/ogg': '.ogg',
      'audio/mp4': '.mp4',
      'audio/mpeg': '.mp4',
      'audio/aac': '.m4a',
      'audio/wav': '.wav',
      'audio/x-wav': '.wav',
    };

    return mimeMap[mimeType || ''] || '.webm';
  }
}
