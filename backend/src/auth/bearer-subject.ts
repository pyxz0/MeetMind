import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * 从 Authorization 头里取出用户 id，**只用于限流分桶**。
 *
 * 为什么这里自己验签而不复用 JwtAuthGuard：
 * 限流是全局中间件，跑在守卫之前，那时 req.user 还没被填充。
 * 而「按用户分桶」是必需的 —— 全局限流原来只按 IP，办公网几十个人
 * 共享一个出口 IP 时，人均配额被稀释成个位数，正常使用会莫名 429。
 *
 * 验签用 node:crypto 直接算 HMAC，不引第三方库、不查库：
 * 这是每个请求都会走的热路径，一次 HS256 大约几十微秒。
 *
 * 任何异常都返回 null（退化成按 IP 限流），绝不让限流器把请求打挂。
 */
interface JwtHeader {
  alg?: string;
}

interface JwtPayload {
  sub?: unknown;
  exp?: unknown;
}

const decodeJson = <T>(text: string): T | null => {
  try {
    return JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
};

export const readBearerSubject = (
  authorization: string | undefined,
  secret: string | undefined,
  now: number = Date.now(),
): number | null => {
  if (!authorization || !secret) {
    return null;
  }

  const [scheme, token] = authorization.split(' ');

  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) {
    return null;
  }

  const parts = token.split('.');

  if (parts.length !== 3) {
    return null;
  }

  const [headerText, payloadText, signature] = parts;
  const header = decodeJson<JwtHeader>(headerText);

  // 只接受 HS256：不校验 alg 会让「把 alg 改成 none」的令牌绕过签名
  if (!header || header.alg !== 'HS256') {
    return null;
  }

  const expected = createHmac('sha256', secret)
    .update(`${headerText}.${payloadText}`)
    .digest('base64url');

  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);

  if (
    expectedBuf.length !== actualBuf.length ||
    !timingSafeEqual(expectedBuf, actualBuf)
  ) {
    return null;
  }

  const payload = decodeJson<JwtPayload>(payloadText);

  if (!payload) {
    return null;
  }

  if (typeof payload.exp === 'number' && payload.exp * 1000 <= now) {
    return null;
  }

  return typeof payload.sub === 'number' ? payload.sub : null;
};
