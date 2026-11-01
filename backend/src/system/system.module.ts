import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma.module';
import { JobRunService } from './job-run.service';
import { SystemController } from './system.controller';

/**
 * 后台任务的可观测性。
 *
 * 只依赖 Prisma，不反向依赖任何业务模块 ——
 * InboxModule / NotificationsModule 都来注入它的 JobRunService。
 */
@Module({
  imports: [PrismaModule],
  controllers: [SystemController],
  providers: [JobRunService],
  exports: [JobRunService],
})
export class SystemModule {}
