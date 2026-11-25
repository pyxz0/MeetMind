import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { TenantsService } from './tenants.service';
import {
  CreateInviteDto,
  CreateTenantDto,
  SwitchTenantDto,
} from './dto/tenants.dto';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../auth/auth.decorators';

/**
 * 租户（工作空间）管理。
 *
 * 这些接口**不加权限位**：个人用户也要能建自己的企业，
 * 而权限位来自租户角色 —— 建企业之前他只有个人空间的 OWNER，
 * 用 MEETING_* 之类的权限位拦反而会把正常路径堵死。
 * 真正的约束在服务层：一人一企业、移除成员的规则。
 */
@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  /**
   * 我的空间列表（前端切换器）。
   *
   * 必须声明在 `:id` 路由之前，否则 `mine` 会被当成 UUID 解析。
   */
  @Get('mine')
  listMine(@CurrentUser() user: AuthenticatedUser) {
    return this.tenants.listMine(user);
  }

  /** 创建企业空间，创建者自动成为所有者并切换过去 */
  @Post()
  create(
    @Body() dto: CreateTenantDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tenants.create(user, dto);
  }

  /**
   * 切换当前浏览的空间。
   *
   * 放在这里而不是 `/auth/active-tenant`：AuthModule 是全局基础模块，
   * 不该反过来依赖业务模块。语义上也更像"空间操作"而不是"认证操作"。
   */
  @Patch('active')
  switchActive(
    @Body() dto: SwitchTenantDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tenants.switchActive(user, dto.tenantId);
  }

  /** 成员列表（仅 OWNER / ADMIN） */
  @Get(':id/members')
  listMembers(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tenants.listMembers(user, id);
  }

  /** 移除成员（仅 OWNER / ADMIN，且不能移除 OWNER） */
  @Delete(':id/members/:userId')
  removeMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseIntPipe) userId: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tenants.removeMember(user, id, userId);
  }

  /**
   * 生成邀请链接。
   *
   * 返回的 token 是明文，**只出现这一次** —— 库里只存哈希，
   * 想再要只能重新生成。管理员应当场复制走。
   */
  @Post(':id/invites')
  createInvite(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateInviteDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tenants.createInvite(user, id, dto);
  }

  /** 已发出的邀请（不含令牌，无法还原成链接） */
  @Get(':id/invites')
  listInvites(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tenants.listInvites(user, id);
  }

  /** 撤销邀请：链接立刻失效 */
  @Delete(':id/invites/:inviteId')
  revokeInvite(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('inviteId', ParseIntPipe) inviteId: number,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tenants.revokeInvite(user, id, inviteId);
  }
}
