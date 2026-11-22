import { MeetingCompletionStatus, TodoStatus } from '@prisma/client';

/**
 * 根据待办完成情况推算会议应处的状态。
 *
 * 规则（双向）：
 * - 会议存在待办且全部已处理完 → COMPLETED
 * - 还有待处理待办 → IN_PROGRESS
 * - 没有任何待办 → 保持原状态（没有待办就没有「全部完成」可谈）
 * - 会议已被手动取消 → 保持 CANCELLED，不覆盖用户意图
 *
 * 待办是否算「已处理完」的策略集中在这里：CANCELLED 视为不再需要处理，
 * 因此不阻挡会议完成。若希望已取消的待办也阻挡完成，把数组改成
 * ['COMPLETED'] 即可。
 *
 * 抽成独立函数是因为两个 service 都要用：
 * 会议创建时要按刚写入的待办推算一次，待办流转时又要同步一次。
 */
export const SETTLED_TODO_STATUSES: TodoStatus[] = ['COMPLETED', 'CANCELLED'];

export const resolveCompletionStatus = (
  current: MeetingCompletionStatus,
  todoStatuses: TodoStatus[],
): MeetingCompletionStatus => {
  if (current === 'CANCELLED') {
    return current;
  }

  if (todoStatuses.length === 0) {
    return current;
  }

  const allSettled = todoStatuses.every((status) =>
    SETTLED_TODO_STATUSES.includes(status),
  );

  return allSettled ? 'COMPLETED' : 'IN_PROGRESS';
};
