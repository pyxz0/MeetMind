import { Module } from '@nestjs/common';
import { TencentPlatformProvider } from './providers/tencent.provider';
import { MockPlatformProvider } from './providers/mock.provider';
import { DisabledPlatformProvider } from './providers/disabled.provider';
import type { MeetingPlatformProvider } from './platform-provider';

/** 注入令牌：业务层注入它，而不是注入具体厂商的类 */
export const PLATFORM_PROVIDER = 'MEETING_PLATFORM_PROVIDER';

/**
 * 平台适配层核心。
 *
 * 单独成模块是为了打断循环依赖：
 *   MeetingsModule 需要 provider 做会前同步，
 *   PlatformModule（webhook）又需要 MeetingsModule 的录音存储。
 * 把 provider 抽到这里，两边都只依赖它，谁也不依赖谁。
 */
@Module({
  providers: [
    TencentPlatformProvider,
    MockPlatformProvider,
    DisabledPlatformProvider,
    {
      provide: PLATFORM_PROVIDER,
      inject: [
        TencentPlatformProvider,
        MockPlatformProvider,
        DisabledPlatformProvider,
      ],
      useFactory: (
        tencent: TencentPlatformProvider,
        mock: MockPlatformProvider,
        disabled: DisabledPlatformProvider,
      ): MeetingPlatformProvider => {
        const mode = (process.env.MEETING_PLATFORM ?? '').trim().toLowerCase();

        if (mode === 'tencent') {
          // 凭据不全时仍然返回真实实现：enabled=false 让业务层给出
          // 「还没配置完整」的提示，比静默降级成 mock 安全得多
          return tencent;
        }

        if (mode === 'mock') {
          return mock;
        }

        return disabled;
      },
    },
  ],
  exports: [PLATFORM_PROVIDER],
})
export class PlatformCoreModule {}
