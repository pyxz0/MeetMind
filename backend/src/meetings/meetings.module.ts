import { Module } from '@nestjs/common';
import { MeetingsController } from './meetings.controller';
import { MeetingsService } from './meetings.service';

// 将会议路由控制器与其业务服务组织为独立功能模块。
@Module({
  controllers: [MeetingsController],
  providers: [MeetingsService],
})
export class MeetingsModule {}
