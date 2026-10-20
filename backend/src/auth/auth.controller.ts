import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto, RegisterDto, UpdateProfileDto } from './dto/auth.dto';
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
    return this.authService.updateOwnProfile(user.id, dto);
  }
}