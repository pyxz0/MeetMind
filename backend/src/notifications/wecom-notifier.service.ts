import { Injectable, Logger } from '@nestjs/common';
import { buildWeComBody, isWeComSuccess } from './wecom-payload';

/**
 * 企业微信群机器人。
 *
 * 与邮件渠道的分工要说清楚：
 * - 邮件是**到人**的，适合「这条待办归你」；
 * - 群消息是**到团队**的，适合「这周有三条逾期，大家看一眼」。
 *
 * 把每条待办都推群是错的：一天二十条，群就废了，最后所有人都免打扰。
 * 所以这里只在逾期每日汇总里使用，不参与逐条待办通知。
 *
 * 未配置 `WECOM_WEBHOOK_URL` 时所有方法直接返回 false —— 调用方不需要
 * 判断有没有配置，也不该因为没配而报错。
 */
@Injectable()
export class WeComNotifier {
  private readonly logger = new Logger(WeComNotifier.name);
  private readonly webhook = process.env.WECOM_WEBHOOK_URL?.trim() ?? '';

  get configured(): boolean {
    return !!this.webhook;
  }

  /**
   * 推一条 markdown 到群里。
   *
   * 任何失败都吞掉并返回 false：群提醒是锦上添花，
   * 不能因为 webhook 挂了就让逾期扫描整轮失败、邮件也发不出去。
   */
  async sendMarkdown(
    content: string,
    mentionMobiles: string[] = [],
  ): Promise<boolean> {
    if (!this.configured) {
      return false;
    }

    try {
      const response = await fetch(this.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildWeComBody(content, mentionMobiles)),
        signal: AbortSignal.timeout(8000),
      });

      const body = await response.json().catch(() => null);

      if (!isWeComSuccess(response.status, body)) {
        this.logger.warn(
          `群消息未送达：HTTP ${response.status} ${JSON.stringify(body)}`,
        );

        return false;
      }

      return true;
    } catch (error) {
      this.logger.warn(`群消息发送失败：${(error as Error).message}`);

      return false;
    }
  }
}
