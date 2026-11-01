import { Module } from '@nestjs/common';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';
import { PrismaModule } from '../common/prisma.module';
import { SystemModule } from '../system/system.module';

@Module({
  // SystemModule 提供 JobRunService：提醒任务要记录执行结果
  imports: [PrismaModule, SystemModule],
  controllers: [InboxController],
  providers: [InboxService],
})
export class InboxModule {}
