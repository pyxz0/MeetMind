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

/**
 * 中国大陆手机号：1 开头、第二位 3-9、共 11 位。
 *
 * 只做格式校验，不做真实号段/归属地校验 —— 那需要运营商数据，
 * 对当前场景没有意义（真正有效性靠登录时的密码校验）。
 */
const PHONE_PATTERN = /^1[3-9]\d{9}$/;

/** 对外返回的用户视图，绝不包含 passwordHash */
export interface PublicUser {
  id: number;
  phone: string;
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

  /** 登录：校验手机号与密码，签发 JWT */
  async login(phone: string, password: string) {
    const normalizedPhone = this.normalizePhone(phone);

    const user = await this.prisma.user.findUnique({
      where: { phone: normalizedPhone },
    });

    /**
     * 手机号不存在与密码错误返回同一句话，
     * 避免通过错误信息枚举出系统里注册了哪些手机号。
     */
    if (!user) {
      throw new UnauthorizedException('手机号或密码不正确');
    }

    const matched = await bcrypt.compare(password, user.passwordHash);

    if (!matched) {
      throw new UnauthorizedException('手机号或密码不正确');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('账号已被停用，请联系管理员');
    }

    return {
      token: await this.signToken(user.id, user.role as AppRole, user.phone),
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
    phone: string;
    password: string;
    name: string;
  }) {
    const phone = this.normalizePhone(input.phone);
    this.assertPasswordStrength(input.password);

    const name = input.name?.trim();

    if (!name) {
      throw new BadRequestException('姓名不能为空');
    }

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
        role: 'USER',
      },
    });

    return {
      token: await this.signToken(user.id, user.role as AppRole, user.phone),
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
    phone: string;
    name: string;
    role: string;
    isActive: boolean;
    createdAt: Date;
  }): PublicUser {
    const role = user.role as AppRole;

    return {
      id: user.id,
      phone: user.phone,
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

  /**
   * 手机号归一化。
   *
   * 用户很可能会输入带空格、短横线或 +86 前缀的号码
   * （例如「+86 138-0013-8000」），统一去掉这些干扰字符再校验，
   * 否则同一个号码会被当成多个不同账号注册。
   */
  normalizePhone(phone: string) {
    const digits = (phone ?? '')
      .trim()
      .replace(/[\s\-()]/g, '')
      .replace(/^\+?86/, '');

    if (!PHONE_PATTERN.test(digits)) {
      throw new BadRequestException('手机号格式不正确（需为 11 位中国大陆手机号）');
    }

    return digits;
  }

  private signToken(userId: number, role: AppRole, phone: string) {
    return this.jwtService.signAsync({
      sub: userId,
      role,
      phone,
    });
  }
}
