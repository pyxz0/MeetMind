import { Controller, Get, Inject } from '@nestjs/common';
import { PLATFORM_PROVIDER } from './platform-core.module';
import type { MeetingPlatformProvider } from './platform-provider';

/**
 * 平台接入状态。
 *
 * 前端需要知道「腾讯会议到底能不能用」才好决定要不要显示同步勾选框 ——
 * 没配置却给个勾选框，用户勾了发现没链接，比不显示更糟。
 */
@Controller('platforms')
export class PlatformController {
  constructor(
    @Inject(PLATFORM_PROVIDER)
    private readonly platform: MeetingPlatformProvider,
  ) {}

  @Get('status')
  status() {
    const labels: Record<string, string> = {
      tencent: '腾讯会议',
      mock: '腾讯会议（模拟）',
    };

    return {
      /** tencent / mock / off */
      name: this.platform.name,
      /** 能否真正建会；false 时前端不显示同步入口 */
      enabled: this.platform.enabled,
      label: labels[this.platform.name] ?? '',
    };
  }
}
