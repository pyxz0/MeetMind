import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { Public } from './auth/auth.decorators';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  /**
   * 提供最简根路由响应，用于确认 Nest 服务已启动。
   *
   * 显式标为 @Public：健康探测不该需要登录。
   */
  @Public()
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
}
