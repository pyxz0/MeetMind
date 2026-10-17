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

    this.assertCanManage(operator, target.role as AppRole);

    const data: Record<string, unknown> = {};

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
