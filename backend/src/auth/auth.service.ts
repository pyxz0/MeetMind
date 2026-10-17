import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../common/prisma.service';
import type { AppRole } from './permissions';
import { ROLE_PERMISSIONS, ROLE_LABELS } from './permissions';

/** bcrypt 代价因子。12 约 250ms/次，兼顾安全与登录体验。 */
const BCRYPT_ROUNDS = 12;

/** 对外返回的用户视图，绝不包含 passwordHash */
export interface PublicUser {
  id: number;
  email: string;
  name: string;
  role: AppRole;
  roleLabel: string;
  isActive: boolean;
  permissions: string[];
  createdAt: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  /** 登录：校验邮箱密码，签发 JWT */
  async login(email: string, password: string) {
    const normalizedEmail = this.normalizeEmail(email);

    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    /**
     * 邮箱不存在与密码错误返回同一句话，
     * 避免通过错误信息枚举出系统里存在哪些邮箱。
     */
    if (!user) {
      throw new UnauthorizedException('邮箱或密码不正确');
    }

    const matched = await bcrypt.compare(password, user.passwordHash);

    if (!matched) {
      throw new UnauthorizedException('邮箱或密码不正确');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('账号已被停用，请联系管理员');
    }

    return {
      token: await this.signToken(user.id, user.role as AppRole, user.email),
      user: this.toPublicUser(user),
    };
  }

  /**
   * 自助注册。
   *
   * 只能注册为普通用户（USER）—— 管理员必须由更高权限者创建，
   * 否则任何人注册后就能看到全站数据。
   */
  async register(input: {
    email: string;
    password: string;
    name: string;
  }) {
    const email = this.normalizeEmail(input.email);
    this.assertPasswordStrength(input.password);

    const name = input.name?.trim();

    if (!name) {
      throw new BadRequestException('姓名不能为空');
    }

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
        role: 'USER',
      },
    });

    return {
      token: await this.signToken(user.id, user.role as AppRole, user.email),
      user: this.toPublicUser(user),
    };
  }

  /** 读取当前登录用户（守卫已校验，这里只做视图转换） */
  async getProfile(userId: number): Promise<PublicUser> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('账号不可用');
    }

    return this.toPublicUser(user);
  }

  /** 供其他模块复用：把数据库用户转为不含敏感字段的视图 */
  toPublicUser(user: {
    id: number;
    email: string;
    name: string;
    role: string;
    isActive: boolean;
    createdAt: Date;
  }): PublicUser {
    const role = user.role as AppRole;

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role,
      roleLabel: ROLE_LABELS[role] ?? role,
      isActive: user.isActive,
      permissions: ROLE_PERMISSIONS[role] ?? [],
      createdAt: user.createdAt.toISOString(),
    };
  }

  /** 校验密码强度，返回明确原因而不是笼统失败 */
  assertPasswordStrength(password: string) {
    if (typeof password !== 'string' || password.length < 8) {
      throw new BadRequestException('密码至少 8 位');
    }

    if (password.length > 72) {
      // bcrypt 只取前 72 字节，超长密码会被静默截断
      throw new BadRequestException('密码不能超过 72 位');
    }

    if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
      throw new BadRequestException('密码需同时包含字母和数字');
    }
  }

  /** 邮箱统一小写去空格，避免 A@x.com 与 a@x.com 注册出两个账号 */
  normalizeEmail(email: string) {
    const normalized = (email ?? '').trim().toLowerCase();

    // 只做基础格式校验，不追求完整 RFC 5322
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      throw new BadRequestException('邮箱格式不正确');
    }

    return normalized;
  }

  private signToken(userId: number, role: AppRole, email: string) {
    return this.jwtService.signAsync({
      sub: userId,
      role,
      email,
    });
  }
}
