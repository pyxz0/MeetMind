import { createHmac } from 'node:crypto';
import { readBearerSubject } from './bearer-subject';

/**
 * 这里只关心「限流分桶」需要的那一点：能不能安全地取出用户 id。
 * 签名的正确性由真实登录流程保证，这里验证的是**失败时一律返回 null**，
 * 因为把非法令牌解析成某个用户，会让限流算到别人头上。
 */
const SECRET = 'test-secret-value';

const b64 = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

const sign = (
  payload: Record<string, unknown>,
  secret = SECRET,
  alg = 'HS256',
) => {
  const header = b64({ alg, typ: 'JWT' });
  const body = b64(payload);
  const signature = createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url');

  return `${header}.${body}.${signature}`;
};

describe('readBearerSubject', () => {
  it('正常令牌能取出用户 id', () => {
    const token = sign({ sub: 42, role: 'USER' });

    expect(readBearerSubject(`Bearer ${token}`, SECRET)).toBe(42);
  });

  it('大小写与多余空格不影响', () => {
    const token = sign({ sub: 7 });

    expect(readBearerSubject(`bearer ${token}`, SECRET)).toBe(7);
  });

  it('签名不匹配时返回 null', () => {
    const token = sign({ sub: 42 }, 'other-secret');

    expect(readBearerSubject(`Bearer ${token}`, SECRET)).toBeNull();
  });

  it('篡改 payload 后返回 null', () => {
    const token = sign({ sub: 42 });
    const [header, , signature] = token.split('.');
    const forged = `${header}.${b64({ sub: 1 })}.${signature}`;

    expect(readBearerSubject(`Bearer ${forged}`, SECRET)).toBeNull();
  });

  it('alg 不是 HS256 一律拒绝（含 alg=none）', () => {
    const noneToken = `${b64({ alg: 'none' })}.${b64({ sub: 42 })}.`;

    expect(readBearerSubject(`Bearer ${noneToken}`, SECRET)).toBeNull();
    expect(readBearerSubject(`Bearer ${sign({ sub: 42 }, SECRET, 'HS512')}`, SECRET)).toBeNull();
  });

  it('过期令牌返回 null', () => {
    const expired = sign({ sub: 42, exp: Math.floor(Date.now() / 1000) - 10 });

    expect(readBearerSubject(`Bearer ${expired}`, SECRET)).toBeNull();
  });

  it('缺少 secret / 头 / 格式不对时返回 null', () => {
    const token = sign({ sub: 42 });

    expect(readBearerSubject(`Bearer ${token}`, '')).toBeNull();
    expect(readBearerSubject(`Bearer ${token}`, undefined)).toBeNull();
    expect(readBearerSubject(undefined, SECRET)).toBeNull();
    expect(readBearerSubject(token, SECRET)).toBeNull();
    expect(readBearerSubject('Bearer a.b.c', SECRET)).toBeNull();
    expect(readBearerSubject('Bearer ', SECRET)).toBeNull();
  });

  it('sub 不是数字时返回 null', () => {
    expect(readBearerSubject(`Bearer ${sign({ sub: '42' })}`, SECRET)).toBeNull();
  });
});
