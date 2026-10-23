import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import {
  ConfirmPasswordResetDto,
  LoginDto,
  PasswordResetTokenDto,
  RequestPasswordResetDto,
  RegisterDto,
  UpdateProfileDto,
} from './dto/auth.dto';
import { CurrentUser, Public, type AuthenticatedUser } from './auth.decorators';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /** 登录：手机号 + 密码换取 JWT */
  @Public()
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto.phone, dto.password);
  }

  /** 自助注册，固定为普通用户 */
  @Public()
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  /**
   * 自助找回第一步：提交绑定邮箱，由后端发一次性链接（公开）。
   *
   * 无论邮箱是否绑定账号都返回同一句话，避免被用来枚举账号。
   */
  @Public()
  @Post('password-reset/request')
  requestPasswordReset(@Body() dto: RequestPasswordResetDto) {
    return this.authService.requestPasswordReset(dto.email);
  }

  /**
   * 校验密码重置链接（公开）。
   *
   * 链接来自管理员在用户管理里生成的一次性令牌，
   * 页面加载时先调这里，避免用户填完两次密码才被告知链接已过期。
   */
  @Public()
  @Post('password-reset/inspect')
  inspectPasswordReset(@Body() dto: PasswordResetTokenDto) {
    return this.authService.inspectPasswordReset(dto.token);
  }

  /**
   * 用重置令牌设置新密码（公开）。
   *
   * 成功后令牌立即作废，且该账号此前签发的所有会话一并失效。
   */
  @Public()
  @Post('password-reset/confirm')
  confirmPasswordReset(@Body() dto: ConfirmPasswordResetDto) {
    return this.authService.confirmPasswordReset(dto.token, dto.password);
  }

  /** 当前登录用户信息与权限位，前端据此渲染菜单和按钮 */
  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.getProfile(user.id);
  }

  /**
   * 修改自己的资料（个人中心）。
   *
   * 只要求登录，不要求 user:manage —— 普通用户也需要能改自己的密码。
   * 可改字段被限制为姓名与密码，手机号/角色/启停由管理员处理。
   */
  @Patch('me')
  updateMe(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.authService.updateOwnProfile(user, dto);
  }
}