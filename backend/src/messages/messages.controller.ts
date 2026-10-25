import {
  BadRequestException,
  Body,
  Controller,
  Get,
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
import { MessagesService } from './messages.service';
import { CurrentUser, type AuthenticatedUser } from '../auth/auth.decorators';
import { OpenConversationDto } from './messages.dto';

/** 私信附件根目录 */
const MESSAGE_DIR = join(process.cwd(), 'uploads', 'messages');

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** 图片扩展名（聊天里直接预览）；其余走文件下载 */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

const ALLOWED_EXTENSIONS = new Set([
  ...IMAGE_EXTENSIONS,
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.txt', '.md', '.csv', '.zip', '.rar', '.7z',
]);

const storage = diskStorage({
  destination: (request, _file, callback) => {
    const conversationId = String(request.params?.id ?? 'unknown');
    const dir = join(MESSAGE_DIR, conversationId);

    mkdirSync(dir, { recursive: true });
    callback(null, dir);
  },
  filename: (_request, file, callback) => {
    const extension = extname(file.originalname ?? '').toLowerCase();
    callback(null, `${randomUUID()}${extension}`);
  },
});

@Controller('messages')
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  /** 我的会话列表 */
  @Get('conversations')
  listConversations(@CurrentUser() user: AuthenticatedUser) {
    return this.messages.listConversations(user);
  }

  /** 未读总数（导航角标） */
  @Get('unread-total')
  unreadTotal(@CurrentUser() user: AuthenticatedUser) {
    return this.messages.unreadTotal(user);
  }

  /** 发起或进入与某人的会话 */
  @Post('conversations')
  openConversation(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: OpenConversationDto,
  ) {
    return this.messages.openConversation(user, dto.peerId);
  }

  /** 某会话的消息列表（拉取即已读） */
  @Get('conversations/:id/messages')
  listMessages(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.messages.listMessages(user, id);
  }

  /**
   * 发消息：multipart 表单，text 字段是文字内容、kind 是类型、file 是可选附件。
   * 纯文字消息不传 file；图片/文件消息至少传一个 file。
   */
  @Post('conversations/:id/messages')
  @UseInterceptors(
    FileInterceptor('file', {
      storage,
      limits: { fileSize: MAX_ATTACHMENT_BYTES },
    }),
  )
  async sendMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { content?: string; kind?: string },
    @UploadedFile() file?: Express.Multer.File,
  ) {
    let attachments: Array<{
      originalname: string;
      mimetype: string;
      size: number;
      path: string;
      filename: string;
      isImage: boolean;
    }> = [];

    if (file) {
      const extension = extname(file.originalname ?? '').toLowerCase();

      if (!ALLOWED_EXTENSIONS.has(extension)) {
        await unlink(file.path).catch(() => undefined);
        throw new BadRequestException(`不支持的文件类型：${extension || '未知'}`);
      }

      attachments = [
        {
          originalname: file.originalname,
          mimetype: file.mimetype,
          size: file.size,
          path: file.path,
          filename: file.filename,
          isImage: IMAGE_EXTENSIONS.has(extension),
        },
      ];
    }

    try {
      return await this.messages.sendMessage(
        user,
        id,
        {
          content: body?.content,
          kind: (body?.kind as 'TEXT' | 'IMAGE' | 'FILE') ?? (file ? 'FILE' : 'TEXT'),
        },
        attachments,
      );
    } catch (error) {
      // 落盘但业务校验失败时清理，避免孤儿文件
      if (file) await unlink(file.path).catch(() => undefined);
      throw error;
    }
  }

  /** 鉴权下载附件：只允许会话双方 */
  @Get('attachments/:attachmentId')
  async download(
    @Param('attachmentId', ParseIntPipe) attachmentId: number,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
  ) {
    const attachment = await this.messages.resolveAttachment(user, attachmentId);

    if (!existsSync(attachment.absolutePath)) {
      throw new BadRequestException('附件文件已丢失');
    }

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
