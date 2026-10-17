
import { Module } from '@nestjs/common'
import { MeetingsController } from './meetings.controller'
import { MeetingsService } from './meetings.service'
import { MeetingAudioController } from './meeting-audio.controller'
import { MeetingAudioService } from './meeting-audio.service'
import { MeetingShareController } from './meeting-share.controller'
import { MeetingShareService } from './meeting-share.service'
import { PrismaModule } from '../common/prisma.module'

@Module({
  imports: [PrismaModule],
  controllers: [
    MeetingsController,
    MeetingAudioController,
    MeetingShareController,
  ],
  providers: [MeetingsService, MeetingAudioService, MeetingShareService],
})
export class MeetingsModule {}
