import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.decorators';
import { assertCanOwn, hasGlobalMeetingAccess } from './meetings.access';

export type SharePermissionInput = 'READ' | 'EDIT';

@Injectable()
export class MeetingShareService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 列出某场会议的共享情况。
   *
   * 只有归属者与管理员可见 —— 被共享者不该看到还有谁被共享了，
   * 否则会泄露组织内的人员关系。
   */
  async listShares(meetingId: number, user: AuthenticatedUser) {
    await assertCanOwn(this.prisma, user, meetingId);

    const shares = await this.prisma.meetingShare.findMany({
      where: { meetingId },
      include: {
        user: { select: { id: true, email: true, name: true, role: true } },
        grantedBy: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    return shares.map((share) => ({
      id: share.id,
      userId: share.user.id,
      email: share.user.email,
      name: share.user.name,
      role: share.user.role,
      permission: share.permission,
      grantedBy: share.grantedBy.name,
      createdAt: share.createdAt.toISOString(),
    }));
  }

  /**
   * 共享会议给某个用户；已共享过则更新权限。
   *
   * 用 upsert 实现「重复分享即改权限」，避免同一会议对同一用户
   * 出现两条授权记录导致权限判定歧义。
   */
  async shareMeeting(
    meetingId: number,
    targetUserId: number,
    permission: SharePermissionInput,
    user: AuthenticatedUser,
  ) {
    await assertCanOwn(this.prisma, user, meetingId);

    if (permission !== 'READ' && permission !== 'EDIT') {
      throw new BadRequestException('共享权限只能是 READ 或 EDIT');
    }

    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, name: true, email: true, isActive: true },
    });

    if (!target) {
      throw new NotFoundException('被共享的用户不存在');
    }

    if (!target.isActive) {
      throw new BadRequestException('该用户已被停用，无法共享');
    }

    // 共享给自己没有意义，且会让「拥有者」与「被共享者」身份重叠
    if (target.id === user.id) {
      throw new BadRequestException('不能把会议共享给自己');
    }

    const meeting = await this.prisma.meeting.findUnique({
      where: { id: meetingId },
      select: { ownerId: true },
    });

    if (meeting && meeting.ownerId === targetUserId) {
      throw new BadRequestException('该用户已经是会议拥有者');
    }

    const share = await this.prisma.meetingShare.upsert({
      where: {
        meetingId_userId: { meetingId, userId: targetUserId },
      },
      create: {
        meetingId,
        userId: targetUserId,
        permission,
        grantedById: user.id,
      },
      update: {
        permission,
        grantedById: user.id,
      },
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
    });

    return {
      id: share.id,
      userId: share.user.id,
      name: share.user.name,
      email: share.user.email,
      permission: share.permission,
      createdAt: share.createdAt.toISOString(),
    };
  }

  /**
   * 撤销共享。
   *
   * 归属者可以撤销自己会议的任何共享；
   * 被共享者也可以撤销「自己」的访问（相当于主动退出共享）。
   */
  async revokeShare(
    meetingId: number,
    targetUserId: number,
    user: AuthenticatedUser,
  ) {
    const isSelf = targetUserId === user.id;
    const isPrivileged = hasGlobalMeetingAccess(user);

    if (!isSelf && !isPrivileged) {
      // 非本人操作时要求是会议归属者
      await assertCanOwn(this.prisma, user, meetingId);
    }

    if (isSelf && !isPrivileged) {
      // 主动退出共享时至少要能访问到这场会议
      const own = await this.prisma.meeting.findFirst({
        where: { id: meetingId, ownerId: user.id },
        select: { id: true },
      });

      if (own) {
        throw new ForbiddenException('你是该会议的拥有者，无需退出共享');
      }
    }

    const existing = await this.prisma.meetingShare.findUnique({
      where: { meetingId_userId: { meetingId, userId: targetUserId } },
      select: { id: true },
    });

    if (!existing) {
      throw new NotFoundException('该用户未被共享此会议');
    }

    await this.prisma.meetingShare.delete({ where: { id: existing.id } });

    return { message: '已撤销共享', meetingId, userId: targetUserId };
  }
}
