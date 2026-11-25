import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth.decorators';
import type { TenantRoleName, TenantTypeName } from '../auth/permissions';
import { permissionsOf } from '../auth/permissions';
import {
  INVITE_TTL_DAYS,
  createInviteToken,
  hashInviteToken,
  maskPhone,
} from './invite-token';

/** 能管理成员的租户内角色 */
const MANAGER_ROLES: TenantRoleName[] = ['OWNER', 'ADMIN'];

@Injectable()
export class TenantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * 我的空间列表，供前端切换器渲染。
   *
   * 只返回自己所属的空间 —— 不做任何"可加入的空间"推荐，
   * 那等于把平台上有哪些企业暴露给每个人。
   */
  async listMine(user: AuthenticatedUser) {
    const rows = await this.prisma.membership.findMany({
      where: { userId: user.id },
      select: {
        role: true,
        createdAt: true,
        tenant: {
          select: {
            id: true,
            name: true,
            type: true,
            _count: { select: { memberships: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    return rows.map((row) => ({
      id: row.tenant.id,
      name: row.tenant.name,
      type: row.tenant.type as TenantTypeName,
      role: row.role as TenantRoleName,
      memberCount: row.tenant._count.memberships,
      /** 前端据此高亮当前空间 */
      isActive: row.tenant.id === user.activeTenantId,
    }));
  }

  /**
   * 创建企业空间，创建者成为 OWNER。
   *
   * **一人一企业**是产品约束（文档 §2.1）：允许一个人同时在多家公司，
   * 会让「按企业隔离数据」失去意义 —— 他到底代表哪家公司签字？
   * 这一条放在应用层而不是数据库，是为了将来放开时只改这一个判断。
   */
  async create(user: AuthenticatedUser, input: { name: string }) {
    const existing = await this.prisma.membership.findFirst({
      where: { userId: user.id, tenant: { type: 'COMPANY' } },
      select: { role: true, tenant: { select: { name: true } } },
    });

    if (existing) {
      throw new BadRequestException(
        `你已经属于企业「${existing.tenant.name}」，一个账号只能加入一个企业`,
      );
    }

    const tenant = await this.prisma.$transaction(async (tx) => {
      const created = await tx.tenant.create({
        data: { name: input.name.trim(), type: 'COMPANY' },
      });

      await tx.membership.create({
        data: { tenantId: created.id, userId: user.id, role: 'OWNER' },
      });

      /**
       * 建完直接切过去 —— 用户刚建完企业，接下来一定是在里面配置成员，
       * 让他还要手动切一次空间是没必要的摩擦。
       */
      await tx.user.update({
        where: { id: user.id },
        data: { activeTenantId: created.id },
      });

      return created;
    });

    await this.audit.record(user, {
      action: 'tenant.create',
      resourceType: 'tenant',
      resourceId: tenant.id,
      metadata: { name: tenant.name },
    });

    return {
      id: tenant.id,
      name: tenant.name,
      type: 'COMPANY' as TenantTypeName,
      role: 'OWNER' as TenantRoleName,
      memberCount: 1,
      isActive: true,
    };
  }

  /**
   * 成员列表。
   *
   * 普通成员不能看 —— 不是因为他们不该知道同事是谁（通讯录已经给了），
   * 而是这份列表带角色与加入时间，属于管理信息。
   */
  async listMembers(user: AuthenticatedUser, tenantId: string) {
    await this.assertManager(user, tenantId);

    const rows = await this.prisma.membership.findMany({
      where: { tenantId },
      select: {
        role: true,
        createdAt: true,
        user: {
          select: {
            id: true,
            name: true,
            phone: true,
            avatar: true,
            isActive: true,
          },
        },
      },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    });

    return rows.map((row) => ({
      ...row.user,
      role: row.role as TenantRoleName,
      joinedAt: row.createdAt.toISOString(),
    }));
  }

  /**
   * 移除成员。
   *
   * 三条硬规则：
   * 1. 不能移除自己（会把自己锁在空间外）—— 想退出要走"转让/解散"
   * 2. 不能移除 OWNER
   * 3. 只有 OWNER 能移除 ADMIN（ADMIN 之间不能互相踢）
   *
   * **他创建的会议留在企业**（`meeting.tenant_id` 不变）。
   * 这既符合数据归属，也保住了协作历史；他自己再访问会被 §6.2 拦成 404。
   */
  async removeMember(
    operator: AuthenticatedUser,
    tenantId: string,
    targetUserId: number,
  ) {
    const myRole = await this.assertManager(operator, tenantId);

    if (targetUserId === operator.id) {
      throw new BadRequestException(
        '不能移除自己。如需退出，请先把空间转交给他人',
      );
    }

    const target = await this.prisma.membership.findUnique({
      where: { tenantId_userId: { tenantId, userId: targetUserId } },
      select: {
        role: true,
        user: { select: { id: true, name: true, activeTenantId: true } },
      },
    });

    if (!target) {
      throw new NotFoundException('该成员不在此空间');
    }

    if (target.role === 'OWNER') {
      throw new ForbiddenException('不能移除空间所有者');
    }

    if (target.role === 'ADMIN' && myRole !== 'OWNER') {
      throw new ForbiddenException('只有所有者可以移除管理员');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.membership.delete({
        where: { tenantId_userId: { tenantId, userId: targetUserId } },
      });

      /**
       * 他的当前空间若正指向这里，必须回落到个人空间。
       *
       * 不回落的后果：守卫发现 activeTenantId 没有对应 membership，
       * 直接 401 —— 他会表现为"登录了但什么都打不开"。
       */
      if (target.user.activeTenantId === tenantId) {
        const personal = await tx.membership.findFirst({
          where: { userId: targetUserId, tenant: { type: 'PERSONAL' } },
          select: { tenantId: true },
        });

        /** 兜底：没有个人空间（数据异常）时，退到他剩下的任意一个空间 */
        const fallback =
          personal ??
          (await tx.membership.findFirst({
            where: { userId: targetUserId },
            select: { tenantId: true },
          }));

        if (fallback) {
          await tx.user.update({
            where: { id: targetUserId },
            data: { activeTenantId: fallback.tenantId },
          });
        }
      }
    });

    await this.audit.record(operator, {
      action: 'tenant.member.remove',
      resourceType: 'tenant',
      resourceId: tenantId,
      metadata: { userId: targetUserId, name: target.user.name },
    });

    return { removed: true };
  }

  /**
   * 切换当前浏览的空间。
   *
   * 不换 token：守卫每次请求都回库读 `active_tenant_id`（文档 §4.1），
   * 所以这里只要改库，下一个请求自然生效。
   *
   * 顺带把新的权限位一起返回，前端可以立即刷新菜单，
   * 不用再发一次 `/auth/me`。
   */
  async switchActive(user: AuthenticatedUser, tenantId: string) {
    const membership = await this.prisma.membership.findUnique({
      where: { tenantId_userId: { tenantId, userId: user.id } },
      select: { role: true, tenant: { select: { id: true, name: true, type: true } } },
    });

    if (!membership) {
      // 不泄露"这个空间存在但你没权限"
      throw new NotFoundException('空间不存在');
    }

    if (user.activeTenantId !== tenantId) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { activeTenantId: tenantId },
      });
    }

    const tenantRole = membership.role as TenantRoleName;

    return {
      activeTenantId: membership.tenant.id,
      tenantName: membership.tenant.name,
      tenantRole,
      tenantType: membership.tenant.type as TenantTypeName,
      /** 前端按这份权限重新渲染按钮，避免角色变了按钮没变 */
      permissions: permissionsOf({ role: user.role, tenantRole }),
    };
  }

  /**
   * 校验操作者在该空间里是 OWNER 或 ADMIN，返回他的角色。
   *
   * 空间不存在、不在空间里、角色不够，三种情况都抛 404 ——
   * 对调用方来说是同一件事："你没有这个空间"，分开说等于泄露空间是否存在。
   */
  private async assertManager(
    user: AuthenticatedUser,
    tenantId: string,
  ): Promise<TenantRoleName> {
    const membership = await this.prisma.membership.findUnique({
      where: { tenantId_userId: { tenantId, userId: user.id } },
      select: { role: true },
    });

    const role = membership?.role as TenantRoleName | undefined;

    if (!role || !MANAGER_ROLES.includes(role)) {
      throw new NotFoundException('空间不存在');
    }

    return role;
  }

  /* =========================
     邀请链接
     ========================= */

  /**
   * 生成邀请链接。
   *
   * 明文令牌**只在这里返回一次**，库里只有 SHA-256。
   * 管理员事后想看链接只能重新生成 —— 这是有意的：
   * 一个永远能查到的邀请链接，等于一个永久后门。
   */
  async createInvite(
    operator: AuthenticatedUser,
    tenantId: string,
    input: {
      /** 指定手机号时只有该号能接受；为空表示拿到链接的人都能用 */
      phone?: string;
      role?: TenantRoleName;
      maxUses?: number;
    },
  ) {
    const myRole = await this.assertManager(operator, tenantId);

    const role = input.role ?? 'MEMBER';

    /** 不能通过邀请造出第二个所有者 —— 转让是独立操作，不能走链接 */
    if (role === 'OWNER') {
      throw new BadRequestException('不能邀请所有者');
    }

    /** 管理员只能邀请普通成员，只有所有者能邀请管理员 */
    if (role === 'ADMIN' && myRole !== 'OWNER') {
      throw new ForbiddenException('只有所有者可以邀请管理员');
    }

    const maxUses = Math.min(Math.max(input.maxUses ?? 1, 1), 50);

    const token = createInviteToken();
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86400_000);

    const invite = await this.prisma.tenantInvite.create({
      data: {
        tenantId,
        tokenHash: hashInviteToken(token),
        phone: input.phone?.trim() || null,
        role,
        maxUses,
        expiresAt,
        createdBy: operator.id,
      },
      select: { id: true, phone: true, role: true, maxUses: true },
    });

    await this.audit.record(operator, {
      action: 'tenant.invite.create',
      resourceType: 'tenant',
      resourceId: tenantId,
      metadata: { inviteId: invite.id, role, maxUses },
    });

    return {
      id: invite.id,
      /** 明文，只返回这一次 */
      token,
      role: invite.role as TenantRoleName,
      phone: invite.phone,
      maxUses: invite.maxUses,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /** 已发出的邀请（不含令牌，无法还原成链接） */
  async listInvites(operator: AuthenticatedUser, tenantId: string) {
    await this.assertManager(operator, tenantId);

    const now = new Date();

    const rows = await this.prisma.tenantInvite.findMany({
      where: { tenantId },
      select: {
        id: true,
        phone: true,
        role: true,
        maxUses: true,
        usedCount: true,
        expiresAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return rows.map((row) => ({
      id: row.id,
      phone: row.phone,
      role: row.role as TenantRoleName,
      maxUses: row.maxUses,
      usedCount: row.usedCount,
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      /** 前端直接据此显示「已过期 / 已用完 / 可用」 */
      status:
        row.expiresAt.getTime() <= now.getTime()
          ? 'EXPIRED'
          : row.usedCount >= row.maxUses
            ? 'USED_UP'
            : 'ACTIVE',
    }));
  }

  /** 撤销邀请：直接删掉，链接立刻失效 */
  async revokeInvite(
    operator: AuthenticatedUser,
    tenantId: string,
    inviteId: number,
  ) {
    await this.assertManager(operator, tenantId);

    const deleted = await this.prisma.tenantInvite.deleteMany({
      where: { id: inviteId, tenantId },
    });

    if (!deleted.count) {
      throw new NotFoundException('邀请不存在');
    }

    await this.audit.record(operator, {
      action: 'tenant.invite.revoke',
      resourceType: 'tenant',
      resourceId: tenantId,
      metadata: { inviteId },
    });

    return { revoked: true };
  }

  /**
   * 校验邀请令牌（**公开**）。
   *
   * 未登录也要能打开邀请页看到"你被邀请加入某某公司"，
   * 否则用户得先注册、再点链接，中间那一步很容易流失。
   *
   * 只返回展示所需的最小信息：企业名、角色、脱敏手机号、是否可用。
   * 不返回企业 id（避免被用来探测空间）、不返回邀请人手机号。
   */
  async inspectInvite(token: string) {
    const invite = await this.prisma.tenantInvite.findUnique({
      where: { tokenHash: hashInviteToken(token) },
      select: {
        phone: true,
        role: true,
        maxUses: true,
        usedCount: true,
        expiresAt: true,
        tenant: { select: { name: true, type: true } },
      },
    });

    if (!invite) {
      throw new NotFoundException('邀请链接无效');
    }

    const expired = invite.expiresAt.getTime() <= Date.now();
    const usedUp = invite.usedCount >= invite.maxUses;

    return {
      tenantName: invite.tenant.name,
      tenantType: invite.tenant.type as TenantTypeName,
      role: invite.role as TenantRoleName,
      /** 绑定手机号时只知道后四位，用来提示"这是发给你的" */
      phoneMasked: invite.phone ? maskPhone(invite.phone) : null,
      expired,
      usedUp,
      valid: !expired && !usedUp,
    };
  }

  /**
   * 接受邀请（需登录）。
   *
   * 三个约束：
   * 1. 一人一企业 —— 已属于别的企业时拒绝，并告诉他现在在哪家
   * 2. 指定手机号的邀请只能被该号使用
   * 3. 已在目标企业里时幂等成功，**不消耗次数**
   *
   * 次数用原生 SQL 原子扣减（`used_count < max_uses` 作为条件），
   * 否则两个请求同时点一个单次链接都会通过前置检查，双双加入。
   */
  async acceptInvite(user: AuthenticatedUser, token: string) {
    const invite = await this.prisma.tenantInvite.findUnique({
      where: { tokenHash: hashInviteToken(token) },
      select: {
        id: true,
        tenantId: true,
        phone: true,
        role: true,
        maxUses: true,
        usedCount: true,
        expiresAt: true,
        tenant: { select: { name: true } },
      },
    });

    if (!invite) {
      throw new NotFoundException('邀请链接无效');
    }

    /**
     * 幂等检查放在**最前面**，在过期、用尽、手机号校验之前。
     *
     * 理由：他已经是成员了，这条链接是什么状态都不重要。
     * 反过来（先校验链接）会让"加入成功后刷新页面"或"再点一次链接"
     * 显示「邀请链接已被使用」—— 用户会以为自己没进去。
     */
    const existing = await this.prisma.membership.findUnique({
      where: {
        tenantId_userId: { tenantId: invite.tenantId, userId: user.id },
      },
      select: { role: true },
    });

    if (existing) {
      return {
        tenantId: invite.tenantId,
        tenantName: invite.tenant.name,
        role: existing.role as TenantRoleName,
        alreadyMember: true,
      };
    }

    if (invite.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('邀请链接已过期，请联系管理员重新生成');
    }

    if (invite.usedCount >= invite.maxUses) {
      throw new BadRequestException('邀请链接已被使用');
    }

    if (invite.phone && invite.phone !== user.phone) {
      throw new ForbiddenException('这个邀请是发给其他手机号的');
    }

    const otherCompany = await this.prisma.membership.findFirst({
      where: { userId: user.id, tenant: { type: 'COMPANY' } },
      select: { tenant: { select: { name: true } } },
    });

    if (otherCompany) {
      throw new BadRequestException(
        `你已经属于企业「${otherCompany.tenant.name}」，一个账号只能加入一个企业`,
      );
    }

    const role = invite.role as TenantRoleName;

    await this.prisma.$transaction(async (tx) => {
      /**
       * 原子扣减：把"还没用满、还没过期"写进 WHERE。
       * 先 SELECT 判断再 UPDATE 的写法在并发下会放过两次。
       */
      const claimed = await tx.$queryRaw<Array<{ used_count: number }>>`
        UPDATE "tenant_invites"
           SET "used_count" = "used_count" + 1
         WHERE "id" = ${invite.id}
           AND "used_count" < "max_uses"
           AND "expires_at" > now()
        RETURNING "used_count"
      `;

      if (!claimed.length) {
        throw new BadRequestException('邀请链接已被使用');
      }

      await tx.membership.create({
        data: { tenantId: invite.tenantId, userId: user.id, role },
      });

      /** 加入后直接切过去：他接下来一定是要进去看看，多一步切换是多余的 */
      await tx.user.update({
        where: { id: user.id },
        data: { activeTenantId: invite.tenantId },
      });
    });

    await this.audit.record(user, {
      action: 'tenant.member.join',
      resourceType: 'tenant',
      resourceId: invite.tenantId,
      metadata: { via: 'invite', inviteId: invite.id, role },
    });

    return {
      tenantId: invite.tenantId,
      tenantName: invite.tenant.name,
      role,
      alreadyMember: false,
    };
  }
}
