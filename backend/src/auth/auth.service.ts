import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  createResetToken,
  hashResetToken,
  RESET_TOKEN_TTL_MINUTES,
} from './password-reset-token';
import { MailService } from '../common/mail.service';
import type { AuthenticatedUser } from './auth.decorators';
import type {
  AppRole,
  TenantRoleName,
  TenantTypeName,
} from './permissions';
import { permissionsOf, ROLE_LABELS } from './permissions';
import { hashPassword, needsRehash, verifyPassword } from './password-hash';

/**
 * 中国大陆手机号：1 开头、第二位 3-9、共 11 位。
 *
 * 只做格式校验，不做真实号段/归属地校验 —— 那需要运营商数据，
 * 对当前场景没有意义（真正有效性靠登录时的密码校验）。
 */
const PHONE_PATTERN = /^1[3-9]\d{9}$/;

/**
 * 邮箱：只做「结构 + 长度」校验。
 *
 * 不做 DNS/MX 探测 —— 自助找回是低敏感场景，真正的有效性靠用户能否收到信；
 * 过严的正则会误杀 icloud、企业邮等合法地址。
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** 自助找回的统一回复：不区分「邮箱存在」与「不存在」 */
const SELF_SERVICE_SENT_MESSAGE =
  '如果该邮箱已绑定账号，重置链接已发送，请查收（含垃圾邮件箱）';

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
  /** 绑定邮箱；为空表示未绑定，找回密码只能走管理员 */
  email: string | null;
  /** 是否接收邮件提醒；站内收件箱不受该开关影响 */
  notifyEmail: boolean;
  /**
   * 当前空间。只有登录 / me / 切换空间这类"需要让前端知道我在哪"的接口会带上，
   * 用户列表之类的场景不传。
   */
  activeTenantId?: string;
  /** 当前空间里的角色；前端据此显示"成员管理"等入口 */
  tenantRole?: TenantRoleName;
  /** 空间类型：COMPANY 才显示成员/邀请相关入口 */
  tenantType?: TenantTypeName;
  permissions: string[];
  createdAt: string;
}

@Injectable()
export class AuthService {
  /**
   * 自助找回的请求时间表（邮箱 -> 时间戳）。
   *
   * 只做进程内限频：单实例部署足够挡住误点与脚本刷接口；
   * 多副本或要做严格风控时要换成 Redis 计数。
   */
  private readonly resetRequests = new Map<string, number[]>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
  ) {}

  /** 登录：校验手机号与密码，签发 JWT */
  async login(phone: string, password: string) {
    const normalizedPhone = this.normalizePhone(phone);

    const user = await this.prisma.user.findUnique({
      where: { phone: normalizedPhone },
      include: {
        memberships: {
          select: {
            tenantId: true,
            role: true,
            tenant: { select: { type: true } },
          },
        },
      },
    });

    /**
     * 手机号不存在与密码错误返回同一句话，
     * 避免通过错误信息枚举出系统里注册了哪些手机号。
     */
    if (!user) {
      throw new UnauthorizedException('手机号或密码不正确');
    }

    const matched = await verifyPassword(password, user.passwordHash);

    if (!matched) {
      throw new UnauthorizedException('手机号或密码不正确');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('账号已被停用，请联系管理员');
    }

    /**
     * 老用户的 bcrypt 哈希在登录成功这一刻透明升级成 scrypt。
     *
     * 不阻塞响应：升级失败也没关系，下次登录会再试一次，
     * 用户完全无感（这也是唯一能大规模迁移哈希、又不用强制重置密码的办法）。
     */
    if (needsRehash(user.passwordHash)) {
      void hashPassword(password)
        .then((passwordHash) =>
          this.prisma.user.update({
            where: { id: user.id },
            data: { passwordHash },
          }),
        )
        .catch(() => undefined);
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
      user: this.toPublicUser(user, this.resolveSpace(user)),
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

    const passwordHash = await hashPassword(input.password);

    /**
     * 先查再插有竞态：两个请求同时通过上面的 existing 检查时，
     * 后一个会在电话唯一索引上撞车。抓住 P2002 转成同样的业务提示，
     * 而不是把原始数据库错误抛成 500。
     */
    let user;

    try {
      /**
       * 多租户后注册要建三样东西，**顺序不能变**（文档 §6.12）：
       *
       *   1. 先建空间（此刻还没有 userId，只能靠入参姓名命名）
       *   2. 再建用户（active_tenant_id 是 NOT NULL，此时有值可填）
       *   3. 最后建归属关系
       *
       * 反过来会在第 2 步卡住。tenants 表刻意没有 owner_user_id 外键 ——
       * 那会把这里的循环依赖搬到表结构里，只能用可空外键或延迟约束来解。
       */
      user = await this.prisma.$transaction(async (tx) => {
        const tenant = await tx.tenant.create({
          data: {
            name: `${name.slice(0, 80)} 的空间`,
            type: 'PERSONAL',
          },
        });

        const created = await tx.user.create({
          data: {
            phone,
            passwordHash,
            name: name.slice(0, 80),
            role: 'USER',
            activeTenantId: tenant.id,
          },
        });

        await tx.membership.create({
          data: { tenantId: tenant.id, userId: created.id, role: 'OWNER' },
        });

        /** 带上 memberships，让下面的 toPublicUser 能算出权限，省一次查询 */
        return {
          ...created,
          memberships: [
            {
              tenantId: tenant.id,
              role: 'OWNER',
              tenant: { type: 'PERSONAL' },
            },
          ],
        };
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') {
        throw new BadRequestException('该手机号已被注册');
      }

      throw error;
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
      user: this.toPublicUser(user, this.resolveSpace(user)),
    };
  }

  /** 读取当前登录用户（守卫已校验，这里只做视图转换） */
  async getProfile(userId: number): Promise<PublicUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        memberships: {
          select: {
            tenantId: true,
            role: true,
            tenant: { select: { type: true } },
          },
        },
      },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('账号不可用');
    }

    return this.toPublicUser(user, this.resolveSpace(user));
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
      email?: string;
      currentPassword?: string;
      newPassword?: string;
      notifyEmail?: boolean;
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
      email?: string | null;
      notifyEmail?: boolean;
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

    /**
     * 绑定邮箱：自助找回密码的接收地址。
     *
     * 不要求输入密码 —— 这一步本身就在已登录会话里，
     * 与改姓名同级；真正的接管风险由「重置密码要邮箱」承担。
     */
    if (input.email !== undefined) {
      const email = input.email.trim().toLowerCase();

      if (!email) {
        data.email = null;
      } else {
        if (email.length > 160 || !EMAIL_PATTERN.test(email)) {
          throw new BadRequestException('邮箱格式不正确');
        }

        const occupied = await this.prisma.user.findFirst({
          where: { email, id: { not: userId } },
          select: { id: true },
        });

        if (occupied) {
          throw new BadRequestException('该邮箱已被其他账号绑定');
        }

        data.email = email;
      }
    }

    /**
     * 邮件提醒开关。
     *
     * 没绑邮箱时允许先打开 —— 用户可能是先设偏好、再去绑邮箱；
     * 真正的拦截在投递侧（没邮箱自然不发）。
     */
    if (input.notifyEmail !== undefined) {
      data.notifyEmail = Boolean(input.notifyEmail);
    }

    if (input.newPassword !== undefined) {
      this.assertPasswordStrength(input.newPassword);

      if (!input.currentPassword) {
        throw new BadRequestException('修改密码需要提供原密码');
      }

      const matched = await verifyPassword(
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

      data.passwordHash = await hashPassword(input.newPassword);
      /** 改密即作废此前所有会话（守卫比对 tv） */
      data.tokenVersion = { increment: 1 };
    }

    if (Object.keys(data).length === 0) {
      throw new BadRequestException('没有需要更新的内容');
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data,
      include: {
        memberships: {
          select: {
            tenantId: true,
            role: true,
            tenant: { select: { type: true } },
          },
        },
      },
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
        emailChanged: data.email !== undefined,
        notifyEmailChanged: data.notifyEmail !== undefined,
        passwordChanged: data.passwordHash !== undefined,
      },
    });

    const view = this.toPublicUser(updated, this.resolveSpace(updated));

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

  /**
   * 供其他模块复用：把数据库用户转为不含敏感字段的视图。
   *
   * `space` 是当前空间信息。不传时 permissions 只含平台能力 ——
   * 用户列表这类场景不需要，登录 / me 必须传，否则前端拿不到按钮权限。
   */
  toPublicUser(
    user: {
      id: number;
      phone: string;
      name: string;
      avatar: string | null;
      email: string | null;
      role: string;
      isActive: boolean;
      createdAt: Date;
      /** 旧调用方可能不传，缺省按「开启」处理，与数据库默认值一致 */
      notifyEmail?: boolean;
    },
    space?: {
      activeTenantId: string;
      tenantRole: TenantRoleName;
      tenantType: TenantTypeName;
    },
  ): PublicUser {
    const role = user.role as AppRole;

    return {
      id: user.id,
      phone: user.phone,
      name: user.name,
      role,
      roleLabel: ROLE_LABELS[role] ?? role,
      isActive: user.isActive,
      avatar: user.avatar ?? null,
      email: user.email ?? null,
      notifyEmail: user.notifyEmail ?? true,
      permissions: permissionsOf({ role, tenantRole: space?.tenantRole ?? null }),
      ...(space
        ? {
            activeTenantId: space.activeTenantId,
            tenantRole: space.tenantRole,
            tenantType: space.tenantType,
          }
        : {}),
      createdAt: user.createdAt.toISOString(),
    };
  }

  /**
   * 从「用户 + 所属空间」算出当前空间信息。
   *
   * 找不到对应 membership 只有两种情况：刚被移出企业、数据不一致。
   * 这时宁可让登录失败，也不要静默给一份空权限 —— 后者会表现成
   * 「能登进去但什么都点不了」，排查成本高得多。
   */
  private resolveSpace(user: {
    activeTenantId: string;
    memberships: Array<{
      tenantId: string;
      role: string;
      tenant: { type: string };
    }>;
  }): {
    activeTenantId: string;
    tenantRole: TenantRoleName;
    tenantType: TenantTypeName;
  } {
    const membership = user.memberships.find(
      (m) => m.tenantId === user.activeTenantId,
    );

    if (!membership) {
      throw new UnauthorizedException('账号空间异常，请联系管理员');
    }

    return {
      activeTenantId: user.activeTenantId,
      tenantRole: membership.role as TenantRoleName,
      tenantType: membership.tenant.type as TenantTypeName,
    };
  }

  /** 校验密码强度，返回明确原因而不是笼统失败 */
  assertPasswordStrength(password: string) {
    if (typeof password !== 'string' || password.length < 8) {
      throw new BadRequestException('密码至少 8 位');
    }

    if (password.length > 72) {
      // 上限沿用历史约定：老 bcrypt 哈希只取前 72 字节，
      // 若不拦住，改密后超过 72 位的部分在新旧哈希下的语义会不一致
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
   * 自助找回：给绑定邮箱发一次性链接。
   *
   * 无论邮箱是否绑定账号，对外都返回同一句话 —— 否则这个接口
   * 会变成「查某个邮箱有没有注册」的探测器。
   */
  async requestPasswordReset(email: string) {
    const normalized = email?.trim().toLowerCase() ?? '';

    if (!EMAIL_PATTERN.test(normalized)) {
      throw new BadRequestException('邮箱格式不正确');
    }

    this.assertResetRequestAllowed(normalized);

    const user = await this.prisma.user.findUnique({
      where: { email: normalized },
    });

    if (!user || !user.isActive) {
      // 不写库、不发信，但对外表现与成功一致
      return {
        message: SELF_SERVICE_SENT_MESSAGE,
        delivered: this.mail.configured,
      };
    }

    const token = createResetToken();
    const expiresAt = new Date(
      Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000,
    );

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordResetTokenHash: hashResetToken(token),
        passwordResetExpiresAt: expiresAt,
      },
    });

    const delivered = await this.mail.sendPasswordReset(
      normalized,
      user.name,
      this.buildResetLink(token),
      RESET_TOKEN_TTL_MINUTES,
    );

    await this.audit.record(
      { id: user.id, activeTenantId: user.activeTenantId },
      {
        action: 'user.password_reset_request',
        resourceType: 'user',
        resourceId: user.id,
        metadata: { delivered },
      },
    );

    return { message: SELF_SERVICE_SENT_MESSAGE, delivered };
  }

  /**
   * 拼重置链接。
   *
   * 必须配 APP_PUBLIC_URL：容器里拿不到用户访问的域名，
   * 靠请求头拼会被伪造 Host 头利用。
   */
  private buildResetLink(token: string): string {
    const base = (process.env.APP_PUBLIC_URL ?? 'http://localhost:5173').replace(
      /\/+$/,
      '',
    );

    return `${base}/reset-password?token=${encodeURIComponent(token)}`;
  }

  /**
   * 同一邮箱 15 分钟内最多 3 次。
   *
   * 目的是挡住误点与脚本刷接口，不指望它防住分布式攻击；
   * 进程内 Map 在重启后清零，多副本时需要换 Redis。
   */
  private assertResetRequestAllowed(email: string) {
    const now = Date.now();
    const windowMs = 15 * 60 * 1000;
    const recent = (this.resetRequests.get(email) ?? []).filter(
      (at) => now - at < windowMs,
    );

    if (recent.length >= 3) {
      throw new BadRequestException('请求过于频繁，请 15 分钟后再试');
    }

    recent.push(now);
    this.resetRequests.set(email, recent);

    // 顺手清理过期条目，避免长期运行后 Map 只增不减
    if (this.resetRequests.size > 500) {
      for (const [key, times] of this.resetRequests) {
        if (!times.some((at) => now - at < windowMs)) {
          this.resetRequests.delete(key);
        }
      }
    }
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
        passwordHash: await hashPassword(newPassword),
        passwordResetTokenHash: null,
        passwordResetExpiresAt: null,
        tokenVersion: { increment: 1 },
      },
    });

    await this.audit.record(
      { id: user.id, activeTenantId: user.activeTenantId },
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
