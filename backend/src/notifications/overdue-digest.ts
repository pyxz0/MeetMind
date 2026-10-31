/**
 * 逾期提醒的邮件拼装。
 *
 * 与 digest.ts 的区别：那份拼的是「站内消息的邮件版」，
 * 这份拼的是「站内根本没有对应条目」的主动提醒 ——
 * 逾期信息只在收件箱的待办列表里，不进通知表，所以文案要自己说清楚。
 */

import { formatCstMonthDay } from '../common/datetime';
import { meetingUrl } from './digest';

export interface OverdueItem {
  todoId: number;
  content: string;
  /** 结构化截止时间，用于渲染「截止 10/25」 */
  deadlineAt: Date;
  /** 逾期天数，至少 1 */
  overdueDays: number;
  meetingId: number;
  meetingTitle: string;
}

export interface OverduePayload {
  recipientName: string;
  publicUrl: string;
  items: OverdueItem[];
  /** 本轮逾期总数（items 可能被截断） */
  total: number;
}

/** 一封邮件最多列多少条 */
export const MAX_OVERDUE_ITEMS = 10;

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const shorten = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();

  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/** 单条待办的一行摘要：截止日 + 逾期天数 + 会议 */
export const overdueLine = (item: OverdueItem): string =>
  `截止 ${formatCstMonthDay(item.deadlineAt)} · 逾期 ${item.overdueDays} 天 · 会议「${item.meetingTitle}」`;

/**
 * 主题。
 *
 * 只有一条时把待办名和时间都写进去，手机锁屏上不点开就知道是什么事；
 * 多条时退化成计数 + 最长逾期天数，让人一眼判断严重程度。
 */
export const buildOverdueSubject = (
  items: OverdueItem[],
  total: number,
): string => {
  const count = Math.max(total, items.length);
  const longest = items.reduce(
    (max, item) => Math.max(max, item.overdueDays),
    0,
  );

  if (count === 1 && items.length === 1) {
    const single = items[0];

    return `[MeetMind] 待办「${shorten(single.content, 24)}」已逾期 ${single.overdueDays} 天`;
  }

  return `[MeetMind] ${count} 条待办已逾期（最长 ${longest} 天）`;
};

export const buildOverdueText = (payload: OverduePayload): string => {
  const { recipientName, publicUrl, items, total } = payload;
  const shown = items.slice(0, MAX_OVERDUE_ITEMS);

  const longest = shown.reduce(
    (max, item) => Math.max(max, item.overdueDays),
    0,
  );

  const lines = [
    `${recipientName}，你好：`,
    '',
    total > 1
      ? `你有 ${total} 条待办已过截止时间，最长逾期 ${longest} 天：`
      : '你有一条待办已过截止时间：',
    '',
  ];

  shown.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.content}`);
    lines.push(`   ${overdueLine(item)}`);
    lines.push(`   查看：${meetingUrl(publicUrl, item.meetingId)}`);
    lines.push('');
  });

  if (total > shown.length) {
    lines.push(`另有 ${total - shown.length} 条，请到收件箱查看。`, '');
  }

  lines.push(
    '—',
    '这份提醒每天最多发一次，连续 7 次后自动停止。',
    '不想再收到邮件？在「个人中心 → 通知设置」里关闭邮件提醒。',
  );

  return lines.join('\n');
};

export const buildOverdueHtml = (payload: OverduePayload): string => {
  const { recipientName, publicUrl, items, total } = payload;
  const shown = items.slice(0, MAX_OVERDUE_ITEMS);

  const longest = shown.reduce(
    (max, item) => Math.max(max, item.overdueDays),
    0,
  );

  const rows = shown
    .map((item) => {
      const url = meetingUrl(publicUrl, item.meetingId);

      return `
        <tr>
          <td style="padding:14px 0;border-bottom:1px solid #e6e9f1">
            <p style="margin:0 0 6px;font-size:14px;line-height:1.7;color:#151a2e">
              ${escapeHtml(item.content)}
            </p>
            <p style="margin:0 0 6px;font-size:12.5px;line-height:1.6;color:#8a5a00">
              截止 ${escapeHtml(formatCstMonthDay(item.deadlineAt))} · 逾期 ${item.overdueDays} 天
              · 会议「${escapeHtml(item.meetingTitle)}」
            </p>
            <a href="${escapeHtml(url)}"
               style="font-size:12.5px;color:#4f46e5;text-decoration:none">
              查看会议 ›
            </a>
          </td>
        </tr>
      `;
    })
    .join('');

  const overflow =
    total > shown.length
      ? `<p style="margin:14px 0 0;font-size:12.5px;color:#6f778f">
           另有 ${total - shown.length} 条，请到收件箱查看。
         </p>`
      : '';

  return `
    <div style="font-family:'Microsoft YaHei',Arial,sans-serif;color:#151a2e">
      <p style="font-size:14px;line-height:1.9">${escapeHtml(recipientName)}，你好：</p>
      <p style="font-size:14px;line-height:1.9;color:#3a4058">
        ${total > 1
          ? `你有 ${total} 条待办已过截止时间，最长逾期 ${longest} 天：`
          : '你有一条待办已过截止时间：'}
      </p>
      <table style="width:100%;border-collapse:collapse;margin-top:6px">
        ${rows}
      </table>
      ${overflow}
      <p style="margin-top:26px;font-size:12px;line-height:1.8;color:#8f97a8">
        —<br>
        这份提醒每天最多发一次，连续 7 次后自动停止。<br>
        不想再收到邮件？在「个人中心 → 通知设置」里关闭邮件提醒。
      </p>
    </div>
  `;
};
