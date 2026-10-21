import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';

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