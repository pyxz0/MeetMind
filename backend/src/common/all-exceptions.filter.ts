import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

/** 由请求中间件注入的请求 ID */
interface RequestWithId extends Request {
  requestId?: string;
}

/** HTTP 状态码到业务错误码的映射 */
const STATUS_CODE: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  429: 'TOO_MANY_REQUESTS',
  500: 'INTERNAL_ERROR',
};

/**
 * 统一异常响应。
 *
 * 输出结构固定为 { code, message, statusCode, path, requestId, timestamp }：
 * - code 供程序判断，message 供人阅读（前端已有代码读 message，保持不变）
 * - requestId 贯穿日志，便于按一次请求排查
 *
 * 参数校验失败（ValidationPipe）会把 message 数组拼成一句话，
 * 避免前端拿到数组还要自己处理。
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<RequestWithId>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const payload =
      exception instanceof HttpException ? exception.getResponse() : null;

    let message = '服务器内部错误';
    let code = STATUS_CODE[status] ?? `HTTP_${status}`;

    if (typeof payload === 'string') {
      message = payload;
    } else if (payload && typeof payload === 'object') {
      const raw = (payload as { message?: unknown }).message;

      if (Array.isArray(raw)) {
        message = raw.join('；');
        code = 'VALIDATION_FAILED';
      } else if (typeof raw === 'string') {
        message = raw;
      }
    } else if (exception instanceof Error) {
      message = exception.message;
    }

    const body = {
      code,
      message,
      statusCode: status,
      path: request.originalUrl ?? request.url,
      requestId: request.requestId ?? null,
      timestamp: new Date().toISOString(),
    };

    const where = `${request.method} ${request.originalUrl ?? request.url}`;

    if (status >= 500) {
      this.logger.error(
        `${where} -> ${status} [${body.requestId ?? '-'}] ${message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(`${where} -> ${status} [${body.requestId ?? '-'}] ${message}`);
    }

    response.status(status).json(body);
  }
}