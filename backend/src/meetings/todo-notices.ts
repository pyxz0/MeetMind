/**
 * 待办变更后该通知谁。
 *
 * 抽成纯函数而不是写在 updateTodo 的事务里，是因为这里有四组条件相乘：
 * 换了负责人（新旧各一条）、换了验收人、改了截止时间、操作者可能就是当事人。
 * 混在 170 行的更新逻辑里很难看全，改一处忘一处就是「改派了但没人知道」。
 */

/** 一条待发出去的站内通知 */
export interface TodoNotice {
  /** 收件人 */
  userId: number;
  /** 写进 meeting_notices.kind，前端据此区分文案与图标 */
  kind: string;
  content: string;
}

/** 判定所需的最小字段集，避免测试时构造整个 Todo */
export interface TodoAssigneeSnapshot {
  content: string;
  assigneeUserId: number | null;
  reviewerId: number | null;
  /** 只用于通知文案里的「截止时间改为 X」 */
  deadline: string | null;
}

export interface TodoNoticeInput {
  before: TodoAssigneeSnapshot;
  after: TodoAssigneeSnapshot;
  /** 操作者；自己改自己的不发通知，否则会收到「你被指派了自己的活」 */
  actorId: number;
  /** 截止时间是否真的变了（由调用方按时间戳比较，纯函数不解析日期） */
  deadlineChanged: boolean;
}

/**
 * 组装通知列表。
 *
 * 规则：
 * - 改派：新负责人收「你被指派了」，原负责人收「已转交，不用跟进」
 * - 改验收人：只有新验收人收
 * - 改期：当前负责人收，且只在负责人不是操作者本人时
 * - 操作者本人永远不发给自己
 */
export const buildTodoNotices = (input: TodoNoticeInput): TodoNotice[] => {
  const { before, after, actorId, deadlineChanged } = input;
  const notices: TodoNotice[] = [];

  const assigneeChanged = after.assigneeUserId !== before.assigneeUserId;

  if (
    assigneeChanged &&
    after.assigneeUserId !== null &&
    after.assigneeUserId !== actorId
  ) {
    notices.push({
      userId: after.assigneeUserId,
      kind: 'todo_assigned',
      content: `你被指派了待办「${after.content}」`,
    });
  }

  if (
    assigneeChanged &&
    before.assigneeUserId !== null &&
    before.assigneeUserId !== actorId
  ) {
    notices.push({
      userId: before.assigneeUserId,
      kind: 'todo_reassigned',
      content: `待办「${after.content}」已转交给他人，你不再需要跟进`,
    });
  }

  if (
    after.reviewerId !== before.reviewerId &&
    after.reviewerId !== null &&
    after.reviewerId !== actorId
  ) {
    notices.push({
      userId: after.reviewerId,
      kind: 'todo_review_assigned',
      content: `你被指定为待办「${after.content}」的验收人`,
    });
  }

  /**
   * 改期只发给当前负责人。
   * 同时改派又改期时他会收到两条：一条说「归你了」，一条说「什么时候要」，
   * 分开反而更清楚 —— 合成一句「归你了，下周五前」也读得懂，但漏了哪条都看不出。
   */
  if (
    deadlineChanged &&
    after.assigneeUserId !== null &&
    after.assigneeUserId !== actorId
  ) {
    notices.push({
      userId: after.assigneeUserId,
      kind: 'todo_deadline_changed',
      content: `待办「${after.content}」截止时间改为 ${after.deadline ?? '未指定'}`,
    });
  }

  return notices;
};
