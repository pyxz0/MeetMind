
import { Module } from '@nestjs/common'
import { MeetingsController } from './meetings.controller'
import { MeetingsService } from './meetings.service'
import { MeetingAudioController } from './meeting-audio.controller'
import { MeetingAudioService } from './meeting-audio.service'
import { PrismaModule } from '../common/prisma.module'

@Module({
  imports: [PrismaModule],
  controllers: [MeetingsController, MeetingAudioController],
  providers: [MeetingsService, MeetingAudioService],
})
export class MeetingsModule {}
