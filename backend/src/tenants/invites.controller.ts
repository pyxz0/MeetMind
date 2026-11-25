import { Body, Controller, Post } from '@nestjs/common';
import { TenantsService } from './tenants.service';
import { InviteTokenDto } from './dto/tenants.dto';
import {
  CurrentUser,
  Public,
  type AuthenticatedUser,
} from '../auth/auth.decorators';

/**
 * 邀请链接的接受端。
 *
 * 单独一个控制器、单独的前缀，理由有两条：
 * - `inspect` 必须**公开**（未登录也要能看到"你被邀请加入某某公司"），
 *   放在租户管理里会让"这个控制器整体需要登录"的直觉失效；
 * - `/tenants/invites/*` 与 `/tenants/:id/*` 段数相同，靠声明顺序区分太脆弱。
 *
 * 页面路径是 `/join/:token`，前端拿到 token 后调这两个接口。
 */
@Controller('invites')
export class InvitesController {
  constructor(private readonly tenants: TenantsService) {}

  /**
   * 校验令牌，返回展示信息（公开）。
   *
   * 只返回企业名、角色、脱敏手机号和是否可用 ——
   * 不返回企业 id 与邀请人信息，避免这个公开接口变成探测工具。
   */
  @Public()
  @Post('inspect')
  inspect(@Body() dto: InviteTokenDto) {
    return this.tenants.inspectInvite(dto.token);
  }

  /**
   * 接受邀请（需登录）。
   *
   * 加入后会把这个空间设为当前空间 —— 前端随后要调一次 /auth/me
   * 才能拿到新的权限位（角色可能从"无空间"变成 MEMBER）。
   */
  @Post('accept')
  accept(
    @Body() dto: InviteTokenDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tenants.acceptInvite(user, dto.token);
  }
}
