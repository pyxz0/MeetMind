import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Logger,
  Post,
  Query,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Response } from 'express';
import { createHash } from 'node:crypto';
import { Public } from '../auth/auth.decorators';
import { verifyWebhookSignature } from './tencent-signature';
import { PlatformEventService } from './platform-event.service';

/** 只认字符串与数字；对象/数组一律当空，避免 "[object Object]" 混进事件类型 */
const pickText = (
  source: Record<string, unknown>,
  ...keys: string[]
): string => {
  for (const key of keys) {
    const value = source[key];

    if (typeof value === 'string') {
      return value;
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }

  return '';
};

/**
 * 腾讯会议企业回调入口。
 *
 * 这个端点必须 @Public：腾讯会议没法携带我们的 JWT。
 * 安全性由签名保证 —— 没有正确的 token 就算不出签名，
 * 伪造请求和篡改内容都会在 verifyWebhookSignature 处被拒。
 *
 * 两种请求：
 * - GET  配置回调地址时的连通性探测，要返回 base64 解码后的 check_str 明文
 * - POST 真实事件推送，落库后立刻返回 200（腾讯要求 3 秒内）
 */
@Controller('platforms/tencent')
export class PlatformWebhookController {
  private readonly logger = new Logger(PlatformWebhookController.name);

  constructor(private readonly events: PlatformEventService) {}

  /**
   * 回调地址验证：验签通过后把 check_str 解码返回。
   *
   * 必须直接写 response —— 走 Nest 的返回值序列化会变成 `"hello"` 这种
   * 带引号的 JSON 字符串，腾讯那边比对的是**裸明文**，带了引号就验不过。
   */
  @Public()
  @Get('webhook')
  verifyUrl(
    @Query('check_str') checkStr: string,
    @Headers() headers: Record<string, string>,
    @Res() res: Response,
  ): void {
    const token = this.webhookToken();
    const signature = this.header(headers, 'signature');
    const timestamp = this.header(headers, 'timestamp');
    const nonce = this.header(headers, 'nonce');

    if (!checkStr) {
      this.logger.warn('回调验证缺少 check_str');
      throw new UnauthorizedException('缺少 check_str');
    }

    const passed = verifyWebhookSignature({
      token,
      timestamp,
      nonce,
      // GET 验证时，参与签名的是 check_str 本身
      data: checkStr,
      signature,
    });

    if (!passed) {
      this.logger.warn('回调验证签名不通过，请检查 TENCENT_MEETING_WEBHOOK_TOKEN');
      throw new UnauthorizedException('签名校验失败');
    }

    const decoded = Buffer.from(checkStr, 'base64').toString('utf8');

    this.logger.log('回调地址验证通过');

    res.type('text/plain; charset=utf-8').send(decoded);
  }

  /** 事件推送：验签 → 解码 → 落库 → 立即返回 */
  @Public()
  @Post('webhook')
  @HttpCode(200)
  async receive(
    @Body() body: Record<string, unknown>,
    @Headers() headers: Record<string, string>,
  ) {
    const token = this.webhookToken();
    const signature = this.header(headers, 'signature');
    const timestamp = this.header(headers, 'timestamp');
    const nonce = this.header(headers, 'nonce');

    /**
     * 腾讯把事件明文放在 body.data（base64）。
     * 参与签名的 data 就是这个 base64 字符串本身，不是解码后的内容。
     */
    const encoded = typeof body?.data === 'string' ? body.data : '';

    if (!encoded) {
      this.logger.warn(
        `回调缺少 data 字段，body keys=${Object.keys(body ?? {}).join(',')}`,
      );

      throw new UnauthorizedException('回调格式不正确');
    }

    const passed = verifyWebhookSignature({
      token,
      timestamp,
      nonce,
      data: encoded,
      signature,
    });

    if (!passed) {
      this.logger.warn('事件回调签名不通过，请求已拒绝');
      throw new UnauthorizedException('签名校验失败');
    }

    let payload: Record<string, unknown>;

    try {
      payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    } catch {
      this.logger.warn('回调 data 无法解析为 JSON');
      throw new UnauthorizedException('回调格式不正确');
    }

    // 回调体是 unknown，直接用 String() 可能得到 "[object Object]"
    const eventType = pickText(payload, 'event', 'event_type') || 'unknown';

    /**
     * 事件唯一标识：优先用腾讯的 unique_sequence。
     * 没有的话用明文哈希兜底 —— 重复推送的内容完全一致，
     * 哈希相同就能挡住重复处理。
     */
    const externalEventId =
      pickText(payload, 'unique_sequence').trim() ||
      createHash('sha256').update(encoded).digest('hex');

    const result = await this.events.ingest({
      platform: 'tencent',
      eventType,
      externalEventId,
      payload,
    });

    if (result.duplicated) {
      this.logger.debug(`重复事件已忽略：${eventType}`);
    }

    // 腾讯只关心 HTTP 200；重试逻辑由它自己按响应码决定
    return { code: 0 };
  }

  private webhookToken(): string {
    return process.env.TENCENT_MEETING_WEBHOOK_TOKEN?.trim() ?? '';
  }

  /** 头部字段大小写不敏感，Nest 给的是小写 key */
  private header(headers: Record<string, string>, name: string): string {
    const value =
      headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];

    return typeof value === 'string' ? value : String(value ?? '');
  }
}
