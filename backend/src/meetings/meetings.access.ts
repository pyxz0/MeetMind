import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../common/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.decorators';
import { PERMISSIONS, roleHasPermission } from '../auth/permissions';

/**
 * 当前用户在某场会议中的身份。
 *
 * - owner   创建者，权限最高（可删除、可共享）
 * - leader  负责人（主持人），可编辑会议、管理成员、控制录音开关
 * - member  参会成员，可读并可勾选待办状态
 * - edit    通过共享获得的编辑权
 * - read    通过共享获得的只读权
 */
export type MeetingAccess = 'owner' | 'leader' | 'member' | 'edit' | 'read';

/** 会议内的细分能力，前端据此决定按钮是否可点 */
export interface MeetingCapabilities {
  canRead: boolean;
  /** 改标题 / 改完成状态 / 重新生成 */
  canEdit: boolean;
  /** 勾选与增删改待办 */
  canEditTodos: boolean;
  /** 指定负责人与增删成员 */
  canManageMembers: boolean;
  /** 控制录音是否开放 */
  canToggleAudio: boolean;
  /** 能否收听录音（由会议开关与身份共同决定） */
  canListenAudio: boolean;
  /** 删除会议 */
  canDelete: boolean;
  /** 管理共享授权 */
  canShare: boolean;
  isOwner: boolean;
  isLeader: boolean;
  isMember: boolean;
}

export interface MeetingAccessResult {
  access: MeetingAccess;
  ownerId: number;
  /** 负责人 ID 集合（可多位） */
  leaderIds: number[];
  audioOpen: boolean;
  capabilities: MeetingCapabilities;
}

/** 具备「全局会议权限」的角色（管理员及以上） */
export const hasGlobalMeetingAccess = (user: AuthenticatedUser) =>
  roleHasPermission(user.role, PERMISSIONS.MEETING_READ_ALL);

const isSuperAdmin = (user: AuthenticatedUser) => user.role === 'SUPER_ADMIN';

/**
 * 根据身份与录音开关推算能力位。
 *
 * 单独抽出来，保证「列表」「详情」「音频流」三处判定完全一致 ——
 * 权限判定分散在各处是这类系统最常见的漏洞来源。
 */
const buildCapabilities = (params: {
  user: AuthenticatedUser;
  access: MeetingAccess;
  audioOpen: boolean;
}): MeetingCapabilities => {
  const { user, access, audioOpen } = params;

  const isOwner = access === 'owner';
  const isLeader = access === 'leader';
  const isMember = access === 'member';

  // 管理员及以上：可读写全部会议，但不等于「拥有」
  const privilegedEdit =
    hasGlobalMeetingAccess(user) &&
    roleHasPermission(user.role, PERMISSIONS.MEETING_UPDATE_ALL);

  // 录音开关只对负责人、创建者与超管放行
  const audioController = isOwner || access === 'leader' || isSuperAdmin(user);

  return {
    canRead: true,
    canEdit:
      isOwner ||
      access === 'leader' ||
      access === 'edit' ||
      privilegedEdit,
    canEditTodos:
      isOwner ||
      access === 'leader' ||
      access === 'edit' ||
      isMember ||
      privilegedEdit,
    canManageMembers:
      isOwner ||
      access === 'leader' ||
      privilegedEdit,
    canToggleAudio: audioController,
    /**
     * 录音开放与否：
     * - 负责人 / 创建者 / 超管：始终可听
     * - 其他人：仅在 audioOpen 为真时可听
     */
    canListenAudio: audioController || audioOpen,
    canDelete: isOwner || privilegedEdit,
    canShare:
      isOwner ||
      roleHasPermission(user.role, PERMISSIONS.MEETING_SHARE_ALL),
    isOwner,
    isLeader,
    isMember,
  };
};

export const computeMeetingCapabilities = buildCapabilities;

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
): Promise<MeetingAccessResult | null> {
  const meeting = await prisma.meeting.findUnique({
    where: { id: meetingId },
    select: {
      id: true,
      ownerId: true,
      audioOpen: true,
      leaders: { select: { userId: true } },
    },
  });

  if (!meeting) {
    return null;
  }

  const leaderIds = meeting.leaders.map((l) => l.userId);

  const finish = (access: MeetingAccess): MeetingAccessResult => ({
    access,
    ownerId: meeting.ownerId,
    leaderIds,
    audioOpen: meeting.audioOpen,
    capabilities: buildCapabilities({
      user,
      access,
      audioOpen: meeting.audioOpen,
    }),
  });

  // 创建者优先判定：即使同时是负责人/成员，也以 owner 身份计
  if (meeting.ownerId === user.id) {
    return finish('owner');
  }

  if (leaderIds.includes(user.id)) {
    return finish('leader');
  }

  // 管理员及以上可访问全部会议
  if (hasGlobalMeetingAccess(user)) {
    return finish(
      roleHasPermission(user.role, PERMISSIONS.MEETING_UPDATE_ALL)
        ? 'edit'
        : 'read',
    );
  }

  // 成员：可读 + 可勾选待办
  const membership = await prisma.meetingMember.findUnique({
    where: { meetingId_userId: { meetingId, userId: user.id } },
    select: { id: true },
  });

  if (membership) {
    return finish('member');
  }

  const share = await prisma.meetingShare.findUnique({
    where: { meetingId_userId: { meetingId, userId: user.id } },
    select: { permission: true },
  });

  if (!share) {
    return null;
  }

  return finish(share.permission === 'EDIT' ? 'edit' : 'read');
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
): Promise<MeetingAccessResult> {
  const result = await resolveMeetingAccess(prisma, user, meetingId);

  if (!result) {
    throw new NotFoundException('会议记录不存在');
  }

  return result;
}

/** 断言用户具备编辑会议本体的权限（改标题、改状态、重新生成） */
export async function assertCanWrite(
  prisma: PrismaService,
  user: AuthenticatedUser,
  meetingId: number,
): Promise<MeetingAccessResult> {
  const result = await assertCanRead(prisma, user, meetingId);

  if (!result.capabilities.canEdit) {
    throw new ForbiddenException('你对该会议没有修改权限');
  }

  return result;
}

/** 断言用户可修改待办（成员也可以勾选） */
export async function assertCanEditTodos(
  prisma: PrismaService,
  user: AuthenticatedUser,
  meetingId: number,
): Promise<MeetingAccessResult> {
  const result = await assertCanRead(prisma, user, meetingId);

  if (!result.capabilities.canEditTodos) {
    throw new ForbiddenException('你对该会议没有修改待办的权限');
  }

  return result;
}

/** 断言用户可管理成员与负责人 */
export async function assertCanManageMembers(
  prisma: PrismaService,
  user: AuthenticatedUser,
  meetingId: number,
): Promise<MeetingAccessResult> {
  const result = await assertCanRead(prisma, user, meetingId);

  if (!result.capabilities.canManageMembers) {
    throw new ForbiddenException('只有会议创建者、负责人或管理员可以管理成员');
  }

  return result;
}

/** 断言用户可以控制录音开放开关 */
export async function assertCanToggleAudio(
  prisma: PrismaService,
  user: AuthenticatedUser,
  meetingId: number,
): Promise<MeetingAccessResult> {
  const result = await assertCanRead(prisma, user, meetingId);

  if (!result.capabilities.canToggleAudio) {
    throw new ForbiddenException(
      '只有会议创建者、负责人或超级管理员可以控制录音开放',
    );
  }

  return result;
}

/** 断言用户可以收听录音 */
export async function assertCanListenAudio(
  prisma: PrismaService,
  user: AuthenticatedUser,
  meetingId: number,
): Promise<MeetingAccessResult> {
  const result = await assertCanRead(prisma, user, meetingId);

  if (!result.capabilities.canListenAudio) {
    throw new ForbiddenException('该会议录音未开放');
  }

  return result;
}

/**
 * 断言用户拥有该会议（共享者与成员都不算拥有）。
 *
 * 删除会议、转移归属等操作必须走这里；共享授权另有
 * MEETING_SHARE_ALL 权限放行。
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
