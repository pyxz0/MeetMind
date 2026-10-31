import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';

@Module({
  controllers: [AiController],
  providers: [AiService],
  // 会议追问挂在 /meetings/:id 下，由 MeetingsModule 复用这里的模型客户端
  exports: [AiService],
})
export class AiModule {}