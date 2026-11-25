/**
 * @nestjs/common 是纯 ESM，Node 22 下 Jest require 不了。
 * 这里只需要几个异常类，给最小实现即可 —— 被测的是业务规则。
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
    ForbiddenException: class extends HttpException {},
    NotFoundException: class extends HttpException {},
    /**
     * 装饰器空实现。
     *
     * 这里 import 的 TenantsService 会连带加载 PrismaService / AuditService，
     * 它们的 `@Injectable()` 在模块求值时就执行 —— 少了这个会报
     * "Injectable is not a function"。
     */
    Injectable: () => () => undefined,
    SetMetadata: () => () => undefined,
  };
});

import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { PrismaService } from '../common/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth.decorators';
import { TenantsService } from './tenants.service';

const COMPANY = '00000000-0000-0000-0000-00000000000a';
const OTHER_COMPANY = '00000000-0000-0000-0000-00000000000b';
const PERSONAL = '00000000-0000-0000-0000-0000000000f1';

const user = (over: Partial<AuthenticatedUser> = {}): AuthenticatedUser => ({
  id: 1,
  phone: '13900000001',
  name: '张三',
  role: 'USER',
  isActive: true,
  activeTenantId: PERSONAL,
  tenantRole: 'OWNER',
  tenantType: 'PERSONAL',
  memberships: [
    { tenantId: PERSONAL, role: 'OWNER', type: 'PERSONAL' },
  ],
  ...over,
});

/**
 * 构造一个最小 Prisma mock。
 *
 * `$transaction` 直接把回调执行掉，并把自身当 tx 传进去 ——
 * 这样服务层里的 `this.prisma.$transaction(async (tx) => ...)` 能照常跑。
 */
const buildPrisma = (over: Record<string, any> = {}) => {
  const prisma: any = {
    membership: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    tenant: {
      create: jest.fn().mockResolvedValue({
        id: COMPANY,
        name: '测试公司',
        type: 'COMPANY',
      }),
    },
    tenantInvite: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({
        id: 1,
        phone: null,
        role: 'MEMBER',
        maxUses: 1,
      }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    /** 邀请次数扣减用的是原生 SQL，mock 成"扣成功" */
    $queryRaw: jest.fn().mockResolvedValue([{ used_count: 1 }]),
    user: {
      update: jest.fn().mockResolvedValue({}),
    },
    ...over,
  };

  prisma.$transaction = jest.fn(async (arg: any) =>
    typeof arg === 'function' ? arg(prisma) : Promise.all(arg),
  );

  return prisma as PrismaService & typeof prisma;
};

const buildAudit = (): AuditService =>
  ({ record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService);

describe('TenantsService.create', () => {
  it('已在某个企业里时拒绝创建第二个', async () => {
    const prisma = buildPrisma();
    prisma.membership.findFirst.mockResolvedValue({
      role: 'MEMBER',
      tenant: { name: '某某科技' },
    });

    const service = new TenantsService(prisma, buildAudit());

    await expect(
      service.create(user(), { name: '新公司' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  /**
   * 建企业的三件事必须在一个事务里：建租户、建 OWNER 关系、切 active。
   * 少了第三条，用户建完企业还停在个人空间，会以为没建成功。
   */
  it('创建成功后自己是 OWNER 并切到新空间', async () => {
    const prisma = buildPrisma();
    prisma.membership.findFirst.mockResolvedValue(null);

    const audit = buildAudit();
    const service = new TenantsService(prisma, audit);

    const result = await service.create(user(), { name: '  测试公司  ' });

    expect(prisma.tenant.create).toHaveBeenCalledWith({
      data: { name: '测试公司', type: 'COMPANY' },
    });
    expect(prisma.membership.create).toHaveBeenCalledWith({
      data: { tenantId: COMPANY, userId: 1, role: 'OWNER' },
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { activeTenantId: COMPANY },
    });
    expect(result).toMatchObject({
      id: COMPANY,
      role: 'OWNER',
      isActive: true,
    });
    expect(audit.record).toHaveBeenCalled();
  });
});

describe('TenantsService.switchActive', () => {
  it('不是该空间成员时抛 404（不泄露空间是否存在）', async () => {
    const prisma = buildPrisma();
    prisma.membership.findUnique.mockResolvedValue(null);

    const service = new TenantsService(prisma, buildAudit());

    await expect(
      service.switchActive(user(), OTHER_COMPANY),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('切换成功时返回新的空间信息与权限位', async () => {
    const prisma = buildPrisma();
    prisma.membership.findUnique.mockResolvedValue({
      role: 'ADMIN',
      tenant: { id: COMPANY, name: '测试公司', type: 'COMPANY' },
    });

    const service = new TenantsService(prisma, buildAudit());
    const result = await service.switchActive(user(), COMPANY);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { activeTenantId: COMPANY },
    });
    expect(result.tenantRole).toBe('ADMIN');
    expect(result.permissions).toContain('meeting:read:all');
  });

  /** 已经在目标空间时不必再写库 */
  it('切换到当前空间时不发更新语句', async () => {
    const prisma = buildPrisma();
    prisma.membership.findUnique.mockResolvedValue({
      role: 'OWNER',
      tenant: { id: PERSONAL, name: '我的空间', type: 'PERSONAL' },
    });

    const service = new TenantsService(prisma, buildAudit());
    await service.switchActive(user({ activeTenantId: PERSONAL }), PERSONAL);

    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

describe('TenantsService.listMembers', () => {
  it('普通成员看不了成员列表（404）', async () => {
    const prisma = buildPrisma();
    prisma.membership.findUnique.mockResolvedValue({ role: 'MEMBER' });

    const service = new TenantsService(prisma, buildAudit());

    await expect(
      service.listMembers(user(), COMPANY),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('管理员能拿到带角色的成员列表', async () => {
    const prisma = buildPrisma();
    prisma.membership.findUnique.mockResolvedValue({ role: 'ADMIN' });
    prisma.membership.findMany.mockResolvedValue([
      {
        role: 'OWNER',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        user: { id: 2, name: '李四', phone: '13900000002', avatar: null, isActive: true },
      },
    ]);

    const service = new TenantsService(prisma, buildAudit());
    const rows = await service.listMembers(user(), COMPANY);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 2, role: 'OWNER' });
  });
});

describe('TenantsService.removeMember', () => {
  const adminUser = user({ activeTenantId: COMPANY });

  it('不能移除自己', async () => {
    const prisma = buildPrisma();
    prisma.membership.findUnique.mockResolvedValue({ role: 'OWNER' });

    const service = new TenantsService(prisma, buildAudit());

    await expect(
      service.removeMember(adminUser, COMPANY, 1),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('不能移除空间所有者', async () => {
    const prisma = buildPrisma();
    // 第一次是操作者自己，第二次是目标成员
    prisma.membership.findUnique
      .mockResolvedValueOnce({ role: 'ADMIN' })
      .mockResolvedValueOnce({
        role: 'OWNER',
        user: { id: 2, name: '李四', activeTenantId: COMPANY },
      });

    const service = new TenantsService(prisma, buildAudit());

    await expect(
      service.removeMember(adminUser, COMPANY, 2),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('ADMIN 不能移除另一个 ADMIN', async () => {
    const prisma = buildPrisma();
    prisma.membership.findUnique
      .mockResolvedValueOnce({ role: 'ADMIN' })
      .mockResolvedValueOnce({
        role: 'ADMIN',
        user: { id: 2, name: '李四', activeTenantId: COMPANY },
      });

    const service = new TenantsService(prisma, buildAudit());

    await expect(
      service.removeMember(adminUser, COMPANY, 2),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('移除目标不存在时 404', async () => {
    const prisma = buildPrisma();
    prisma.membership.findUnique
      .mockResolvedValueOnce({ role: 'OWNER' })
      .mockResolvedValueOnce(null);

    const service = new TenantsService(prisma, buildAudit());

    await expect(
      service.removeMember(adminUser, COMPANY, 99),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  /**
   * 关键行为：被移除的人的 active 若指向这个空间，必须回落到个人空间。
   * 不回落的后果是守卫直接 401 —— 他表现为"登录了但什么都打不开"。
   */
  it('移除后把对方的当前空间回落到个人空间', async () => {
    const prisma = buildPrisma();
    prisma.membership.findUnique
      .mockResolvedValueOnce({ role: 'OWNER' })
      .mockResolvedValueOnce({
        role: 'MEMBER',
        user: { id: 2, name: '李四', activeTenantId: COMPANY },
      });
    prisma.membership.findFirst.mockResolvedValue({ tenantId: PERSONAL });

    const service = new TenantsService(prisma, buildAudit());
    await service.removeMember(adminUser, COMPANY, 2);

    expect(prisma.membership.delete).toHaveBeenCalledWith({
      where: { tenantId_userId: { tenantId: COMPANY, userId: 2 } },
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 2 },
      data: { activeTenantId: PERSONAL },
    });
  });

  /** 对方的 active 不在这里时不要多此一举改他的状态 */
  it('对方当前空间不是这里时不改他的 active', async () => {
    const prisma = buildPrisma();
    prisma.membership.findUnique
      .mockResolvedValueOnce({ role: 'OWNER' })
      .mockResolvedValueOnce({
        role: 'MEMBER',
        user: { id: 2, name: '李四', activeTenantId: PERSONAL },
      });

    const service = new TenantsService(prisma, buildAudit());
    await service.removeMember(adminUser, COMPANY, 2);

    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

describe('TenantsService.listMine', () => {
  it('标出当前空间', async () => {
    const prisma = buildPrisma();
    prisma.membership.findMany.mockResolvedValue([
      {
        role: 'OWNER',
        createdAt: new Date(),
        tenant: { id: PERSONAL, name: '我的空间', type: 'PERSONAL', _count: { memberships: 1 } },
      },
      {
        role: 'MEMBER',
        createdAt: new Date(),
        tenant: { id: COMPANY, name: '测试公司', type: 'COMPANY', _count: { memberships: 5 } },
      },
    ]);

    const service = new TenantsService(prisma, buildAudit());
    const rows = await service.listMine(user({ activeTenantId: COMPANY }));

    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === COMPANY)?.isActive).toBe(true);
    expect(rows.find((r) => r.id === PERSONAL)?.isActive).toBe(false);
    expect(rows.find((r) => r.id === COMPANY)?.memberCount).toBe(5);
  });
});

describe('TenantsService.createInvite', () => {
  it('不能邀请所有者 —— 转让是独立操作，不能走链接', async () => {
    const prisma = buildPrisma();
    prisma.membership.findUnique.mockResolvedValue({ role: 'OWNER' });

    const service = new TenantsService(prisma, buildAudit());

    await expect(
      service.createInvite(user(), COMPANY, { role: 'OWNER' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('管理员不能邀请管理员，只有所有者可以', async () => {
    const prisma = buildPrisma();
    prisma.membership.findUnique.mockResolvedValue({ role: 'ADMIN' });

    const service = new TenantsService(prisma, buildAudit());

    await expect(
      service.createInvite(user(), COMPANY, { role: 'ADMIN' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  /**
   * 库里只能有哈希：明文一旦落库，任何能读表的人都能造出可用链接。
   */
  it('返回明文令牌，但入库的是它的哈希', async () => {
    const prisma = buildPrisma();
    prisma.membership.findUnique.mockResolvedValue({ role: 'OWNER' });

    const service = new TenantsService(prisma, buildAudit());
    const result = await service.createInvite(user(), COMPANY, {});

    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const stored = prisma.tenantInvite.create.mock.calls[0][0].data;

    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.tokenHash).not.toBe(result.token);
  });

  it('次数上限被夹到 1..50', async () => {
    const prisma = buildPrisma();
    prisma.membership.findUnique.mockResolvedValue({ role: 'OWNER' });

    const service = new TenantsService(prisma, buildAudit());

    await service.createInvite(user(), COMPANY, { maxUses: 999 });

    expect(prisma.tenantInvite.create.mock.calls[0][0].data.maxUses).toBe(50);
  });
});

describe('TenantsService.acceptInvite', () => {
  const invite = (over: Record<string, unknown> = {}) => ({
    id: 7,
    tenantId: COMPANY,
    phone: null,
    role: 'MEMBER',
    maxUses: 1,
    usedCount: 0,
    expiresAt: new Date(Date.now() + 86400_000),
    tenant: { name: '测试公司' },
    ...over,
  });

  it('令牌无效时 404', async () => {
    const prisma = buildPrisma();
    prisma.tenantInvite.findUnique.mockResolvedValue(null);

    const service = new TenantsService(prisma, buildAudit());

    await expect(service.acceptInvite(user(), 'x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('已过期时 400', async () => {
    const prisma = buildPrisma();
    prisma.tenantInvite.findUnique.mockResolvedValue(
      invite({ expiresAt: new Date(Date.now() - 1000) }),
    );

    const service = new TenantsService(prisma, buildAudit());

    await expect(service.acceptInvite(user(), 'x')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('指定了手机号时，别的号不能用', async () => {
    const prisma = buildPrisma();
    prisma.tenantInvite.findUnique.mockResolvedValue(
      invite({ phone: '13800000000' }),
    );

    const service = new TenantsService(prisma, buildAudit());

    await expect(service.acceptInvite(user(), 'x')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  /** 一人一企业：已在别家时拒绝，并告诉他现在在哪家 */
  it('已属于别的企业时拒绝', async () => {
    const prisma = buildPrisma();
    prisma.tenantInvite.findUnique.mockResolvedValue(invite());
    prisma.membership.findUnique.mockResolvedValue(null);
    prisma.membership.findFirst.mockResolvedValue({
      tenant: { name: '另一家公司' },
    });

    const service = new TenantsService(prisma, buildAudit());

    await expect(service.acceptInvite(user(), 'x')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  /**
   * 已经在里面时幂等返回，且**不扣次数** ——
   * 用户很可能只是又点了一次链接。
   */
  it('已是成员时幂等成功，不消耗次数', async () => {
    const prisma = buildPrisma();
    prisma.tenantInvite.findUnique.mockResolvedValue(invite());
    prisma.membership.findUnique.mockResolvedValue({ role: 'MEMBER' });

    const service = new TenantsService(prisma, buildAudit());
    const result = await service.acceptInvite(user(), 'x');

    expect(result.alreadyMember).toBe(true);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.membership.create).not.toHaveBeenCalled();
  });

  /**
   * 链接用尽 / 过期之后，**本人**再点仍应看到"你已经是成员"。
   *
   * 否则加入成功后刷新一下页面就变成「邀请链接已被使用」，
   * 用户会以为自己没进去 —— 端到端测试里真实踩到过。
   */
  it('链接已用尽但本人已是成员时，仍返回幂等而不是报错', async () => {
    const prisma = buildPrisma();
    prisma.tenantInvite.findUnique.mockResolvedValue(
      invite({ usedCount: 1, maxUses: 1 }),
    );
    prisma.membership.findUnique.mockResolvedValue({ role: 'MEMBER' });

    const service = new TenantsService(prisma, buildAudit());
    const result = await service.acceptInvite(user(), 'x');

    expect(result.alreadyMember).toBe(true);
  });

  it('正常接受：建成员、切当前空间、扣一次', async () => {
    const prisma = buildPrisma();
    prisma.tenantInvite.findUnique.mockResolvedValue(invite());
    prisma.membership.findUnique.mockResolvedValue(null);
    prisma.membership.findFirst.mockResolvedValue(null);

    const service = new TenantsService(prisma, buildAudit());
    const result = await service.acceptInvite(user(), 'x');

    expect(prisma.membership.create).toHaveBeenCalledWith({
      data: { tenantId: COMPANY, userId: 1, role: 'MEMBER' },
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { activeTenantId: COMPANY },
    });
    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(result).toMatchObject({ tenantName: '测试公司', alreadyMember: false });
  });

  /**
   * 并发保护：原子扣减失败（链接刚被别人用掉）时，
   * 不能再建 membership —— 否则会出现超卖的成员。
   */
  it('原子扣减失败时不建 membership', async () => {
    const prisma = buildPrisma();
    prisma.tenantInvite.findUnique.mockResolvedValue(invite());
    prisma.membership.findUnique.mockResolvedValue(null);
    prisma.membership.findFirst.mockResolvedValue(null);
    prisma.$queryRaw.mockResolvedValue([]);

    const service = new TenantsService(prisma, buildAudit());

    await expect(service.acceptInvite(user(), 'x')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.membership.create).not.toHaveBeenCalled();
  });
});

describe('TenantsService.inspectInvite', () => {
  it('不存在时 404', async () => {
    const prisma = buildPrisma();
    prisma.tenantInvite.findUnique.mockResolvedValue(null);

    const service = new TenantsService(prisma, buildAudit());

    await expect(service.inspectInvite('x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('返回脱敏手机号与可用状态', async () => {
    const prisma = buildPrisma();
    prisma.tenantInvite.findUnique.mockResolvedValue({
      phone: '13812348888',
      role: 'MEMBER',
      maxUses: 1,
      usedCount: 0,
      expiresAt: new Date(Date.now() + 86400_000),
      tenant: { name: '测试公司', type: 'COMPANY' },
    });

    const service = new TenantsService(prisma, buildAudit());
    const info = await service.inspectInvite('x');

    expect(info).toMatchObject({
      tenantName: '测试公司',
      phoneMasked: '138****8888',
      valid: true,
      expired: false,
      usedUp: false,
    });
  });

  it('用尽时 valid=false', async () => {
    const prisma = buildPrisma();
    prisma.tenantInvite.findUnique.mockResolvedValue({
      phone: null,
      role: 'MEMBER',
      maxUses: 1,
      usedCount: 1,
      expiresAt: new Date(Date.now() + 86400_000),
      tenant: { name: '测试公司', type: 'COMPANY' },
    });

    const service = new TenantsService(prisma, buildAudit());
    const info = await service.inspectInvite('x');

    expect(info.valid).toBe(false);
    expect(info.usedUp).toBe(true);
  });
});
