import { createHash, randomBytes } from 'node:crypto';

/**
 * 重置链接有效期。
 *
 * 30 分钟：够管理员把链接发到微信/企微，也够用户在会议间隙点开，
 * 同时把「链接被截图传出去」的窗口压到最小。
 */
export const RESET_TOKEN_TTL_MINUTES = 30;

/** 生成 256 位随机令牌，base64url 便于放进链接而不需要再转义 */
export const createResetToken = (): string => randomBytes(32).toString('base64url');

/**
 * 令牌只以 SHA-256 入库。
 *
 * 数据库被读走时（备份、误配的只读账号）也拿不到可用的重置链接；
 * 重置是一次性动作，不需要原文可比对。
 */
export const hashResetToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');
