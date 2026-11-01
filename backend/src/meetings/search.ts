/**
 * 搜索结果里的命中片段。
 *
 * 把关键词前后各截一段给人看，比只返回「这场会议命中了」有用得多 ——
 * 用户需要确认的是「是不是我要找的那句话」。
 */

/** 片段两侧各留多少字 */
const DEFAULT_RADIUS = 30;

/**
 * 截取命中片段。
 *
 * 没有命中返回 null，调用方据此过滤掉「其实没命中」的条目。
 * 匹配不区分大小写，但返回的是原文，保留原始大小写。
 */
export const buildSnippet = (
  text: string | null | undefined,
  keyword: string,
  radius = DEFAULT_RADIUS,
): string | null => {
  if (!text || !keyword) {
    return null;
  }

  const index = text.toLowerCase().indexOf(keyword.toLowerCase());

  if (index < 0) {
    return null;
  }

  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + keyword.length + radius);

  // 换行会把多行原文压成一条，片段的「一行」语义更清楚
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim();

  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
};

/** 命中来自哪个字段，前端据此加标签 */
export type SearchHitField =
  | 'title'
  | 'summary'
  | 'content'
  | 'decision'
  | 'todo';

export interface SearchHit {
  field: SearchHitField;
  text: string;
}

export interface SearchResultItem {
  id: number;
  title: string;
  scheduledAt: string | null;
  completionStatus: string;
  /** 最多三条，优先标题与摘要 */
  hits: SearchHit[];
}

/** 每场会议最多展示几条命中，多了反而看不清 */
export const MAX_HITS_PER_MEETING = 3;

/**
 * 汇总一场会议的命中片段。
 *
 * 顺序是刻意的：标题 > 摘要 > 正文 > 决策 > 待办。
 * 标题命中最能说明「就是这场会」，正文片段太长，放后面。
 */
export const collectHits = (params: {
  title: string;
  summary: string | null;
  content: string | null;
  decisions: string[];
  todos: string[];
  keyword: string;
}): SearchHit[] => {
  const { keyword } = params;
  const hits: SearchHit[] = [];

  // 标题命中时直接展示标题，不截片段
  if (params.title.toLowerCase().includes(keyword.toLowerCase())) {
    hits.push({ field: 'title', text: params.title });
  }

  const push = (field: SearchHitField, value: string | null | undefined) => {
    const snippet = buildSnippet(value, keyword);

    if (snippet) {
      hits.push({ field, text: snippet });
    }
  };

  push('summary', params.summary);
  push('content', params.content);

  params.decisions.forEach((text) => push('decision', text));
  params.todos.forEach((text) => push('todo', text));

  return hits.slice(0, MAX_HITS_PER_MEETING);
};
