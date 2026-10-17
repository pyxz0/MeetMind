import { Body, Controller, Get, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { CurrentUser, Public, type AuthenticatedUser } from './auth.decorators';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /** 登录：邮箱 + 密码换取 JWT */
  @Public()
  @Post('login')
  login(@Body() body: { email?: string; password?: string }) {
    return this.authService.login(body?.email ?? '', body?.password ?? '');
  }

  /** 自助注册，固定为普通用户 */
  @Public()
  @Post('register')
  register(
    @Body() body: { email?: string; password?: string; name?: string },
  ) {
    return this.authService.register({
      email: body?.email ?? '',
      password: body?.password ?? '',
      name: body?.name ?? '',
    });
  }

  /** 当前登录用户信息与权限位，前端据此渲染菜单和按钮 */
  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.getProfile(user.id);
  }
}
