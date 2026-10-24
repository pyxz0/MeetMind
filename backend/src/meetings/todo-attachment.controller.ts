import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { createReadStream, existsSync, mkdirSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import type { Response } from 'express';
import { MeetingsService } from './meetings.service';
import { CurrentUser, type AuthenticatedUser } from '../auth/auth.decorators';

/** 交付物根目录：与录音、转写文件分开，便于单独限制与清理 */
const ATTACHMENT_DIR = join(process.cwd(), 'uploads', 'todos');

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * 只按扩展名白名单放行。
 *
 * MIME 由客户端给，可以随便伪造；扩展名至少能挡住「把 exe 改名成 pdf」之外的常见误传，
 * 真正的防护是下载时强制 attachment + nosniff，不让浏览器当作页面执行。
 */
const ALLOWED_EXTENSIONS = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.txt', '.md', '.csv', '.zip', '.rar', '.7z',
  '.png', '.jpg', '.jpeg', '.gif', '.webp',
]);

const storage = diskStorage({
  destination: (request, _file, callback) => {
    const submissionId = String(request.params?.id ?? 'unknown');
    const dir = join(ATTACHMENT_DIR, submissionId);

    mkdirSync(dir, { recursive: true });
    callback(null, dir);
  },
  filename: (_request, file, callback) => {
    const extension = extname(file.originalname ?? '').toLowerCase();
    callback(null, `${randomUUID()}${extension}`);
  },
});

@Controller('meetings')
export class TodoAttachmentController {
  constructor(private readonly meetings: MeetingsService) {}

  /** 给某次提交追加交付物（单文件，单次提交最多 5 个） */
  @Post('submissions/:id/attachments')
  @UseInterceptors(
    FileInterceptor('file', {
      storage,
      limits: { fileSize: MAX_ATTACHMENT_BYTES },
    }),
  )
  async upload(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('请选择要上传的文件');
    }

    const extension = extname(file.originalname ?? '').toLowerCase();

    if (!ALLOWED_EXTENSIONS.has(extension)) {
      // 落盘了才发现类型不对，必须把文件删掉，否则会留下没人引用的孤儿
      await unlink(file.path).catch(() => undefined);
      throw new BadRequestException(`不支持的文件类型：${extension || '未知'}`);
    }

    try {
      return await this.meetings.addSubmissionAttachment(
        id,
        {
          originalname: file.originalname,
          mimetype: file.mimetype,
          size: file.size,
          path: file.path,
          filename: file.filename,
        },
        user,
      );
    } catch (error) {
      // 权限不足 / 已验收 / 超过数量：文件同样不能留
      await unlink(file.path).catch(() => undefined);
      throw error;
    }
  }

  /** 鉴权下载：不做静态目录直出，否则「看不到详情」形同虚设 */
  @Get('todos/:todoId/submissions/:submissionId/attachments/:attachmentId')
  async download(
    @Param('todoId', ParseIntPipe) todoId: number,
    @Param('submissionId', ParseIntPipe) submissionId: number,
    @Param('attachmentId', ParseIntPipe) attachmentId: number,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
  ) {
    const attachment = await this.meetings.resolveSubmissionAttachment(
      todoId,
      submissionId,
      attachmentId,
      user,
    );

    if (!existsSync(attachment.absolutePath)) {
      throw new NotFoundException('附件文件已丢失');
    }

    // 中文文件名走 RFC 5987；ASCII 兜底避免老客户端拿到乱码
    const asciiName = attachment.fileName
      .replace(/[^\x20-\x7E]/g, '_')
      .replace(/["\\]/g, '_');

    response.set({
      'Content-Type': attachment.mimeType,
      'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`,
      'X-Content-Type-Options': 'nosniff',
    });

    return new StreamableFile(createReadStream(attachment.absolutePath));
  }
}
