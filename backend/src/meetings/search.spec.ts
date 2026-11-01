import { buildSnippet, collectHits, MAX_HITS_PER_MEETING } from './search';

describe('buildSnippet', () => {
  it('没命中返回 null，调用方据此过滤', () => {
    expect(buildSnippet('网关限流方案', '缓存')).toBeNull();
  });

  it('空值与空关键词都返回 null', () => {
    expect(buildSnippet('', '限流')).toBeNull();
    expect(buildSnippet('网关限流方案', '')).toBeNull();
    expect(buildSnippet(null, '限流')).toBeNull();
  });

  it('截取关键词前后各一段', () => {
    const text = `${'前'.repeat(50)}限流${'后'.repeat(50)}`;
    const snippet = buildSnippet(text, '限流', 10);

    expect(snippet).toContain('限流');
    // 10 + 2 + 10 = 22 字，前后各带省略号
    expect(snippet?.startsWith('…')).toBe(true);
    expect(snippet?.endsWith('…')).toBe(true);
    expect(snippet?.length).toBeLessThan(text.length);
  });

  it('关键词在开头或结尾时不加多余的省略号', () => {
    expect(buildSnippet('限流方案讨论', '限流', 5)).toBe('限流方案讨论');
    expect(buildSnippet('讨论限流', '限流', 5)).toBe('讨论限流');
  });

  it('匹配不区分大小写，但返回原文大小写', () => {
    expect(buildSnippet('QPS 压测报告', 'qps')).toContain('QPS');
  });

  it('把换行压成空格，片段保持一行', () => {
    const snippet = buildSnippet('第一行\n\n第二行 限流 第三行', '限流');

    expect(snippet).not.toContain('\n');
    expect(snippet).toContain('限流');
  });
});

describe('collectHits', () => {
  const base = {
    title: '网关重构方案评审',
    summary: '讨论限流阈值与熔断策略',
    content: '本次会议确认了限流方案',
    decisions: ['采用令牌桶限流'],
    todos: ['补齐网关限流配置'],
    keyword: '限流',
  };

  it('标题命中时优先展示标题本身，不截片段', () => {
    const hits = collectHits({ ...base, title: '限流方案评审' });

    expect(hits[0]).toEqual({ field: 'title', text: '限流方案评审' });
  });

  it('按 摘要 > 正文 > 决策 > 待办 的顺序汇总', () => {
    const hits = collectHits(base);

    expect(hits.map((hit) => hit.field)).toEqual([
      'summary',
      'content',
      'decision',
      'todo',
    ].slice(0, MAX_HITS_PER_MEETING));
  });

  it('最多三条：多了反而看不清重点', () => {
    const hits = collectHits({
      ...base,
      title: '限流方案评审',
      decisions: ['限流一', '限流二', '限流三'],
      todos: ['限流四'],
    });

    expect(hits).toHaveLength(MAX_HITS_PER_MEETING);
  });

  it('没有命中任何片段时返回空数组', () => {
    expect(
      collectHits({
        ...base,
        summary: '无关内容',
        content: '无关内容',
        decisions: [],
        todos: [],
        keyword: '缓存',
      }),
    ).toEqual([]);
  });

  it('只有待办命中时也能给出片段', () => {
    const hits = collectHits({
      title: '周会',
      summary: null,
      content: null,
      decisions: [],
      todos: ['补齐网关限流配置'],
      keyword: '限流',
    });

    expect(hits).toHaveLength(1);
    expect(hits[0].field).toBe('todo');
    expect(hits[0].text).toContain('限流');
  });
});
