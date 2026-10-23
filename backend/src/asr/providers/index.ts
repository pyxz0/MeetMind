import type { AsrProvider } from './asr-provider';
import { MockAsrProvider } from './mock-asr.provider';
import { TencentAsrProvider } from './tencent-asr.provider';

/**
 * 按环境变量选转写通道。
 *
 * 优先级：显式 ASR_PROVIDER > 有腾讯云密钥就用腾讯云 > 否则 mock。
 * mock 会把会议内容替换成占位文本，所以启动日志里必须能一眼看出用的是哪个。
 */
export const createAsrProvider = (): AsrProvider => {
  const requested = process.env.ASR_PROVIDER?.trim().toLowerCase();

  if (requested === 'mock') {
    return new MockAsrProvider();
  }

  const secretId = process.env.TENCENT_SECRET_ID?.trim();
  const secretKey = process.env.TENCENT_SECRET_KEY?.trim();

  if (requested === 'tencent' || (secretId && secretKey)) {
    if (!secretId || !secretKey) {
      throw new Error(
        'ASR_PROVIDER=tencent 需要同时配置 TENCENT_SECRET_ID 与 TENCENT_SECRET_KEY',
      );
    }

    return new TencentAsrProvider({
      secretId,
      secretKey,
      region: process.env.TENCENT_ASR_REGION?.trim() || 'ap-guangzhou',
    });
  }

  return new MockAsrProvider();
};
