import { Global, Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { PrismaModule } from '../common/prisma.module';

/**
 * 审计模块。
 *
 * 设为 @Global：任何业务 Service 都可以直接注入 AuditService 记录操作，
 * 不必逐个模块 import，避免为了记一行日志去改十几个 module。
 */
@Global()
@Module({
  imports: [PrismaModule],
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
