import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../common/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.decorators';
import type { AppRole } from '../auth/permissions';

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
  email: true,
  name: true,
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
  constructor(private readonly prisma: PrismaService) {}

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
      where.OR = [
        { email: { contains: keyword, mode: 'insensitive' } },
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
      email: user.email,
      name: user.name,
      role: user.role,
      isActive: user.isActive,
      createdAt: user.createdAt.toISOString(),
    }));
  }

  /** 管理员创建账号，可指定角色（受操作者级别限制） */
  async create(
    operator: AuthenticatedUser,
    input: {
      email: string;
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

    const email = (input.email ?? '').trim().toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException('邮箱格式不正确');
    }

    const name = input.name?.trim();

    if (!name) {
      throw new BadRequestException('姓名不能为空');
    }

    this.assertPassword(input.password);

    const existing = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });

    if (existing) {
      throw new BadRequestException('该邮箱已被注册');
    }

    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

    const user = await this.prisma.user.create({
      data: {
        email,
        passwordHash,
        name: name.slice(0, 80),
        role,
      },
      select: publicUserSelect,
    });

    return { ...user, createdAt: user.createdAt.toISOString() };
  }

  /** 修改用户资料 / 角色 / 启用状态 */
  async update(
    operator: AuthenticatedUser,
    targetId: number,
    input: {
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

    return { ...updated, createdAt: updated.createdAt.toISOString() };
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

    await this.prisma.user.delete({ where: { id: targetId } });

    return { message: '用户已删除', id: targetId };
  }

  /** 能否管理某个目标角色：必须严格高于对方 */
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
