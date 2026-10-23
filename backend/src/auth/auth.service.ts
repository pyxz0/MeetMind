import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { hashResetToken } from './password-reset-token';
import type { AuthenticatedUser } from './auth.decorators';
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
  /** 头像（data URL）；为空时界面用姓名首字 */
  avatar: string | null;
  permissions: string[];
  createdAt: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly audit: AuditService,
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

    await this.audit.record(user, {
      action: 'auth.login',
      resourceType: 'user',
      resourceId: user.id,
    });

    return {
      token: await this.signToken(
        user.id,
        user.role as AppRole,
        user.phone,
        user.tokenVersion,
      ),
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

    await this.audit.record(user, {
      action: 'auth.login',
      resourceType: 'user',
      resourceId: user.id,
    });

    return {
      token: await this.signToken(
        user.id,
        user.role as AppRole,
        user.phone,
        user.tokenVersion,
      ),
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

  /**
   * 修改自己的资料（个人中心用）。
   *
   * 与管理员改用户的区别：
   * - 只允许改姓名与密码，不允许改手机号 / 角色 / 启停状态
   *   （手机号是登录标识，误改会把自己锁在外面；角色与启停属于管理权限）
   * - 改密码必须提供原密码，防止会话被劫持后直接改密码
   *
   * 这样普通用户无需 user:manage 权限也能维护自己的账号。
   */
  async updateOwnProfile(
    actor: Pick<AuthenticatedUser, 'id' | 'impersonatedBy'>,
    input: {
      name?: string;
      avatar?: string;
      currentPassword?: string;
      newPassword?: string;
    },
  ): Promise<PublicUser & { token?: string }> {
    const userId = actor.id;
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('账号不可用');
    }

    const data: {
      name?: string;
      passwordHash?: string;
      avatar?: string | null;
      tokenVersion?: { increment: number };
    } = {};

    if (input.name !== undefined) {
      const name = input.name.trim();

      if (!name) {
        throw new BadRequestException('姓名不能为空');
      }

      data.name = name.slice(0, 80);
    }

    /**
     * 头像：只接受 data URL 形式的小图（前端已压到 256px）。
     * 传空字符串表示移除；不在这里做图像转码，避免引入额外依赖。
     */
    if (input.avatar !== undefined) {
      const avatar = input.avatar.trim();

      if (!avatar) {
        data.avatar = null;
      } else {
        if (!avatar.startsWith('data:image/')) {
          throw new BadRequestException('头像格式不正确，请上传图片文件');
        }

        if (avatar.length > 400_000) {
          throw new BadRequestException('头像太大了，请换一张更小的图片');
        }

        data.avatar = avatar;
      }
    }

    if (input.newPassword !== undefined) {
      this.assertPasswordStrength(input.newPassword);

      if (!input.currentPassword) {
        throw new BadRequestException('修改密码需要提供原密码');
      }

      const matched = await bcrypt.compare(
        input.currentPassword,
        user.passwordHash,
      );

      if (!matched) {
        // 与登录失败同样的模糊表述，避免泄露「原密码是否正确」以外的信息
        throw new BadRequestException('原密码不正确');
      }

      if (input.currentPassword === input.newPassword) {
        throw new BadRequestException('新密码不能与原密码相同');
      }

      data.passwordHash = await bcrypt.hash(
        input.newPassword,
        BCRYPT_ROUNDS,
      );
      /** 改密即作废此前所有会话（守卫比对 tv） */
      data.tokenVersion = { increment: 1 };
    }

    if (Object.keys(data).length === 0) {
      throw new BadRequestException('没有需要更新的内容');
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data,
    });

    /**
     * 自助改资料同样要留痕。
     *
     * 之前这里只更新数据库、不写审计：用户把自己的密码改掉之后，
     * 日志里查不到任何痕迹，只能靠比对 password_hash 去猜，
     * 排查「密码到底是谁改的」时完全没有抓手。
     *
     * 与管理员改他人（users.service 里的 user.update）分开记一条，
     * 便于按动作筛选；只记改了哪些字段，绝不落密码内容。
     */
    await this.audit.record(actor, {
      action: 'user.self_update',
      resourceType: 'user',
      resourceId: updated.id,
      metadata: {
        nameChanged: data.name !== undefined,
        avatarChanged: data.avatar !== undefined,
        passwordChanged: data.passwordHash !== undefined,
      },
    });

    const view = this.toPublicUser(updated);

    /**
     * 改密后旧令牌全部失效，这里给当前会话补发一枚新的，
     * 否则用户刚改完密码，下一个请求就被踢下线。
     */
    if (data.passwordHash !== undefined) {
      return {
        ...view,
        token: await this.signToken(
          updated.id,
          updated.role as AppRole,
          updated.phone,
          updated.tokenVersion,
        ),
      };
    }

    return view;
  }

  /** 供其他模块复用：把数据库用户转为不含敏感字段的视图 */
  toPublicUser(user: {
    id: number;
    phone: string;
    name: string;
    avatar: string | null;
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
      avatar: user.avatar ?? null,
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

  /**
   * 签发「以他人身份浏览」的会话令牌（超级管理员专用）。
   *
   * 与普通登录令牌的区别：
   * - 带 imp 声明（值为操作者的用户 ID），便于审计与识别当前是代登状态
   * - 有效期缩短到 2 小时：代登属于临时排障手段，不应长期有效
   *
   * 权限校验（谁能代登、能否代登目标账号）由调用方 UsersService 负责，
   * 这里只负责签发。
   */
  async createImpersonationSession(
    targetUserId: number,
    targetRole: AppRole,
    targetPhone: string,
    operatorId: number,
  ): Promise<string> {
    /** 代登令牌同样受令牌版本约束：目标账号重置密码后，代登会话一起失效 */
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { tokenVersion: true },
    });

    return this.jwtService.signAsync(
      {
        sub: targetUserId,
        role: targetRole,
        phone: targetPhone,
        // 标记这是代登令牌，并记录真实操作者
        imp: operatorId,
        tv: target?.tokenVersion ?? 0,
      },
      { expiresIn: '2h' },
    );
  }

  /**
   * 校验重置令牌，返回给前端做「你正在给谁设密码」的确认。
   *
   * 放在填密码之前调用：链接过期能立刻告知，不必让用户填完两次再报错。
   */
  async inspectPasswordReset(token: string) {
    const user = await this.findUserByResetToken(token);

    return {
      name: user.name,
      /** 手机号脱敏，足够本人确认，也不至于把号码暴露给拿到链接的第三方 */
      phone: `${user.phone.slice(0, 3)}****${user.phone.slice(-4)}`,
      expiresAt: user.passwordResetExpiresAt?.toISOString() ?? null,
    };
  }

  /**
   * 用一次性令牌设置新密码。
   *
   * 三个后果必须同时发生：令牌作废、旧会话全部失效、留一条审计。
   * 少任何一个都会留下「链接还能再用一次」或「改了密码别人还登着」的口子。
   */
  async confirmPasswordReset(token: string, newPassword: string) {
    const user = await this.findUserByResetToken(token);
    this.assertPasswordStrength(newPassword);

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await bcrypt.hash(newPassword, BCRYPT_ROUNDS),
        passwordResetTokenHash: null,
        passwordResetExpiresAt: null,
        tokenVersion: { increment: 1 },
      },
    });

    await this.audit.record(
      { id: user.id },
      {
        action: 'user.password_reset',
        resourceType: 'user',
        resourceId: user.id,
        metadata: { via: 'reset_link' },
      },
    );

    return { message: '密码已重置，请用新密码登录' };
  }

  /**
   * 按令牌反查用户。
   *
   * 库里只存 SHA-256，比对的是哈希；令牌不存在与已过期返回同一句话，
   * 避免把「这个链接是否存在过」变成可探测的信息。
   */
  private async findUserByResetToken(token: string) {
    const normalized = token?.trim();

    if (!normalized) {
      throw new BadRequestException('重置链接无效或已过期');
    }

    const user = await this.prisma.user.findFirst({
      where: { passwordResetTokenHash: hashResetToken(normalized) },
    });

    if (
      !user?.passwordResetExpiresAt ||
      user.passwordResetExpiresAt.getTime() < Date.now()
    ) {
      throw new BadRequestException('重置链接无效或已过期');
    }

    return user;
  }

  private signToken(
    userId: number,
    role: AppRole,
    phone: string,
    tokenVersion: number,
  ) {
    return this.jwtService.signAsync({
      sub: userId,
      role,
      phone,
      /**
       * 令牌版本：改密 / 重置密码后自增，守卫比对不一致就拒绝。
       * 老令牌没有 tv 声明，按 0 处理 —— 与迁移默认值一致，不会误伤。
       */
      tv: tokenVersion,
    });
  }
}
