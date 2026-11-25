import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../common/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.decorators';
import type { TenantTypeName } from '../auth/permissions';

/** 一场会议归属的空间 */
export interface MeetingSpace {
  tenantId: string;
  tenantType: TenantTypeName;
}

/**
 * 解析这次创建要落在哪个空间。
 *
 * 规则（文档 §2.5）：
 * - 不传 tenantId → 当前浏览的空间
 * - 传了 → 必须是该用户所属的空间之一，否则 404
 *
 * **不能信前端传的 id**：那等于让任何登录用户把会议写进别人的空间。
 *
 * 不查库：`user.memberships` 已由守卫一次性加载（一个人最多两条）。
 *
 * 用 404 而不是 403：403 会告诉攻击者「这个空间确实存在，只是你没权限」。
 */
export const resolveMeetingSpace = (
  user: AuthenticatedUser,
  requested?: string,
): MeetingSpace => {
  const tenantId = requested ?? user.activeTenantId;
  const membership = user.memberships.find((m) => m.tenantId === tenantId);

  if (!membership) {
    throw new NotFoundException('空间不存在');
  }

  return { tenantId, tenantType: membership.type };
};

/**
 * 校验这批用户能不能被邀请到指定空间的会议（文档 §2.6）。
 *
 * - **企业会议**：必须都是本企业成员。企业会议的纪要、录音、待办都是公司资产，
 *   一个外部账号进来就能看到全部历史。这不是体验问题，是企业采购时的必问项。
 * - **个人会议**：必须都是我的好友。个人空间只有你一个人，
 *   拉一个不属于任何共同空间的人进来，凭据只能是"好友关系"。
 *
 * ## 错误信息刻意含糊
 *
 * 「账号不存在」和「不是你企业的人」返回同一句话。分开说就变成 oracle：
 * 拿一串手机号试一遍，就能问出"这个号是不是在某某公司"。
 */
export async function assertInvitable(
  prisma: PrismaService,
  user: AuthenticatedUser,
  space: MeetingSpace,
  userIds: number[],
): Promise<void> {
  /**
   * 排除自己：创建者默认会成为首位负责人，调用方会把他的 id 一起传进来。
   *
   * 他不是"被邀请的人"—— 他本来就在这个空间里（个人空间是他的，企业空间
   * 也校验过 membership），不需要满足"是我的好友 / 是本企业成员"。
   * 不排除的话，个人会议永远建不起来：没人能把自己加为好友。
   */
  const ids = [...new Set(userIds)].filter((id) => id !== user.id);

  if (!ids.length) {
    return;
  }

  if (space.tenantType === 'COMPANY') {
    const count = await prisma.membership.count({
      where: {
        tenantId: space.tenantId,
        userId: { in: ids },
        /** 停用的账号也不能被拉进新会议 */
        user: { isActive: true },
      },
    });

    if (count !== ids.length) {
      throw new BadRequestException('只能邀请本企业成员');
    }

    return;
  }

  const count = await prisma.friendship.count({
    where: {
      userId: user.id,
      friendId: { in: ids },
      /** 被停用的好友也不能被拉进新会议 */
      friend: { isActive: true },
    },
  });

  if (count !== ids.length) {
    throw new BadRequestException('只能邀请好友');
  }
}
