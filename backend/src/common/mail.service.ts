import { Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';

/**
 * 发信服务。
 *
 * 目前只有一个用途：把密码重置链接发给用户绑定的邮箱。
 * 没有配置 SMTP 时不会抛错，而是把邮件内容写进日志 ——
 * 这样本地开发和还没配邮箱的部署仍然能走完整流程（从日志里取链接）。
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter | null;
  private readonly from: string;

  constructor() {
    const host = process.env.SMTP_HOST?.trim();
    const user = process.env.SMTP_USER?.trim();
    const pass = process.env.SMTP_PASS;
    const port = Number(process.env.SMTP_PORT ?? 465);

    this.from =
      process.env.SMTP_FROM?.trim() || user || 'no-reply@meetmind.local';

    if (!host || !user || !pass) {
      this.transporter = null;
      this.logger.warn(
        '未配置 SMTP（SMTP_HOST / SMTP_USER / SMTP_PASS），重置邮件只会写入日志',
      );
      return;
    }

    this.transporter = nodemailer.createTransport({
      host,
      port,
      // 465 走隐式 TLS；587 走 STARTTLS。可用 SMTP_SECURE 显式覆盖。
      secure: process.env.SMTP_SECURE
        ? process.env.SMTP_SECURE === 'true'
        : port === 465,
      auth: { user, pass },
    });
  }

  /** 是否真的能把信投出去（false 时只写日志） */
  get configured(): boolean {
    return this.transporter !== null;
  }

  /**
   * 发送密码重置邮件。
   *
   * 返回 false 表示没发出去（未配置或投递失败），
   * 由调用方决定怎么提示 —— 对用户仍然是「已发送」，
   * 避免把「这个邮箱有没有绑账号」变成可探测信息。
   */
  async sendPasswordReset(
    to: string,
    name: string,
    link: string,
    ttlMinutes: number,
  ): Promise<boolean> {
    const subject = '重置你的 MeetMind 密码';
    const text = [
      `${name}，你好：`,
      '',
      '我们收到了重置 MeetMind 密码的请求。点击下面的链接设置新密码：',
      link,
      '',
      `链接 ${ttlMinutes} 分钟内有效，且只能使用一次。`,
      '如果这不是你本人的操作，忽略这封邮件即可，密码不会改变。',
    ].join('\n');

    const html = `
      <div style="font-family:'Microsoft YaHei',Arial,sans-serif;font-size:14px;line-height:1.9;color:#151a2e">
        <p>${escapeHtml(name)}，你好：</p>
        <p>我们收到了重置 MeetMind 密码的请求。点击下面的按钮设置新密码：</p>
        <p style="margin:22px 0">
          <a href="${escapeHtml(link)}"
             style="display:inline-block;padding:10px 22px;background:#4f46e5;color:#fff;text-decoration:none">
            设置新密码
          </a>
        </p>
        <p style="font-size:12.5px;color:#6f778f">按钮打不开时，把下面的地址复制到浏览器：<br>
          <span style="font-family:Consolas,monospace;word-break:break-all">${escapeHtml(link)}</span>
        </p>
        <p style="font-size:12.5px;color:#6f778f">
          链接 ${ttlMinutes} 分钟内有效，且只能使用一次。若这不是你本人的操作，忽略这封邮件即可。
        </p>
      </div>
    `;

    if (!this.transporter) {
      this.logger.warn(`[未配置 SMTP] 重置链接 ${to} -> ${link}`);
      return false;
    }

    try {
      await this.transporter.sendMail({
        from: this.from,
        to,
        subject,
        text,
        html,
      });
      return true;
    } catch (error) {
      this.logger.error(
        `重置邮件发送失败 to=${to}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }
}

/** 姓名会进 HTML，必须转义，否则带尖括号的名字会破坏排版 */
const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
