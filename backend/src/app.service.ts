import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  /** 返回根路由的启动提示文本。 */
  getHello(): string {
    return 'Hello World!';
  }
}
