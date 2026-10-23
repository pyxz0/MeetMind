import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../common/prisma.service';
import { AuthService } from '../auth/auth.service';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth.decorators';
import type { AppRole } from '../auth/permissions';
import {
  createResetToken,
  hashResetToken,
  RESET_TOKEN_TTL_MINUTES,
} from '../auth/password-reset-token';

const BCRYPT_ROUNDS = 12;

/** 角色等级，用于判断「能否管理对方」 */
const ROLE_RANK: Record<AppRole, number> = {
  USER: 1,
  ADMIN: 2,
  SUPER_ADMIN: 3,
};

/** 对外暴露的用户视图字段（永不含密码哈希） */
const publicUserSelect = {
  id: true,
  phone: true,
  name: true,
  avatar: true,
  email: true,
  role: true,
  isActive: true,
  createdAt: true,
} as const;

/**
 * 系统唯一的超级管理员角色。
 *
 * 业务规则：全局只能有一个超级管理员。
 * 三层保障，缺一不可：
 *   1. 本服务：禁止创建/提升出第二个，也禁止把唯一超管降级或删除
 *   2. 数据库：users 表上有部分唯一索引，从存储层面兜底
 *   3. 前端：角色下拉里不提供「超级管理员」选项
 *
 * 只做前端限制是不够的，直接调接口就能绕过；
 * 只做应用层也不够，代码写错一处就会出现两个超管。
 */
const SINGLE_SUPER_ADMIN_MESSAGE =
  '系统只允许存在一个超级管理员，该角色不可新建、提升或移除';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
    private readonly audit: AuditService,
  ) {}

  /**
   * 用户列表，支持关键字与角色筛选。
   *
   * 管理员只能看到 USER 与 ADMIN（看不到超级管理员），
   * 避免管理员借此探测到更高级别的账号。
   */
  async list(
    operator: AuthenticatedUser,
    query: { keyword?: string; role?: string } = {},
  ) {
    const keyword = query.keyword?.trim();

    const where: Record<string, unknown> = {};

    if (operator.role === 'ADMIN') {
      where.role = { in: ['USER', 'ADMIN'] };
    }

    if (query.role) {
      const role = query.role.toUpperCase() as AppRole;

      if (!ROLE_RANK[role]) {
        throw new BadRequestException('无效的角色');
      }

      // 与上面的可见范围取交集，防止管理员通过 role 参数越权查看
      where.role =
        operator.role === 'ADMIN' && role === 'SUPER_ADMIN'
          ? { in: ['USER', 'ADMIN'] }
          : role;
    }

    if (keyword) {
      // 手机号是精确匹配场景，用 contains 支持按尾号搜索
      where.OR = [
        { phone: { contains: keyword } },
        { name: { contains: keyword, mode: 'insensitive' } },
      ];
    }

    const users = await this.prisma.user.findMany({
      where,
      select: publicUserSelect,
      orderBy: [{ role: 'desc' }, { createdAt: 'asc' }],
    });

    return users.map((user) => ({
      id: user.id,
      phone: user.phone,
      name: user.name,
      role: user.role,
      isActive: user.isActive,
      createdAt: user.createdAt.toISOString(),
    }));
  }

  /**
   * 通讯录：任何登录用户可见的最简账号集合。
   *
   * 只给姓名与手机号，不含角色/启停等管理字段，
   * 因为普通用户也需要在会议里指定负责人与成员。
   *
   * 超级管理员从此处隐藏：超管是系统级账号，
   * 不应出现在其他用户的选人列表里（避免被拉进会议或推断出账号存在）。
   */
  async listContacts() {
    const users = await this.prisma.user.findMany({
      where: { isActive: true, role: { not: 'SUPER_ADMIN' } },
      select: { id: true, name: true, phone: true },
      orderBy: { createdAt: 'asc' },
    });

    return users;
  }

  /**
   * 管理员创建账号，可指定角色（受操作者级别限制）
   */
  async create(
    operator: AuthenticatedUser,
    input: {
      phone: string;
      password: string;
      name: string;
      role?: string;
    },
  ) {
    const role = (input.role ?? 'USER').toUpperCase() as AppRole;

    if (!ROLE_RANK[role]) {
      throw new BadRequestException('无效的角色');
    }

    // 关键越权防护：不能创建比自己级别更高的账号
    if (ROLE_RANK[role] > ROLE_RANK[operator.role]) {
      throw new ForbiddenException('不能创建权限高于自己的账号');
    }

    // 超级管理员只能有一个：连超管本人也不允许再建第二个
    if (role === 'SUPER_ADMIN') {
      throw new BadRequestException(SINGLE_SUPER_ADMIN_MESSAGE);
    }

    // 复用 AuthService 的归一化与格式校验，保证与自助注册完全一致
    const phone = this.authService.normalizePhone(input.phone ?? '');

    const name = input.name?.trim();

    if (!name) {
      throw new BadRequestException('姓名不能为空');
    }

    this.assertPassword(input.password);

    const existing = await this.prisma.user.findUnique({
      where: { phone },
      select: { id: true },
    });

    if (existing) {
      throw new BadRequestException('该手机号已被注册');
    }

    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

    const user = await this.prisma.user.create({
      data: {
        phone,
        passwordHash,
        name: name.slice(0, 80),
        role,
      },
      select: publicUserSelect,
    });

    await this.audit.record(operator, {
      action: 'user.create',
      resourceType: 'user',
      resourceId: user.id,
      metadata: { role },
    });

    return { ...user, createdAt: user.createdAt.toISOString() };
  }

  /** 修改用户资料 / 角色 / 启用状态 */
  async update(
    operator: AuthenticatedUser,
    targetId: number,
    input: {
      phone?: string;
      name?: string;
      role?: string;
      isActive?: boolean;
      password?: string;
    },
  ) {
    const target = await this.prisma.user.findUnique({
      where: { id: targetId },
      select: publicUserSelect,
    });

    if (!target) {
      throw new NotFoundException('用户不存在');
    }

    const targetRole = target.role as AppRole;
    const isSelf = targetId === operator.id;

    /**
     * 谁能改谁：
     * - 自己：可以改姓名和密码，但不能改自己的角色或启停状态
     *   （否则一个管理员可以把自己升成超管，或把自己停用导致自锁）
     * - 别人：必须严格高于对方才能管理
     *
     * 这里必须先区分「自己」再判断级别，否则 ROLE_RANK 的 >= 判断
     * 会连自己改自己的密码都拦掉。
     */
    if (isSelf) {
      if (input.role !== undefined && input.role.toUpperCase() !== targetRole) {
        throw new BadRequestException('不能修改自己的角色');
      }

      if (input.isActive !== undefined && input.isActive !== target.isActive) {
        throw new BadRequestException('不能修改自己的启用状态');
      }

      /**
       * 手机号是登录标识，改错会直接把自己锁在系统外，
       * 因此不允许自助修改，必须由上级账号在用户管理中调整。
       */
      if (input.phone !== undefined) {
        throw new BadRequestException(
          '不能修改自己的手机号，请联系管理员（或超级管理员）调整',
        );
      }
    } else if (targetRole === 'SUPER_ADMIN') {
      /**
       * 唯一超管只能自己管自己（走上面的 isSelf 分支）。
       * 其他人一律不能修改，包括同级别的管理员。
       */
      throw new ForbiddenException('超级管理员账号不可被他人修改');
    } else {
      this.assertCanManage(operator, targetRole);
    }

    const data: Record<string, unknown> = {};

    /**
     * 超级管理员唯一性：
     * - 任何人不允许把某个账号提升为超级管理员
     * - 唯一的超级管理员也不允许被降级或停用，
     *   否则系统会变成「零超管」，再没人能管理管理员账号
     *
     * 代价：超管角色无法通过接口转移，需要换人时只能直接改库。
     * 这是「只能有一个」这条规则的直接后果，属于有意为之的取舍。
     */
    if (input.role !== undefined) {
      const nextRole = input.role.toUpperCase() as AppRole;

      if (nextRole === 'SUPER_ADMIN' && targetRole !== 'SUPER_ADMIN') {
        throw new BadRequestException(SINGLE_SUPER_ADMIN_MESSAGE);
      }

      if (targetRole === 'SUPER_ADMIN' && nextRole !== 'SUPER_ADMIN') {
        throw new BadRequestException(
          '唯一的超级管理员不能被降级，否则系统将失去管理员管理能力',
        );
      }
    }

    if (input.isActive === false && targetRole === 'SUPER_ADMIN') {
      throw new BadRequestException(
        '唯一的超级管理员不能被停用，否则系统将无人可管理账号',
      );
    }

    if (input.phone !== undefined) {
      const phone = this.authService.normalizePhone(input.phone);

      // 改成已被占用的号码会撞唯一索引，提前给出可读的错误
      const occupied = await this.prisma.user.findFirst({
        where: { phone, id: { not: targetId } },
        select: { id: true },
      });

      if (occupied) {
        throw new BadRequestException('该手机号已被其他账号使用');
      }

      data.phone = phone;
    }

    if (input.name !== undefined) {
      const name = input.name.trim();

      if (!name) {
        throw new BadRequestException('姓名不能为空');
      }

      data.name = name.slice(0, 80);
    }

    if (input.role !== undefined) {
      const role = input.role.toUpperCase() as AppRole;

      if (!ROLE_RANK[role]) {
        throw new BadRequestException('无效的角色');
      }

      // 既不能把别人提升到超过自己，也不能操作比自己高的账号
      if (ROLE_RANK[role] > ROLE_RANK[operator.role]) {
        throw new ForbiddenException('不能授予高于自己的角色');
      }

      data.role = role;
    }

    if (input.isActive !== undefined) {
      if (typeof input.isActive !== 'boolean') {
        throw new BadRequestException('isActive 必须是布尔值');
      }

      // 不允许把自己停用，否则会立刻自锁
      if (targetId === operator.id && input.isActive === false) {
        throw new BadRequestException('不能停用自己的账号');
      }

      data.isActive = input.isActive;
    }

    if (input.password !== undefined) {
      this.assertPassword(input.password);
      data.passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    }

    if (Object.keys(data).length === 0) {
      throw new BadRequestException('没有需要更新的字段');
    }

    const updated = await this.prisma.user.update({
      where: { id: targetId },
      data,
      select: publicUserSelect,
    });

    await this.audit.record(operator, {
      action: 'user.update',
      resourceType: 'user',
      resourceId: updated.id,
      metadata: {
        role: input.role ?? null,
        isActive: input.isActive ?? null,
        passwordChanged: input.password !== undefined,
        phoneChanged: input.phone !== undefined,
      },
    });

    return { ...updated, createdAt: updated.createdAt.toISOString() };
  }

  /**
   * 以指定账号身份浏览（超级管理员专用）。
   *
   * 用于排障：例如用户反馈「看不到某场会议」，超管可直接切到对方身份复现。
   *
   * 防护要点：
   * - 已由控制器限制为 SUPER_ADMIN
   * - 不允许代登自己（无意义）
   * - 不允许代登停用账号（否则等于绕过停用限制）
   * - 不允许代登超级管理员角色（避免自我复制出第二超管身份）
   * - 不允许在代登会话中再次代登（避免权限链失控）
   */
  async impersonate(operator: AuthenticatedUser, targetId: number) {
    if (operator.impersonatedBy !== undefined) {
      throw new ForbiddenException(
        '当前已是代登状态，请先返回自己的账号再切换',
      );
    }

    if (targetId === operator.id) {
      throw new BadRequestException('不能切换到自己');
    }

    const target = await this.prisma.user.findUnique({
      where: { id: targetId },
      select: publicUserSelect,
    });

    if (!target) {
      throw new NotFoundException('用户不存在');
    }

    if (!target.isActive) {
      throw new BadRequestException('该账号已被停用，无法切换');
    }

    if (target.role === 'SUPER_ADMIN') {
      throw new ForbiddenException('不能以超级管理员身份切换');
    }

    const token = await this.authService.createImpersonationSession(
      target.id,
      target.role as AppRole,
      target.phone,
      operator.id,
    );

    await this.audit.record(operator, {
      action: 'user.impersonate',
      resourceType: 'user',
      resourceId: target.id,
    });

    return {
      token,
      user: this.authService.toPublicUser(target),
      /** 真实操作者，供前端提示条展示 */
      impersonatedBy: {
        id: operator.id,
        name: operator.name,
      },
    };
  }

  /** 删除用户；其拥有的会议会因外键级联一并删除 */
  async remove(operator: AuthenticatedUser, targetId: number) {
    if (targetId === operator.id) {
      throw new BadRequestException('不能删除自己的账号');
    }

    const target = await this.prisma.user.findUnique({
      where: { id: targetId },
      select: publicUserSelect,
    });

    if (!target) {
      throw new NotFoundException('用户不存在');
    }

    // 唯一的超级管理员不能被删除
    if (target.role === 'SUPER_ADMIN') {
      throw new BadRequestException(
        '唯一的超级管理员不能被删除，否则系统将无人可管理账号',
      );
    }

    this.assertCanManage(operator, target.role as AppRole);

    /**
     * 删除账号前先把它拥有的会议转移给操作者。
     *
     * owner 外键已改为 ON DELETE RESTRICT：如果不转移，删除会直接失败。
     * 转移而不是级联删除，是为了避免"删个测试账号，把会议资料一起删了"。
     */
    const reassigned = await this.prisma.meeting.updateMany({
      where: { ownerId: targetId },
      data: { ownerId: operator.id },
    });

    /**
     * 他人在其负责的会议里：先把会议创建者补为负责人，再删掉该用户的负责人记录。
     * 这样既保证「至少一位负责人」，也不会因为删账号牵连删掉别人的会议。
     */
    await this.prisma.$transaction([
      this.prisma.$executeRaw`
        INSERT INTO "meeting_leaders" ("meeting_id", "user_id")
        SELECT m."id", m."owner_id"
        FROM "meetings" m
        WHERE m."id" IN (
          SELECT "meeting_id" FROM "meeting_leaders" WHERE "user_id" = ${targetId}
        )
        ON CONFLICT ("meeting_id", "user_id") DO NOTHING
      `,
      this.prisma.$executeRaw`
        DELETE FROM "meeting_leaders" WHERE "user_id" = ${targetId}
      `,
    ]);

    await this.prisma.user.delete({ where: { id: targetId } });

    await this.audit.record(operator, {
      action: 'user.delete',
      resourceType: 'user',
      resourceId: targetId,
      metadata: { reassignedMeetings: reassigned.count },
    });

    return {
      message: '用户已删除',
      id: targetId,
      // 让调用方知道有多少会议被转移，而不是被删掉
      reassignedMeetings: reassigned.count,
    };
  }

  /** 能否管理某个目标角色：必须严格高于对方 */
  /**
   * 生成一次性密码重置链接。
   *
   * 为什么不直接由管理员设新密码：那样管理员会知道用户的明文密码，
   * 事后也无法证明是本人操作的。发链接后，管理员只负责核实身份，
   * 新密码只有用户自己知道。
   *
   * 明文令牌只在这里返回一次（库里存 SHA-256），过期或用过即失效。
   */
  async issuePasswordReset(operator: AuthenticatedUser, targetId: number) {
    const target = await this.prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, name: true, phone: true, role: true },
    });

    if (!target) {
      throw new NotFoundException('用户不存在');
    }

    /**
     * 自己改密码走个人中心（需要原密码），不经过重置链接。
     * 这条要先于层级校验，否则同级判断会把它盖成「不能管理同级账号」。
     */
    if (target.id === operator.id) {
      throw new BadRequestException('请在个人中心修改自己的密码');
    }

    // 与改资料、停用同一套规则：不能管理同级或更高级别的账号
    this.assertCanManage(operator, target.role as AppRole);

    const token = createResetToken();
    const expiresAt = new Date(
      Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000,
    );

    await this.prisma.user.update({
      where: { id: target.id },
      data: {
        passwordResetTokenHash: hashResetToken(token),
        passwordResetExpiresAt: expiresAt,
      },
    });

    await this.audit.record(operator, {
      action: 'user.password_reset_issue',
      resourceType: 'user',
      resourceId: target.id,
      metadata: { expiresAt: expiresAt.toISOString() },
    });

    return {
      token,
      expiresAt: expiresAt.toISOString(),
      ttlMinutes: RESET_TOKEN_TTL_MINUTES,
      name: target.name,
      phone: target.phone,
    };
  }

  private assertCanManage(operator: AuthenticatedUser, targetRole: AppRole) {
    if (ROLE_RANK[targetRole] >= ROLE_RANK[operator.role]) {
      throw new ForbiddenException(
        '不能管理同级或更高级别的账号，请联系超级管理员',
      );
    }
  }

  private assertPassword(password: string) {
    if (typeof password !== 'string' || password.length < 8) {
      throw new BadRequestException('密码至少 8 位');
    }

    if (password.length > 72) {
      throw new BadRequestException('密码不能超过 72 位');
    }

    if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
      throw new BadRequestException('密码需同时包含字母和数字');
    }
  }
}
