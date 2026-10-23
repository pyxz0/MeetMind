import { Module } from '@nestjs/common';
import { AsrController } from './asr.controller';
import { AsrService } from './asr.service';

/**
 * 上传录音 / 会议文件 → 服务端转写。
 *
 * 转写在进程内异步执行（与 AI 生成一致）：单实例部署够用，
 * 多副本时同一任务可能被两个实例轮流处理，届时需要换成队列。
 */
@Module({
  controllers: [AsrController],
  providers: [AsrService],
  exports: [AsrService],
})
export class AsrModule {}
