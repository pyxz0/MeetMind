import { Controller, Get, Query } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditQueryDto } from './dto/audit.dto';
import {
  RequirePermissions,
  CurrentUser,
  type AuthenticatedUser,
} from '../auth/auth.decorators';
import { PERMISSIONS } from '../auth/permissions';

@Controller('audit-logs')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  /**
   * 审计日志列表。
   *
   * 只对具备 audit:read 的角色开放（管理员及以上）。
   */
  @Get()
  @RequirePermissions(PERMISSIONS.AUDIT_READ)
  list(@Query() query: AuditQueryDto, @CurrentUser() _user: AuthenticatedUser) {
    return this.auditService.list(query);
  }
}
