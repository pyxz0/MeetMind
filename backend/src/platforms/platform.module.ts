import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma.module';
import { MeetingsModule } from '../meetings/meetings.module';
import { PlatformCoreModule } from './platform-core.module';
import { PlatformEventService } from './platform-event.service';
import { PlatformWebhookController } from './platform-webhook.controller';
import { PlatformController } from './platform.controller';

/**
 * 会议平台接入（回调与事件处理）。
 *
 * 依赖连线上刻意保持单向：
 *   PlatformModule → MeetingsModule（复用录音存储）
 *   将来 MeetingsModule → PlatformCoreModule（会前同步）
 * 两者不会互相 import，避免 Nest 的循环依赖报错。
 */
@Module({
  imports: [PrismaModule, PlatformCoreModule, MeetingsModule],
  controllers: [PlatformWebhookController, PlatformController],
  providers: [PlatformEventService],
  exports: [PlatformEventService],
})
export class PlatformModule {}
