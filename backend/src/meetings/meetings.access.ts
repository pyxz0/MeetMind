import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../common/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.decorators';
import { PERMISSIONS, roleHasPermission } from '../auth/permissions';

/**
 * 当前用户对某场会议的实际访问级别。
 *
 * - owner      自己创建的会议，可读写、可共享、可删除
 * - edit       别人共享给我的「可编辑」，可读写但不能共享/删除
 * - read       别人共享给我的「只读」，只能看
 */
export type MeetingAccess = 'owner' | 'edit' | 'read';

/** 具备「全局会议权限」的角色（管理员及以上） */
export const hasGlobalMeetingAccess = (user: AuthenticatedUser) =>
  roleHasPermission(user.role, PERMISSIONS.MEETING_READ_ALL);

/**
 * 计算用户对某场会议的访问级别。
 *
 * 返回 null 表示无权访问；调用方决定是抛 404 还是 403。
 * 数据范围判定统一走这里，避免各业务方法各写一套。
 */
export async function resolveMeetingAccess(
  prisma: PrismaService,
  user: AuthenticatedUser,
  meetingId: number,
): Promise<{ access: MeetingAccess; ownerId: number } | null> {
  const meeting = await prisma.meeting.findUnique({
    where: { id: meetingId },
    select: { id: true, ownerId: true },
  });

  if (!meeting) {
    return null;
  }

  if (meeting.ownerId === user.id) {
    return { access: 'owner', ownerId: meeting.ownerId };
  }

  // 管理员及以上可访问全部会议，视作可编辑（但不算拥有，不能移除他人授权）
  if (hasGlobalMeetingAccess(user)) {
    return {
      access: roleHasPermission(user.role, PERMISSIONS.MEETING_UPDATE_ALL)
        ? 'edit'
        : 'read',
      ownerId: meeting.ownerId,
    };
  }

  const share = await prisma.meetingShare.findUnique({
    where: {
      meetingId_userId: { meetingId, userId: user.id },
    },
    select: { permission: true },
  });

  if (!share) {
    return null;
  }

  return {
    access: share.permission === 'EDIT' ? 'edit' : 'read',
    ownerId: meeting.ownerId,
  };
}

/**
 * 断言用户至少具备读取权限。
 *
 * 无权访问统一返回 404 而不是 403 —— 否则攻击者可以通过
 * 「404 还是 403」的差异探测出某个会议 ID 是否存在。
 */
export async function assertCanRead(
  prisma: PrismaService,
  user: AuthenticatedUser,
  meetingId: number,
): Promise<{ access: MeetingAccess; ownerId: number }> {
  const result = await resolveMeetingAccess(prisma, user, meetingId);

  if (!result) {
    throw new NotFoundException('会议记录不存在');
  }

  return result;
}

/** 断言用户具备写权限（owner 或 edit） */
export async function assertCanWrite(
  prisma: PrismaService,
  user: AuthenticatedUser,
  meetingId: number,
): Promise<{ access: MeetingAccess; ownerId: number }> {
  const result = await assertCanRead(prisma, user, meetingId);

  if (result.access === 'read') {
    throw new ForbiddenException('你对该会议只有只读权限，无法修改');
  }

  return result;
}

/**
 * 断言用户拥有该会议（共享者不算拥有）。
 *
 * 删除、共享授权、转移归属等操作必须走这里。
 */
export async function assertCanOwn(
  prisma: PrismaService,
  user: AuthenticatedUser,
  meetingId: number,
): Promise<{ ownerId: number }> {
  const result = await assertCanRead(prisma, user, meetingId);

  // 管理员可代为删除/管理他人会议，但不改变「拥有者」语义
  const isPrivileged = roleHasPermission(
    user.role,
    PERMISSIONS.MEETING_SHARE_ALL,
  );

  if (result.access !== 'owner' && !isPrivileged) {
    throw new ForbiddenException('只有会议拥有者可以执行该操作');
  }

  return { ownerId: result.ownerId };
}
