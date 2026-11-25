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
import type { AppRole, TenantRoleName } from '../auth/permissions';
import {
  computeMeetingCapabilities,
  resolveMeetingAccess,
  assertCanRead,
  assertCanWrite,
  assertCanOwn,
  assertCanToggleAudio,
} from './meetings.access';

/** 两个固定租户 id，测试里靠它们区分「同租户 / 跨租户」 */
const COMPANY_A = '00000000-0000-0000-0000-00000000000a';
const COMPANY_B = '00000000-0000-0000-0000-00000000000b';
const PERSONAL = '00000000-0000-0000-0000-0000000000f1';

/** 造一个指定身份的登录用户；默认是企业 A 的普通成员 */
const user = (
  id: number,
  role: AppRole = 'USER',
  opts: {
    tenantRole?: TenantRoleName | null;
    tenantType?: 'PERSONAL' | 'COMPANY';
    tenantId?: string;
  } = {},
): AuthenticatedUser => {
  const tenantId = opts.tenantId ?? COMPANY_A;
  const tenantType = opts.tenantType ?? 'COMPANY';
  const tenantRole =
    opts.tenantRole === undefined ? ('MEMBER' as TenantRoleName) : opts.tenantRole;

  return {
    id,
    phone: `1390000${String(id).padStart(4, '0')}`,
    name: `用户${id}`,
    role,
    isActive: true,
    activeTenantId: tenantId,
    tenantRole,
    tenantType,
    memberships:
      tenantRole === null
        ? []
        : [{ tenantId, role: tenantRole, type: tenantType }],
  };
};

/** 只 mock 判定会碰到的三个查询，其余一律不用 */
const buildPrisma = (params: {
  meeting?: {
    ownerId: number;
    audioOpen?: boolean;
    leaderIds?: number[];
    /** 会议归属的空间；默认与 user() 的默认空间一致，即"同租户" */
    tenantId?: string;
    tenantType?: 'COMPANY' | 'PERSONAL';
  } | null;
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
          tenantId: params.meeting?.tenantId ?? COMPANY_A,
          tenant: { type: params.meeting?.tenantType ?? 'COMPANY' },
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
  const caps = (
    access: Parameters<typeof computeMeetingCapabilities>[0]['access'],
    u: AuthenticatedUser,
    audioOpen = false,
  ) => computeMeetingCapabilities({ user: u, access, audioOpen });

  it('创建者：全能，且录音关着也能听', () => {
    const c = caps('owner', user(1), false);

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
    const c = caps('leader', user(1));

    expect(c.canEdit).toBe(true);
    expect(c.canManageMembers).toBe(true);
    expect(c.canDelete).toBe(false);
    expect(c.canShare).toBe(false);
  });

  it('普通成员：只能读和勾待办', () => {
    const c = caps('member', user(1));

    expect(c.canRead).toBe(true);
    expect(c.canEditTodos).toBe(true);
    expect(c.canEdit).toBe(false);
    expect(c.canManageMembers).toBe(false);
  });

  it('录音听权只由「身份」或「开关」决定，不因能编辑就自动放开', () => {
    expect(caps('edit', user(1), false).canListenAudio).toBe(false);
    expect(caps('edit', user(1), true).canListenAudio).toBe(true);
    expect(caps('read', user(1), false).canListenAudio).toBe(false);
    expect(caps('read', user(1), true).canListenAudio).toBe(true);
  });

  it('租户管理员：能改能删，但不算「拥有」，也不该动录音开关', () => {
    const c = caps('edit', user(1, 'USER', { tenantRole: 'ADMIN' }));

    expect(c.canEdit).toBe(true);
    expect(c.canDelete).toBe(true);
    expect(c.canManageMembers).toBe(true);
    expect(c.canShare).toBe(true);
    expect(c.isOwner).toBe(false);
    // 录音开关只放给负责人/创建者
    expect(c.canToggleAudio).toBe(false);
  });

  /**
   * 多租户后的行为变化：**平台超管不再天然拥有会议能力**。
   *
   * 他要看某家企业的会议，只能以该成员身份进入（impersonate），
   * 那时身份就是那个成员，而不是"超管"。
   */
  it('平台超管不在租户里时：没有任何会议能力，录音也碰不了', () => {
    const superAdmin = user(1, 'SUPER_ADMIN', { tenantRole: null });
    const c = caps('read', superAdmin, false);

    expect(c.canEdit).toBe(false);
    expect(c.canDelete).toBe(false);
    expect(c.canToggleAudio).toBe(false);
    expect(c.canListenAudio).toBe(false);
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

  it('负责人判定先于租户管理员，保留「这是我自己主持的会」语义', async () => {
    const prisma = buildPrisma({
      meeting: { ownerId: 100, leaderIds: [2] },
    });

    const result = await resolveMeetingAccess(
      prisma,
      user(2, 'USER', { tenantRole: 'ADMIN' }),
      1,
    );

    expect(result?.access).toBe('leader');
  });

  it('同租户的管理员对无关系会议拿到 edit', async () => {
    const prisma = buildPrisma({ meeting: { ownerId: 100 } });

    const result = await resolveMeetingAccess(
      prisma,
      user(3, 'USER', { tenantRole: 'ADMIN' }),
      1,
    );

    expect(result?.access).toBe('edit');
  });

  /**
   * 隔离的底线用例：B 企业的管理员不能碰 A 企业的会议。
   * 如果这条挂了，说明「管理员分支没带租户」。
   */
  it('跨租户的管理员拿到 null —— 即使他是另一个企业里权限最高的人', async () => {
    const prisma = buildPrisma({
      meeting: { ownerId: 100, tenantId: COMPANY_A },
    });

    const result = await resolveMeetingAccess(
      prisma,
      user(9, 'USER', { tenantRole: 'OWNER', tenantId: COMPANY_B }),
      1,
    );

    expect(result).toBeNull();
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

  /**
   * 离职场景：他仍然是 meeting.owner_id，但已经不是企业成员。
   * 这条必须在 owner 判断**之前**拦住，否则离职员工还能看公司会议。
   */
  it('企业会议的创建者被移出企业后拿到 null（离职失效）', async () => {
    const prisma = buildPrisma({
      meeting: { ownerId: 7, tenantId: COMPANY_A },
    });

    // 他现在的 activeTenantId 是个人空间，不是会议所属的企业
    const resigned = user(7, 'USER', {
      tenantRole: 'OWNER',
      tenantId: PERSONAL,
      tenantType: 'PERSONAL',
    });

    await expect(resolveMeetingAccess(prisma, resigned, 1)).resolves.toBeNull();
  });

  /**
   * 个人会议的受邀好友：他不是这场会议所属空间的成员，
   * 但参与者关系本身就是授权。这条验证「tenant_id 不是访问边界」。
   */
  it('个人会议：被邀请的好友（不属于该空间）仍能访问', async () => {
    const prisma = buildPrisma({
      meeting: { ownerId: 8, tenantId: PERSONAL, tenantType: 'PERSONAL' },
      member: true,
    });

    const friend = user(11, 'USER', {
      tenantRole: 'MEMBER',
      tenantId: COMPANY_B,
    });

    const result = await resolveMeetingAccess(prisma, friend, 1);

    expect(result?.access).toBe('member');
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

  it('租户管理员可以代为管理他人会议，但普通成员不行', async () => {
    await expect(
      assertCanOwn(
        buildPrisma({ meeting: { ownerId: 100 } }),
        user(9, 'USER', { tenantRole: 'ADMIN' }),
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

  it('录音开关只有创建者与负责人能碰', async () => {
    // 普通成员不行
    await expect(
      assertCanToggleAudio(
        buildPrisma({ meeting: { ownerId: 100 }, member: true }),
        user(4),
        1,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // 租户管理员也不行：他能改会议，但录音开关属于主持人的权限
    await expect(
      assertCanToggleAudio(
        buildPrisma({ meeting: { ownerId: 100 } }),
        user(9, 'USER', { tenantRole: 'ADMIN' }),
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
