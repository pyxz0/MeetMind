import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  /** 提供最简根路由响应，用于确认 Nest 服务已启动。 */
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
}
