import { Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/auth.decorators';
import { hasTenantWideMeetingAccess } from './meetings.access';

/**
 * 「当前空间里我能看到的会议」查询条件。
 *
 * 普通用户：本空间内 自己拥有的 ∪ 负责的 ∪ 参与的 ∪ 被共享的
 * 管理员及以上：本空间内全部会议
 *
 * 会议列表、统计、待办负载都靠这一处。抽成独立函数是因为待办逻辑
 * 已经从 MeetingsService 拆到 TodosService，两个 service 都要用它 ——
 * 各留一份副本的话，改数据隔离规则时漏一处就是越权。
 *
 * ## 为什么所有分支都带 tenantId
 *
 * 不带的话，用户在企业空间里会看到自己的私人会议 —— 投屏时就是事故。
 * 列表必须按空间隔离，"我在哪个空间就看哪个空间的会"。
 *
 * ## 为什么这不影响个人会议的跨空间受邀者
 *
 * 列表范围只决定"列不列出来"。那场会议仍然可以按 id 打开，
 * 访问权限由 resolveMeetingAccess 判定（参与者关系本身就是授权）。
 * 受邀者通过收件箱通知点进来，不需要它出现在列表里。
 */
export const visibleMeetingScope = (
  user: AuthenticatedUser,
): Prisma.MeetingWhereInput => {
  if (hasTenantWideMeetingAccess(user)) {
    return { tenantId: user.activeTenantId };
  }

  return {
    tenantId: user.activeTenantId,
    OR: [
      { ownerId: user.id },
      { leaders: { some: { userId: user.id } } },
      { members: { some: { userId: user.id } } },
      { shares: { some: { userId: user.id } } },
    ],
  };
};
