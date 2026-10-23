import type { MeetingCompletionStatus, TodoStatus } from '@prisma/client';

/** 会议状态的中文标签，与前端「四色标记」保持同一套说法 */
const COMPLETION_LABELS: Record<MeetingCompletionStatus, string> = {
  NOT_STARTED: '未开始',
  IN_PROGRESS: '进行中',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
};

/** 待办状态的中文标签 */
const TODO_LABELS: Record<TodoStatus, string> = {
  OPEN: '未开始',
  IN_PROGRESS: '进行中',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
};

/** 导出需要的会议字段（toApiRecord 的输出结构） */
export interface ExportableMeeting {
  id: number;
  title: string;
  content: string;
  summary: string;
  completionStatus: MeetingCompletionStatus;
  created_at?: string;
  scheduledAt?: string | null;
  isOwner?: boolean;
  leaders?: Array<{ name: string }>;
  members?: Array<{ name: string }>;
  decisions: string[];
  todos: Array<{
    content: string;
    assignee?: string;
    deadline?: string;
    status: TodoStatus;
  }>;
}

/**
 * 把 UTC 时间格式化成北京时间。
 *
 * 不依赖 ICU / toLocaleString：容器里不一定有完整时区数据，
 * 而纪要里的时间必须稳定，所以直接加 8 小时再取 UTC 字段。
 */
const beijingTime = (value?: string | null): string => {
  if (!value) return '';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');

  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    ` ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
  );
};

/** 表格单元格里不能出现裸的竖线与换行，否则会把表格拆坏 */
const cell = (value?: string | null): string =>
  (value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim() || '—';

/** 文件名不能带路径分隔符与 Windows 保留字符 */
export const markdownFilename = (title: string, id: number): string => {
  const safe = (title || `会议-${id}`)
    .replace(/[\\/:*?"<>|\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);

  return `${safe || `会议-${id}`}.md`;
};

/**
 * 生成 Markdown 纪要。
 *
 * 结构与「稿纸」版式一致：页眉信息 → 摘要 → 核心决策 → 待办 → 原文，
 * 这样导出的文件粘进 Word 或飞书文档后，顺序与页面看到的一样。
 */
export const buildMeetingMarkdown = (meeting: ExportableMeeting): string => {
  const lines: string[] = [];
  const created = beijingTime(meeting.created_at);
  const scheduled = beijingTime(meeting.scheduledAt);

  const leaders = (meeting.leaders ?? []).map((leader) => leader.name).join('、');
  const members = (meeting.members ?? []).map((member) => member.name).join('、');

  const doneCount = meeting.todos.filter(
    (todo) => todo.status === 'COMPLETED' || todo.status === 'CANCELLED',
  ).length;

  lines.push(`# ${meeting.title || `会议 #${meeting.id}`}`, '');

  lines.push('| 项目 | 内容 |', '| --- | --- |');
  if (scheduled) lines.push(`| 会议时间 | ${cell(scheduled)} |`);
  if (created) lines.push(`| 记录时间 | ${cell(created)} |`);
  if (leaders) lines.push(`| 负责人 | ${cell(leaders)} |`);
  if (members) lines.push(`| 成员 | ${cell(members)} |`);
  lines.push(`| 状态 | ${cell(COMPLETION_LABELS[meeting.completionStatus])} |`);
  lines.push(
    `| 待办进度 | 已处理 ${doneCount} / 共 ${meeting.todos.length} 项 |`,
  );
  lines.push(`| 导出于 | ${cell(beijingTime(new Date().toISOString()))} |`);
  lines.push('');

  lines.push('## 摘要', '');
  lines.push(meeting.summary?.trim() || '（本次会议没有生成摘要。）', '');

  lines.push('## 一、核心决策', '');
  if (meeting.decisions.length === 0) {
    lines.push('（本次会议没有记录决策。）');
  } else {
    meeting.decisions.forEach((decision, index) => {
      lines.push(`${index + 1}. ${decision.trim()}`);
    });
  }
  lines.push('');

  lines.push('## 二、待办事项', '');
  if (meeting.todos.length === 0) {
    lines.push('（本次会议没有待办事项。）');
  } else {
    lines.push('| # | 事项 | 负责人 | 截止 | 状态 |');
    lines.push('| --- | --- | --- | --- | --- |');
    meeting.todos.forEach((todo, index) => {
      lines.push(
        `| ${index + 1} | ${cell(todo.content)} | ${cell(todo.assignee)} | ` +
          `${cell(todo.deadline)} | ${cell(TODO_LABELS[todo.status])} |`,
      );
    });
  }
  lines.push('');

  lines.push('## 三、会议原文', '');
  lines.push('```text');
  lines.push(meeting.content?.trim() || '（没有保存会议原文。）');
  lines.push('```', '');

  return lines.join('\n');
};
