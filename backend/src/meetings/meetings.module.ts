
import { Module } from '@nestjs/common'
import { MeetingsController } from './meetings.controller'
import { MeetingsService } from './meetings.service'
import { MeetingAudioController } from './meeting-audio.controller'
import { MeetingAudioService } from './meeting-audio.service'
import { MeetingShareController } from './meeting-share.controller'
import { MeetingShareService } from './meeting-share.service'
import { TodoAttachmentController } from './todo-attachment.controller'
import { PrismaModule } from '../common/prisma.module'
import { AiModule } from '../ai/ai.module'
import { PlatformCoreModule } from '../platforms/platform-core.module'

@Module({
  imports: [PrismaModule, AiModule, PlatformCoreModule],
  controllers: [
    MeetingsController,
    MeetingAudioController,
    MeetingShareController,
    TodoAttachmentController,
  ],
  providers: [MeetingsService, MeetingAudioService, MeetingShareService],
  // 平台回调需要复用录音存储（把云录制落到同一套 uploads 里）
  exports: [MeetingAudioService],
})
export class MeetingsModule {}
