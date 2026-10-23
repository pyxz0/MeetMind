import { buildMeetingMarkdown, markdownFilename } from './meeting-markdown';
import type { ExportableMeeting } from './meeting-markdown';

const meeting: ExportableMeeting = {
  id: 42,
  title: '产品需求评审会',
  content: '张三负责首页 UI 设计。\n李四负责登录接口。',
  summary: '确认第一版范围。',
  completionStatus: 'IN_PROGRESS',
  created_at: '2026-10-01T02:13:00.000Z',
  scheduledAt: null,
  leaders: [{ name: '王敏' }],
  members: [{ name: '张三' }, { name: '李四' }],
  decisions: ['第一版先支持手机号登录'],
  todos: [
    {
      content: '完成首页 UI',
      assignee: '张三',
      deadline: '本周五',
      status: 'COMPLETED',
    },
    { content: '联调接口', status: 'OPEN' },
  ],
};

describe('buildMeetingMarkdown', () => {
  it('按「信息表 → 摘要 → 决策 → 待办 → 原文」的顺序输出', () => {
    const markdown = buildMeetingMarkdown(meeting);

    const sections = ['## 摘要', '## 一、核心决策', '## 二、待办事项', '## 三、会议原文'];

    const positions = sections.map((section) => markdown.indexOf(section));
    positions.forEach((position) => expect(position).toBeGreaterThan(-1));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('UTC 时间按北京时间输出', () => {
    expect(buildMeetingMarkdown(meeting)).toContain('2026-10-01 10:13');
  });

  it('待办进度只统计已完成与已取消', () => {
    expect(buildMeetingMarkdown(meeting)).toContain('已处理 1 / 共 2 项');
  });

  it('把状态换成中文标签', () => {
    const markdown = buildMeetingMarkdown(meeting);

    expect(markdown).toContain('| 状态 | 进行中 |');
    expect(markdown).toContain('| 已完成 |');
    expect(markdown).toContain('| 未开始 |');
  });

  it('原文放进代码块，避免 Markdown 符号被渲染', () => {
    expect(buildMeetingMarkdown(meeting)).toContain(
      '```text\n张三负责首页 UI 设计。\n李四负责登录接口。\n```',
    );
  });

  it('缺失字段用占位文案，不会输出 undefined', () => {
    const markdown = buildMeetingMarkdown({
      ...meeting,
      summary: '',
      content: '',
      decisions: [],
      todos: [],
      leaders: undefined,
      members: undefined,
    });

    expect(markdown).not.toContain('undefined');
    expect(markdown).toContain('（本次会议没有生成摘要。）');
    expect(markdown).toContain('（本次会议没有记录决策。）');
    expect(markdown).toContain('（本次会议没有待办事项。）');
  });

  it('表格单元格里的竖线和换行不会破坏表格', () => {
    const markdown = buildMeetingMarkdown({
      ...meeting,
      todos: [{ content: 'A | B\nC', status: 'OPEN' }],
    });

    expect(markdown).toContain('A \\| B C');
  });
});

describe('markdownFilename', () => {
  it('去掉路径分隔符与 Windows 保留字符', () => {
    expect(markdownFilename('评审/会: 第一版*?', 7)).toBe('评审 会 第一版.md');
  });

  it('标题为空时回退到会议编号', () => {
    expect(markdownFilename('   ', 7)).toBe('会议-7.md');
  });
});
