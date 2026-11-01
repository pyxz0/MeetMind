/**
 * @nestjs/common 是纯 ESM，Node 22 下 Jest require 不了。
 * 这里只需要两个异常类，给最小实现即可 —— 被测的是判定逻辑，
 * 不是 Nest 的异常序列化。
 */
jest.mock('@nestjs/common', () => {
  class HttpException extends Error {
    constructor(
      public readonly response?: unknown,
      public readonly status?: number,
    ) {
      super(String(response));
    }
  }

  return {
    HttpException,
    ForbiddenException: class extends HttpException {},
    NotFoundException: class extends HttpException {},
  };
});

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../common/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.decorators';
import type { AppRole } from '../auth/permissions';
import {
  computeMeetingCapabilities,
  resolveMeetingAccess,
  assertCanRead,
  assertCanWrite,
  assertCanOwn,
  assertCanToggleAudio,
} from './meetings.access';

const user = (id: number, role: AppRole = 'USER'): AuthenticatedUser => ({
  id,
  phone: `1390000${String(id).padStart(4, '0')}`,
  name: `用户${id}`,
  role,
  isActive: true,
});

/** 只 mock 判定会碰到的三个查询，其余一律不用 */
const buildPrisma = (params: {
  meeting?: { ownerId: number; audioOpen?: boolean; leaderIds?: number[] } | null;
  member?: boolean;
  share?: 'READ' | 'EDIT' | null;
}) => {
  const meeting =
    params.meeting === null
      ? null
      : {
          id: 1,
          ownerId: params.meeting?.ownerId ?? 100,
          audioOpen: params.meeting?.audioOpen ?? false,
          leaders: (params.meeting?.leaderIds ?? []).map((userId) => ({
            userId,
          })),
        };

  return {
    meeting: { findUnique: jest.fn().mockResolvedValue(meeting) },
    meetingMember: {
      findUnique: jest
        .fn()
        .mockResolvedValue(params.member ? { id: 1 } : null),
    },
    meetingShare: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          params.share ? { permission: params.share } : null,
        ),
    },
  } as unknown as PrismaService;
};

describe('computeMeetingCapabilities', () => {
  const caps = (access: Parameters<typeof computeMeetingCapabilities>[0]['access'], role: AppRole, audioOpen = false) =>
    computeMeetingCapabilities({ user: user(1, role), access, audioOpen });

  it('创建者：全能，且录音关着也能听', () => {
    const c = caps('owner', 'USER', false);

    expect(c).toMatchObject({
      canRead: true,
      canEdit: true,
      canEditTodos: true,
      canManageMembers: true,
      canToggleAudio: true,
      canListenAudio: true,
      canDelete: true,
      canShare: true,
    });
  });

  it('负责人：能改会议与成员，但不能删、不能管共享', () => {
    const c = caps('leader', 'USER');

    expect(c.canEdit).toBe(true);
    expect(c.canManageMembers).toBe(true);
    expect(c.canDelete).toBe(false);
    expect(c.canShare).toBe(false);
  });

  it('普通成员：只能读和勾待办', () => {
    const c = caps('member', 'USER');

    expect(c.canRead).toBe(true);
    expect(c.canEditTodos).toBe(true);
    expect(c.canEdit).toBe(false);
    expect(c.canManageMembers).toBe(false);
  });

  it('录音听权只由「身份」或「开关」决定，不因能编辑就自动放开', () => {
    // 共享编辑者没有 audioOpen 就听不到
    expect(caps('edit', 'USER', false).canListenAudio).toBe(false);
    expect(caps('edit', 'USER', true).canListenAudio).toBe(true);
    expect(caps('read', 'USER', false).canListenAudio).toBe(false);
    expect(caps('read', 'USER', true).canListenAudio).toBe(true);
  });

  it('管理员：能改能删，但不算「拥有」，也不该动录音开关', () => {
    const c = caps('edit', 'ADMIN');

    expect(c.canEdit).toBe(true);
    expect(c.canDelete).toBe(true);
    expect(c.canManageMembers).toBe(true);
    expect(c.canShare).toBe(true);
    expect(c.isOwner).toBe(false);
    // 录音开关只放给负责人/创建者/超管
    expect(c.canToggleAudio).toBe(false);
  });

  it('超管：录音开关与听权始终放开', () => {
    const c = caps('read', 'SUPER_ADMIN', false);

    expect(c.canToggleAudio).toBe(true);
    expect(c.canListenAudio).toBe(true);
  });
});

describe('resolveMeetingAccess', () => {
  it('会议不存在时返回 null（不区分「不存在」和「无权限」）', async () => {
    const prisma = buildPrisma({ meeting: null });

    await expect(resolveMeetingAccess(prisma, user(1), 1)).resolves.toBeNull();
  });

  it('创建者优先：即使同时是负责人也按 owner 计', async () => {
    const prisma = buildPrisma({
      meeting: { ownerId: 1, leaderIds: [1] },
    });

    const result = await resolveMeetingAccess(prisma, user(1), 1);

    expect(result?.access).toBe('owner');
  });

  it('负责人判定先于全局权限，保留「这是我自己主持的会」语义', async () => {
    const prisma = buildPrisma({
      meeting: { ownerId: 100, leaderIds: [2] },
    });

    const result = await resolveMeetingAccess(prisma, user(2, 'ADMIN'), 1);

    expect(result?.access).toBe('leader');
  });

  it('管理员对无关系会议拿到 edit', async () => {
    const prisma = buildPrisma({ meeting: { ownerId: 100 } });

    const result = await resolveMeetingAccess(prisma, user(3, 'ADMIN'), 1);

    expect(result?.access).toBe('edit');
  });

  it('普通成员得到 member', async () => {
    const prisma = buildPrisma({ meeting: { ownerId: 100 }, member: true });

    const result = await resolveMeetingAccess(prisma, user(4), 1);

    expect(result?.access).toBe('member');
  });

  it('共享区分读与编辑', async () => {
    const read = await resolveMeetingAccess(
      buildPrisma({ meeting: { ownerId: 100 }, share: 'READ' }),
      user(5),
      1,
    );
    const edit = await resolveMeetingAccess(
      buildPrisma({ meeting: { ownerId: 100 }, share: 'EDIT' }),
      user(5),
      1,
    );

    expect(read?.access).toBe('read');
    expect(edit?.access).toBe('edit');
  });

  /** 这条是数据隔离的底线：什么关系都没有的人必须拿不到 */
  it('无任何关系的普通用户拿到 null', async () => {
    const prisma = buildPrisma({ meeting: { ownerId: 100 } });

    await expect(resolveMeetingAccess(prisma, user(6), 1)).resolves.toBeNull();
  });
});

describe('权限断言', () => {
  it('无权访问抛 404 而不是 403（避免探测会议是否存在）', async () => {
    const prisma = buildPrisma({ meeting: null });

    await expect(assertCanRead(prisma, user(1), 1)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('只读共享能读但不能写', async () => {
    const prisma = buildPrisma({ meeting: { ownerId: 100 }, share: 'READ' });

    await expect(assertCanRead(prisma, user(5), 1)).resolves.toBeTruthy();
    await expect(assertCanWrite(prisma, user(5), 1)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('负责人不能删除会议（删除走「拥有」判定）', async () => {
    const prisma = buildPrisma({
      meeting: { ownerId: 100, leaderIds: [2] },
    });

    await expect(assertCanOwn(prisma, user(2), 1)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('管理员可以代为管理他人会议，但普通成员不行', async () => {
    await expect(
      assertCanOwn(
        buildPrisma({ meeting: { ownerId: 100 } }),
        user(9, 'ADMIN'),
        1,
      ),
    ).resolves.toEqual({ ownerId: 100 });

    await expect(
      assertCanOwn(
        buildPrisma({ meeting: { ownerId: 100 }, member: true }),
        user(4),
        1,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('录音开关只有创建者、负责人与超管能碰', async () => {
    // 普通成员不行
    await expect(
      assertCanToggleAudio(
        buildPrisma({ meeting: { ownerId: 100 }, member: true }),
        user(4),
        1,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // 管理员也不行：他能改会议，但录音开关属于主持人的权限
    await expect(
      assertCanToggleAudio(
        buildPrisma({ meeting: { ownerId: 100 } }),
        user(9, 'ADMIN'),
        1,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // 负责人可以
    await expect(
      assertCanToggleAudio(
        buildPrisma({ meeting: { ownerId: 100, leaderIds: [2] } }),
        user(2),
        1,
      ),
    ).resolves.toBeTruthy();
  });
});
