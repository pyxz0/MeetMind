import { Module } from '@nestjs/common';
import { TenantsController } from './tenants.controller';
import { InvitesController } from './invites.controller';
import { TenantsService } from './tenants.service';

/**
 * 租户（工作空间）模块。
 *
 * PrismaModule / AuthModule / AuditModule 都是全局或已导出，
 * 这里不需要 imports。
 */
@Module({
  controllers: [TenantsController, InvitesController],
  providers: [TenantsService],
  exports: [TenantsService],
})
export class TenantsModule {}
