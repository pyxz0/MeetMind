/**
 * @nestjs/common 是纯 ESM，Node 22 下 Jest require 不了。
 * 这里只需要两个异常类，给最小实现即可 —— 被测的是判定逻辑。
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
    BadRequestException: class extends HttpException {},
    NotFoundException: class extends HttpException {},
  };
});

import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../common/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.decorators';
import { assertInvitable, resolveMeetingSpace } from './meetings.invite';

const COMPANY_A = '00000000-0000-0000-0000-00000000000a';
const COMPANY_B = '00000000-0000-0000-0000-00000000000b';
const PERSONAL = '00000000-0000-0000-0000-0000000000f1';

const user = (opts: {
  activeTenantId?: string;
  memberships?: AuthenticatedUser['memberships'];
} = {}): AuthenticatedUser => {
  const activeTenantId = opts.activeTenantId ?? COMPANY_A;
  const memberships = opts.memberships ?? [
    { tenantId: COMPANY_A, role: 'MEMBER' as const, type: 'COMPANY' as const },
    { tenantId: PERSONAL, role: 'OWNER' as const, type: 'PERSONAL' as const },
  ];

  return {
    id: 1,
    phone: '13900000001',
    name: '测试用户',
    role: 'USER',
    isActive: true,
    activeTenantId,
    tenantRole: 'MEMBER',
    tenantType: 'COMPANY',
    memberships,
  };
};

describe('resolveMeetingSpace', () => {
  it('不传 tenantId 时用当前空间', () => {
    expect(resolveMeetingSpace(user())).toEqual({
      tenantId: COMPANY_A,
      tenantType: 'COMPANY',
    });
  });

  it('传自己的另一个空间时用它，并带出正确类型', () => {
    expect(resolveMeetingSpace(user(), PERSONAL)).toEqual({
      tenantId: PERSONAL,
      tenantType: 'PERSONAL',
    });
  });

  /**
   * 核心越权防护：前端传别人的空间 id，必须被拒。
   * 用 404 而不是 403 —— 403 会告诉攻击者「这个空间确实存在」。
   */
  it('传不属于自己的空间时抛 404', () => {
    expect(() => resolveMeetingSpace(user(), COMPANY_B)).toThrow(
      NotFoundException,
    );
  });

  it('没有空间归属的用户（平台超管）连自己的 active 都用不了', () => {
    expect(() =>
      resolveMeetingSpace(
        user({ activeTenantId: COMPANY_A, memberships: [] }),
      ),
    ).toThrow(NotFoundException);
  });
});

describe('assertInvitable', () => {
  const buildPrisma = (counts: {
    members?: number;
    friends?: number;
  }): PrismaService =>
    ({
      membership: { count: jest.fn().mockResolvedValue(counts.members ?? 0) },
      friendship: { count: jest.fn().mockResolvedValue(counts.friends ?? 0) },
    }) as unknown as PrismaService;

  const companySpace = { tenantId: COMPANY_A, tenantType: 'COMPANY' as const };
  const personalSpace = { tenantId: PERSONAL, tenantType: 'PERSONAL' as const };

  it('空数组直接返回，不查库', async () => {
    const prisma = buildPrisma({});

    await expect(
      assertInvitable(prisma, user(), companySpace, []),
    ).resolves.toBeUndefined();

    expect(prisma.membership.count).not.toHaveBeenCalled();
  });

  it('企业会议：都是本企业成员时通过', async () => {
    const prisma = buildPrisma({ members: 2 });

    await expect(
      assertInvitable(prisma, user(), companySpace, [10, 11]),
    ).resolves.toBeUndefined();
  });

  it('企业会议：有一个不是成员就拒绝', async () => {
    const prisma = buildPrisma({ members: 1 });

    await expect(
      assertInvitable(prisma, user(), companySpace, [10, 11]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('个人会议：都是好友时通过', async () => {
    const prisma = buildPrisma({ friends: 1 });

    await expect(
      assertInvitable(prisma, user(), personalSpace, [20]),
    ).resolves.toBeUndefined();
  });

  it('个人会议：不是好友就拒绝', async () => {
    const prisma = buildPrisma({ friends: 0 });

    await expect(
      assertInvitable(prisma, user(), personalSpace, [20]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  /**
   * 个人会议不走 membership 查询 —— 好友本来就不在同一个空间。
   * 这条防的是「有人图省事把两个分支写成一样的」。
   */
  it('个人会议不查 membership，企业会议不查 friendship', async () => {
    const personal = buildPrisma({ friends: 1 });
    await assertInvitable(personal, user(), personalSpace, [20]);
    expect(personal.membership.count).not.toHaveBeenCalled();

    const company = buildPrisma({ members: 1 });
    await assertInvitable(company, user(), companySpace, [10]);
    expect(company.friendship.count).not.toHaveBeenCalled();
  });

  it('重复的 id 去重后再校验，不会因为数组里有重复而误判', async () => {
    const prisma = buildPrisma({ members: 1 });

    await expect(
      assertInvitable(prisma, user(), companySpace, [10, 10, 10]),
    ).resolves.toBeUndefined();

    expect(prisma.membership.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: { in: [10] } }),
      }),
    );
  });

  /**
   * 创建者自己会被默认加进负责人列表，不能要求「他是自己的好友」。
   * 不排除的话个人会议永远建不起来 —— 端到端测试里真实踩到过。
   */
  it('把自己排除在外：创建者不需要是自己的好友', async () => {
    const prisma = buildPrisma({ friends: 1 });

    await expect(
      assertInvitable(prisma, user(), personalSpace, [1, 20]),
    ).resolves.toBeUndefined();

    expect(prisma.friendship.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ friendId: { in: [20] } }),
      }),
    );
  });

  it('只有自己一个人时直接返回，不查库', async () => {
    const prisma = buildPrisma({});

    await assertInvitable(prisma, user(), personalSpace, [1]);

    expect(prisma.friendship.count).not.toHaveBeenCalled();
    expect(prisma.membership.count).not.toHaveBeenCalled();
  });
});
