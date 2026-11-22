import { Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/auth.decorators';
import { hasGlobalMeetingAccess } from './meetings.access';

/**
 * 「当前用户可见的会议」查询条件。
 *
 * 普通用户：自己拥有的 ∪ 自己负责的 ∪ 自己参与的 ∪ 别人共享给自己的
 * 管理员及以上：全部会议
 *
 * 会议列表、统计、待办负载都靠这一处。抽成独立函数是因为待办逻辑
 * 已经从 MeetingsService 拆到 TodosService，两个 service 都要用它 ——
 * 各留一份副本的话，改数据隔离规则时漏一处就是越权。
 */
export const visibleMeetingScope = (
  user: AuthenticatedUser,
): Prisma.MeetingWhereInput => {
  if (hasGlobalMeetingAccess(user)) {
    return {};
  }

  return {
    OR: [
      { ownerId: user.id },
      { leaders: { some: { userId: user.id } } },
      { members: { some: { userId: user.id } } },
      { shares: { some: { userId: user.id } } },
    ],
  };
};
