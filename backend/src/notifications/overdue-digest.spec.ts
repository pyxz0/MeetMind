import {
  MAX_OVERDUE_ITEMS,
  buildOverdueHtml,
  buildOverdueSubject,
  buildOverdueText,
  overdueLine,
} from './overdue-digest';

const item = (
  content: string,
  overdueDays = 2,
  meetingId = 12,
  meetingTitle = '网关重构方案评审',
) => ({
  todoId: 1,
  content,
  // 2026-10-25 23:59:59 (UTC+8)
  deadlineAt: new Date('2026-10-25T15:59:59Z'),
  overdueDays,
  meetingId,
  meetingTitle,
});

const payload = (items: ReturnType<typeof item>[], total = items.length) => ({
  recipientName: '李四',
  publicUrl: 'http://meetmind.test',
  items,
  total,
});

describe('overdueLine', () => {
  it('把截止日、逾期天数、会议名串成一行', () => {
    expect(overdueLine(item('补齐网关限流配置', 2))).toBe(
      '截止 10/25 · 逾期 2 天 · 会议「网关重构方案评审」',
    );
  });
});

describe('buildOverdueSubject', () => {
  it('只有一条时写清是哪件事、逾期几天', () => {
    const subject = buildOverdueSubject([item('补齐网关限流配置', 3)], 1);

    expect(subject).toContain('补齐网关限流配置');
    expect(subject).toContain('逾期 3 天');
  });

  it('待办名过长时截断，避免主题被撑爆', () => {
    const subject = buildOverdueSubject([item('会'.repeat(60), 1)], 1);

    expect(subject).toContain('…');
    expect(subject.length).toBeLessThan(50);
  });

  it('多条时给出总数与最长逾期天数', () => {
    const subject = buildOverdueSubject(
      [item('a', 2), item('b', 9), item('c', 5)],
      3,
    );

    expect(subject).toBe('[MeetMind] 3 条待办已逾期（最长 9 天）');
  });

  it('条数以 total 为准，items 被截断时不漏报', () => {
    const subject = buildOverdueSubject([item('a', 1)], 12);

    expect(subject).toContain('12 条');
  });
});

describe('buildOverdueText', () => {
  it('包含问候、待办内容、逾期说明与链接', () => {
    const text = buildOverdueText(payload([item('补齐网关限流配置', 2)]));

    expect(text).toContain('李四，你好');
    expect(text).toContain('补齐网关限流配置');
    expect(text).toContain('逾期 2 天');
    expect(text).toContain('http://meetmind.test/history/12');
  });

  it('单条用「一条」，多条用具体数量', () => {
    expect(buildOverdueText(payload([item('a')]))).toContain(
      '你有一条待办已过截止时间',
    );

    expect(buildOverdueText(payload([item('a'), item('b')]))).toContain(
      '你有 2 条待办已过截止时间',
    );
  });

  it('说明提醒频率与关闭入口，避免用户以为是骚扰', () => {
    const text = buildOverdueText(payload([item('a')]));

    expect(text).toContain('每天最多发一次');
    expect(text).toContain('个人中心');
  });

  it('超过上限时截断并提示剩余条数', () => {
    const many = Array.from({ length: MAX_OVERDUE_ITEMS + 4 }, (_, i) =>
      item(`待办 ${i}`, 1, i + 1),
    );
    const text = buildOverdueText(payload(many, many.length));

    expect(text).toContain('另有 4 条');
    expect(text).toContain(`待办 ${MAX_OVERDUE_ITEMS - 1}`);
    expect(text).not.toContain(`待办 ${MAX_OVERDUE_ITEMS + 2}`);
  });
});

describe('buildOverdueHtml', () => {
  it('包含待办内容与链接', () => {
    const html = buildOverdueHtml(payload([item('补齐网关限流配置', 2, 15)]));

    expect(html).toContain('补齐网关限流配置');
    expect(html).toContain('http://meetmind.test/history/15');
  });

  it('转义内容与会议名里的尖括号', () => {
    const html = buildOverdueHtml(
      payload([item('<script>alert(1)</script>', 1, 3, '<b>周会</b>')]),
    );

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;b&gt;周会&lt;/b&gt;');
  });

  it('超过上限时也给出提示', () => {
    const many = Array.from({ length: MAX_OVERDUE_ITEMS + 1 }, (_, i) =>
      item(`待办 ${i}`, 1, i + 1),
    );

    expect(buildOverdueHtml(payload(many, many.length))).toContain('另有 1 条');
  });
});
