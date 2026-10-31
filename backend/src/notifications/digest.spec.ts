import {
  MAX_ITEMS_PER_MAIL,
  buildDigestHtml,
  buildDigestSubject,
  buildDigestText,
  meetingUrl,
} from './digest';

const item = (content: string, meetingId = 12, meetingTitle = '需求评审') => ({
  content,
  meetingId,
  meetingTitle,
});

const payload = (items: ReturnType<typeof item>[], total = items.length) => ({
  recipientName: '张三',
  publicUrl: 'http://meetmind.test',
  items,
  total,
});

describe('meetingUrl', () => {
  it('拼接会议详情地址', () => {
    expect(meetingUrl('http://meetmind.test', 12)).toBe(
      'http://meetmind.test/history/12',
    );
  });

  it('基址带尾斜杠时不会拼出双斜杠', () => {
    expect(meetingUrl('http://meetmind.test/', 12)).toBe(
      'http://meetmind.test/history/12',
    );
    expect(meetingUrl('http://meetmind.test///', 12)).toBe(
      'http://meetmind.test/history/12',
    );
  });
});

describe('buildDigestSubject', () => {
  it('只有一条时把内容放进主题，不点开就知道是什么事', () => {
    const subject = buildDigestSubject([item('会议「需求评审」将于 10/28 14:30 开始')], 1);

    expect(subject).toContain('需求评审');
    expect(subject).toContain('14:30');
  });

  it('单条内容过长时截断并加省略号', () => {
    const subject = buildDigestSubject([item('会'.repeat(80))], 1);

    expect(subject).toContain('…');
    // 前缀 + 40 字 + 省略号
    expect(subject.length).toBeLessThan(60);
  });

  it('多条时退化成计数', () => {
    const subject = buildDigestSubject([item('a'), item('b'), item('c')], 3);

    expect(subject).toBe('[MeetMind] 3 条待处理提醒');
  });

  it('条数以 total 为准（items 被截断时不会少报）', () => {
    const subject = buildDigestSubject([item('a')], 7);

    expect(subject).toBe('[MeetMind] 7 条待处理提醒');
  });
});

describe('buildDigestText', () => {
  it('包含问候、每条内容与对应链接', () => {
    const text = buildDigestText(
      payload([item('会议「需求评审」将于 10/28 14:30 开始', 12)]),
    );

    expect(text).toContain('张三，你好');
    expect(text).toContain('会议「需求评审」将于 10/28 14:30 开始');
    expect(text).toContain('http://meetmind.test/history/12');
  });

  it('单条用「一条」，多条用具体数量', () => {
    expect(buildDigestText(payload([item('a')]))).toContain('你有一条待处理的提醒');

    expect(buildDigestText(payload([item('a'), item('b')]))).toContain(
      '你有 2 条待处理的提醒',
    );
  });

  it('超过上限时截断并提示还有多少条', () => {
    const many = Array.from({ length: MAX_ITEMS_PER_MAIL + 3 }, (_, i) =>
      item(`提醒 ${i}`, i + 1),
    );
    const text = buildDigestText(payload(many, many.length));

    expect(text).toContain('另有 3 条');
    expect(text).toContain(`提醒 ${MAX_ITEMS_PER_MAIL - 1}`);
    expect(text).not.toContain(`提醒 ${MAX_ITEMS_PER_MAIL + 1}`);
  });

  it('带上关闭入口，别让人找不到开关', () => {
    expect(buildDigestText(payload([item('a')]))).toContain('个人中心');
  });
});

describe('buildDigestHtml', () => {
  it('包含每条内容与链接', () => {
    const html = buildDigestHtml(payload([item('待办「补用例」仍在等待你验收', 14)]));

    expect(html).toContain('待办「补用例」仍在等待你验收');
    expect(html).toContain('http://meetmind.test/history/14');
  });

  it('转义内容里的尖括号，不让会议标题变成标签', () => {
    const html = buildDigestHtml(
      payload([item('<script>alert(1)</script> 有更新', 3)]),
    );

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('转义收件人姓名', () => {
    const html = buildDigestHtml({
      recipientName: '<b>张三</b>',
      publicUrl: 'http://meetmind.test',
      items: [item('a')],
      total: 1,
    });

    expect(html).toContain('&lt;b&gt;张三&lt;/b&gt;');
  });

  it('超过上限时也给出提示', () => {
    const many = Array.from({ length: MAX_ITEMS_PER_MAIL + 2 }, (_, i) =>
      item(`提醒 ${i}`, i + 1),
    );
    const html = buildDigestHtml(payload(many, many.length));

    expect(html).toContain('另有 2 条');
  });
});
