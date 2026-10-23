import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { createReadStream, mkdirSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { extname, join, relative } from 'node:path';
import { AsrService } from './asr.service';
import { PrismaService } from '../common/prisma.service';
import {
  mimeOf,
  MAX_ASR_FILE_BYTES,
  verifyFileToken,
} from './asr-file-url';
import { PERMISSIONS } from '../auth/permissions';
import {
  CurrentUser,
  Public,
  RequirePermissions,
  type AuthenticatedUser,
} from '../auth/auth.decorators';

/** 上传落盘目录：与会议录音分开，便于单独限流与清理 */
const ASR_DIR = join(process.cwd(), 'uploads', 'asr');

/**
 * 用磁盘存储而不是内存：
 * 一小时的 mp3 动辄五六十 MB，300MB 上限塞进内存会把 2G 的机器打爆。
 */
const storage = diskStorage({
  destination: (_request, _file, callback) => {
    mkdirSync(ASR_DIR, { recursive: true });
    callback(null, ASR_DIR);
  },
  filename: (_request, file, callback) => {
    const extension = extname(file.originalname ?? '').toLowerCase();
    callback(null, `${randomUUID()}${extension}`);
  },
});

@Controller('asr')
export class AsrController {
  constructor(
    private readonly asrService: AsrService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * 上传录音 / 会议文件，创建转写任务。
   *
   * 立即返回任务（PENDING），转写在后台跑，前端轮询 GET /asr/jobs/:id。
   */
  @Post('jobs')
  @RequirePermissions(PERMISSIONS.MEETING_CREATE)
  @UseInterceptors(
    FileInterceptor('file', {
      storage,
      limits: { fileSize: MAX_ASR_FILE_BYTES },
    }),
  )
  upload(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('请选择要上传的文件');
    }

    return this.asrService.createFromUpload(user, {
      originalname: file.originalname,
      // 相对 backend 运行目录保存，换机器后仍能定位
      storedPath: relative(process.cwd(), file.path).replace(/\\/g, '/'),
      sizeBytes: file.size,
    });
  }

  /** 我的上传记录 */
  @Get('jobs')
  @RequirePermissions(PERMISSIONS.MEETING_READ_OWN)
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.asrService.listMine(user);
  }

  /** 任务状态与转写结果 */
  @Get('jobs/:id')
  @RequirePermissions(PERMISSIONS.MEETING_READ_OWN)
  findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.asrService.findOne(id, user);
  }

  @Delete('jobs/:id')
  @RequirePermissions(PERMISSIONS.MEETING_CREATE)
  remove(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.asrService.remove(id, user);
  }

  /**
   * 文件直出（带签名，不需要登录）。
   *
   * 转写服务商是按 URL 拉文件的，所以这条只能公开；
   * 安全性由「jobId + 过期时间 + HMAC」保证，一小时后自动失效。
   */
  @Public()
  @Get('files/:id/:token')
  async download(
    @Param('id', ParseIntPipe) id: number,
    @Param('token') token: string,
  ) {
    if (!verifyFileToken(id, token)) {
      throw new NotFoundException('文件不存在或链接已过期');
    }

    const job = await this.prisma.asrJob.findUnique({
      where: { id },
      select: { storedPath: true, filename: true },
    });

    if (!job) {
      throw new NotFoundException('文件不存在或链接已过期');
    }

    const absolute = join(process.cwd(), job.storedPath);

    try {
      statSync(absolute);
    } catch {
      throw new NotFoundException('文件已被清理');
    }

    return new StreamableFile(createReadStream(absolute), {
      type: mimeOf(job.filename),
      disposition: `inline; filename*=UTF-8''${encodeURIComponent(job.filename)}`,
    });
  }
}
