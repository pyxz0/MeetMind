import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { createRateLimit } from './common/rate-limit.middleware';
import { readBearerSubject } from './auth/bearer-subject';

/** 录音文件的存放目录，与 MeetingAudioService 使用同一规则 */
const UPLOAD_DIR = join(process.cwd(), 'uploads');

async function bootstrap() {
  /**
   * rawBody：平台回调（飞书 / 企业微信）的签名是对**原始请求体**算的。
   * 请求体一旦被 body-parser 反序列化，再序列化时字段顺序、空格、转义都可能变，
   * 验签会永远失败，而报错只会是"签名不匹配"，极难排查。
   *
   * 开启后每个请求额外挂一个 req.rawBody（Buffer），只给验签用，
   * 不影响现有的 JSON 解析（req.body 照常可用）。
   */
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  /**
   * 请求体上限调到 1MB。
   *
   * 默认 100KB 放不下「data URL 头像」：前端会把图压到 15–30KB，
   * 但有人换用原图时，超过限制会抛 PayloadTooLarge，
   * 最终被异常过滤器包成 500，看起来像服务出错。
   * 放开到 1MB 后，超限改由 DTO 的长度校验给出 400 与中文提示。
   */
  app.useBodyParser('json', { limit: '1mb' });

  app.setGlobalPrefix('api');

  /**
   * CORS：配置了 CORS_ORIGIN 就只放开这些来源（逗号分隔），
   * 未配置时保持放开，方便本地前后端分离调试。
   */
  const origins = (process.env.CORS_ORIGIN ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  app.enableCors(origins.length ? { origin: origins } : {});

  // 每个请求生成 requestId，写回响应头，异常响应与日志都用它串联
  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = randomUUID();

    (req as Request & { requestId?: string }).requestId = requestId;
    res.setHeader('X-Request-Id', requestId);

    next();
  });

  /**
   * 全局兜底限流：默认 600 次/分钟，**已登录按用户、未登录按 IP**。
   *
   * 为什么不再只按 IP：办公网几十个人共用一个出口 IP 时，
   * 人均额度被稀释成个位数，正常翻页就会撞 429，而用户只会看到
   * 「请求过于频繁」，根本想不到是同事在用。
   *
   * 阈值可以用 RATE_LIMIT_MAX 覆盖，改之前不用重新构建镜像。
   * 健康检查豁免：监控探测很频繁，别把它算进额度。
   */
  const rateLimitMax = Number(process.env.RATE_LIMIT_MAX ?? 600);
  const jwtSecret = process.env.JWT_SECRET ?? '';

  app.use(
    createRateLimit({
      windowMs: 60_000,
      limit: Number.isFinite(rateLimitMax) && rateLimitMax > 0 ? rateLimitMax : 600,
      skip: (req) => req.path === '/api' || req.path === '/api/health',
      keyOf: (req) => {
        const userId = readBearerSubject(req.headers.authorization, jwtSecret);

        return userId === null ? null : `u:${userId}`;
      },
    }),
  );

  /**
   * 认证接口单独更严：默认 30 次/分钟/IP。
   *
   * 登录每次都要算一次 KDF（约 120ms CPU），按压测数据这台 2 核机器
   * 满打满算 17 次/秒 —— 也就是说，光靠全局的 600/min 就足以让
   * 有人用登录接口把 CPU 打满。这一层是专门堵这个口子的。
   */
  const authLimit = Number(process.env.RATE_LIMIT_AUTH_MAX ?? 30);

  app.use(
    [
      '/api/auth/login',
      '/api/auth/register',
      '/api/auth/password-reset/request',
      '/api/auth/password-reset/inspect',
      '/api/auth/password-reset/confirm',
    ],
    createRateLimit({
      windowMs: 60_000,
      limit: Number.isFinite(authLimit) && authLimit > 0 ? authLimit : 30,
    }),
  );

  /**
   * 全局参数校验：
   * - whitelist 去掉 DTO 未声明的字段
   * - forbidNonWhitelisted 遇到多余字段直接 400，避免悄悄忽略拼错的参数
   * - transform 让 query/param 按 DTO 类型转换
   */
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());

  // 首次启动时创建录音目录，避免写入时目录不存在
  mkdirSync(UPLOAD_DIR, { recursive: true });

  const port = Number(process.env.PORT ?? 3000);

  await app.listen(port);
}

// 启动失败要退出并打印原因，否则容器会静默卡在"运行中"
bootstrap().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('后端启动失败：', error);
  process.exit(1);
});