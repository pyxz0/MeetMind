import type { NextFunction, Request, Response } from 'express';
import { createRateLimit } from './rate-limit.middleware';

/**
 * 限流器最容易错的两处：按错了 key（nginx 后面所有请求同 IP）、
 * 以及限流器自己成了内存泄漏源。这里把判定逻辑用假 req/res 跑一遍。
 */
describe('createRateLimit', () => {
  const makeReq = (ip: string | null, path = '/api/meetings') =>
    ({
      headers: ip ? { 'x-real-ip': ip } : {},
      path,
      socket: { remoteAddress: '172.18.0.5' },
    }) as unknown as Request;

  const makeRes = () => {
    const res = {
      statusCode: 0,
      headers: {} as Record<string, string>,
      body: null as unknown,
      setHeader(name: string, value: string) {
        res.headers[name] = value;

        return res;
      },
      status(code: number) {
        res.statusCode = code;

        return res;
      },
      json(payload: unknown) {
        res.body = payload;

        return res;
      },
    };

    return res as unknown as Response & typeof res;
  };

  const run = (
    mw: (req: Request, res: Response, next: NextFunction) => void,
    req: Request,
  ) => {
    const res = makeRes();
    let called = false;

    mw(req, res as unknown as Response, () => {
      called = true;
    });

    return { res, passed: called };
  };

  it('未超过阈值时放行', () => {
    const mw = createRateLimit({ windowMs: 60_000, limit: 2 });

    expect(run(mw, makeReq('1.1.1.1')).passed).toBe(true);
    expect(run(mw, makeReq('1.1.1.1')).passed).toBe(true);
  });

  it('超过阈值返回 429 并带 Retry-After', () => {
    const mw = createRateLimit({ windowMs: 60_000, limit: 1 });

    run(mw, makeReq('2.2.2.2'));

    const { res, passed } = run(mw, makeReq('2.2.2.2'));

    expect(passed).toBe(false);
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBeTruthy();
    expect((res.body as { message: string }).message).toContain('频繁');
  });

  it('不同 IP 各自计数', () => {
    const mw = createRateLimit({ windowMs: 60_000, limit: 1 });

    expect(run(mw, makeReq('3.3.3.3')).passed).toBe(true);
    // 换个 IP 应该重新计数
    expect(run(mw, makeReq('4.4.4.4')).passed).toBe(true);
    expect(run(mw, makeReq('3.3.3.3')).passed).toBe(false);
  });

  it('优先取 X-Real-IP，没有才回退到 socket 地址', () => {
    const mw = createRateLimit({ windowMs: 60_000, limit: 1 });

    // 没有 X-Real-IP 时用 socket.remoteAddress（所有请求相同）
    expect(run(mw, makeReq(null)).passed).toBe(true);
    expect(run(mw, makeReq(null)).passed).toBe(false);

    // 带了真实 IP 的就独立计数，不受上面那个桶影响
    expect(run(mw, makeReq('5.5.5.5')).passed).toBe(true);
  });

  it('skip 命中的请求不计数', () => {
    const mw = createRateLimit({
      windowMs: 60_000,
      limit: 1,
      skip: (req) => req.path === '/api',
    });

    for (let i = 0; i < 5; i += 1) {
      expect(run(mw, makeReq('6.6.6.6', '/api')).passed).toBe(true);
    }

    expect(run(mw, makeReq('6.6.6.6', '/api/meetings')).passed).toBe(true);
    expect(run(mw, makeReq('6.6.6.6', '/api/meetings')).passed).toBe(false);
  });
});
