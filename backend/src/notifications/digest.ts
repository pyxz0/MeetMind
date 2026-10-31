/**
 * 把一批站内提醒拼成一封邮件。
 *
 * 一个人可能同时有几条会议提醒和待验收催办，逐条发信会变成邮件轰炸；
 * 所以按人聚合成一封摘要。这里是纯函数，方便测主题、转义和链接拼接。
 */

/** 一条待投递的提醒（来自 meeting_notices） */
export interface DigestItem {
  content: string;
  meetingId: number;
  meetingTitle: string;
}

export interface DigestPayload {
  recipientName: string;
  /** 站点对外地址，用于拼「查看」链接 */
  publicUrl: string;
  items: DigestItem[];
  /** 本轮实际未投递的条数（items 可能被截断到上限） */
  total: number;
}

/** 单封邮件最多列多少条，超出只在末尾提一句 */
export const MAX_ITEMS_PER_MAIL = 10;

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** 去掉末尾斜杠，避免拼出 `//history/1` */
const trimBase = (value: string) => value.replace(/\/+$/, '');

export const meetingUrl = (publicUrl: string, meetingId: number): string =>
  `${trimBase(publicUrl)}/history/${meetingId}`;

/**
 * 主题。
 *
 * 单条时直接把内容放进主题 —— 手机锁屏上不点开就能看到是什么事，
 * 这是「提醒」和「通知」的区别。多条才退化成计数。
 */
export const buildDigestSubject = (items: DigestItem[], total: number): string => {
  const count = Math.max(total, items.length);

  if (count === 1 && items.length === 1) {
    const single = items[0].content.replace(/\s+/g, ' ').trim();

    return single.length > 40 ? `[MeetMind] ${single.slice(0, 40)}…` : `[MeetMind] ${single}`;
  }

  return `[MeetMind] ${count} 条待处理提醒`;
};

export const buildDigestText = (payload: DigestPayload): string => {
  const { recipientName, publicUrl, items, total } = payload;
  const shown = items.slice(0, MAX_ITEMS_PER_MAIL);

  const lines = [
    `${recipientName}，你好：`,
    '',
    total > 1 ? `你有 ${total} 条待处理的提醒：` : '你有一条待处理的提醒：',
    '',
  ];

  shown.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.content}`);
    lines.push(`   查看：${meetingUrl(publicUrl, item.meetingId)}`);
    lines.push('');
  });

  if (total > shown.length) {
    lines.push(`另有 ${total - shown.length} 条，请到收件箱查看。`, '');
  }

  lines.push(
    '—',
    'MeetMind 会议纪要',
    '不想再收到邮件提醒？在「个人中心 → 通知设置」里关闭即可。',
  );

  return lines.join('\n');
};

export const buildDigestHtml = (payload: DigestPayload): string => {
  const { recipientName, publicUrl, items, total } = payload;
  const shown = items.slice(0, MAX_ITEMS_PER_MAIL);

  const rows = shown
    .map((item) => {
      const url = meetingUrl(publicUrl, item.meetingId);

      return `
        <tr>
          <td style="padding:14px 0;border-bottom:1px solid #e6e9f1">
            <p style="margin:0 0 6px;font-size:14px;line-height:1.7;color:#151a2e">
              ${escapeHtml(item.content)}
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
        ${total > 1 ? `你有 ${total} 条待处理的提醒：` : '你有一条待处理的提醒：'}
      </p>
      <table style="width:100%;border-collapse:collapse;margin-top:6px">
        ${rows}
      </table>
      ${overflow}
      <p style="margin-top:26px;font-size:12px;line-height:1.8;color:#8f97a8">
        —<br>
        MeetMind 会议纪要<br>
        不想再收到邮件提醒？在「个人中心 → 通知设置」里关闭即可。
      </p>
    </div>
  `;
};
