import type { NextFunction, Request, Response } from 'express';

/**
 * 按来源 IP 的滑动窗口限流。
 *
 * 定位是**兜底**，不是精细配额：阈值远高于正常使用，只拦得住脚本刷接口
 * 和暴力尝试登录。真正需要花钱保护的是 AI 生成，那部分按用户单独算
 * 日配额（见 AiService）。
 *
 * 为什么不用 @nestjs/throttler：它默认按 `req.ip`，而经过 nginx 反代之后
 * req.ip 永远是网关容器地址，所有用户共享一个桶，等于没限。这里直接读
 * nginx 设的 `X-Real-IP`（客户端伪造的同名头会被 nginx 覆盖）。
 */
export interface RateLimitOptions {
  /** 窗口长度（毫秒） */
  windowMs: number;
  /** 窗口内允许的请求数 */
  limit: number;
  /** 返回 true 的请求不参与限流，用于健康检查等 */
  skip?: (req: Request) => boolean;
  /**
   * 自定义分桶键。返回 null 时退回按 IP。
   *
   * 存在的意义：只按 IP 分桶时，办公网几十个人共用一个出口 IP，
   * 人均配额被稀释到个位数，正常使用就会撞 429 —— 而且用户完全
   * 不知道是同事把额度用掉了。
   */
  keyOf?: (req: Request) => string | null;
}

const clientIp = (req: Request): string => {
  const real = req.headers['x-real-ip'];

  if (typeof real === 'string' && real) {
    return real;
  }

  return req.socket.remoteAddress ?? 'unknown';
};

export const createRateLimit = ({
  windowMs,
  limit,
  skip,
  keyOf,
}: RateLimitOptions) => {
  /** key → 命中时间戳（升序） */
  const buckets = new Map<string, number[]>();
  let lastSweep = Date.now();

  return (req: Request, res: Response, next: NextFunction) => {
    if (skip?.(req)) {
      next();

      return;
    }

    const now = Date.now();

    /**
     * 每分钟清一次过期 key。
     * 限流器自己不能变成内存泄漏源 —— 扫描一次的成本远低于
     * 让 Map 随着不同 IP 无限增长。
     */
    if (now - lastSweep > 60_000) {
      for (const [key, hits] of buckets) {
        const last = hits[hits.length - 1];

        if (last === undefined || now - last >= windowMs) {
          buckets.delete(key);
        }
      }

      lastSweep = now;
    }

    const key = keyOf?.(req) ?? clientIp(req);
    const hits = (buckets.get(key) ?? []).filter((time) => now - time < windowMs);

    if (hits.length >= limit) {
      const retryAfter = Math.max(
        1,
        Math.ceil((windowMs - (now - hits[0])) / 1000),
      );

      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({
        statusCode: 429,
        message: `请求过于频繁，请 ${retryAfter} 秒后再试`,
      });

      return;
    }

    hits.push(now);
    buckets.set(key, hits);
    next();
  };
};
