import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../common/prisma.service';
import {
  IS_PUBLIC_KEY,
  PERMISSIONS_KEY,
  ROLES_KEY,
  type AuthenticatedUser,
} from './auth.decorators';
import {
  roleHasAnyPermission,
  type AppRole,
  type Permission,
} from './permissions';

/**
 * 全局 JWT 守卫。
 *
 * 默认拒绝：任何接口都需要登录，除非显式标了 @Public()。
 * 这样新增接口时不会因为忘记加守卫而意外公开 —— 属于 fail-closed 设计。
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException('未登录或登录状态已失效');
    }

    let payload: { sub?: number; imp?: number; tv?: number };

    try {
      payload = await this.jwtService.verifyAsync(token);
    } catch {
      // 不区分「过期」与「伪造」，避免给攻击者信息
      throw new UnauthorizedException('登录状态已失效，请重新登录');
    }

    const userId = payload?.sub;

    if (typeof userId !== 'number') {
      throw new UnauthorizedException('登录凭证无效');
    }

    /**
     * imp 声明表示这是超管的代登会话，值是真实操作者的用户 ID。
     * 这里原样传递，供业务层判断「当前是否处于代登状态」。
     */
    const impersonatedBy =
      typeof payload?.imp === 'number' ? payload.imp : undefined;

    /**
     * 每次请求都回库读用户，而不是只信 JWT 里的角色。
     * 原因：停用账号或降级角色后，旧 token 必须立刻失效，
     * 否则权限回收要等到 token 过期才生效。
     */
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        phone: true,
        name: true,
        role: true,
        isActive: true,
        tokenVersion: true,
      },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('账号不可用，请联系管理员');
    }

    /**
     * 令牌版本校验：改密 / 重置密码后 users.token_version 自增，
     * 此时旧令牌（tv 与库中不一致）立即失效，不必等 JWT 自然过期。
     *
     * 历史令牌没有 tv 声明，按 0 处理 —— 与字段默认值一致，不会误伤已登录用户。
     */
    const tokenVersion = typeof payload?.tv === 'number' ? payload.tv : 0;

    if (user.tokenVersion !== tokenVersion) {
      throw new UnauthorizedException('登录状态已失效，请重新登录');
    }

    const currentUser: AuthenticatedUser = {
      id: user.id,
      phone: user.phone,
      name: user.name,
      role: user.role as AppRole,
      isActive: user.isActive,
      ...(impersonatedBy !== undefined ? { impersonatedBy } : {}),
    };

    // 角色校验（管人类接口用）
    const requiredRoles = this.reflector.getAllAndOverride<AppRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (requiredRoles?.length && !requiredRoles.includes(currentUser.role)) {
      throw new ForbiddenException('当前角色无权访问该功能');
    }

    // 权限位校验（功能类接口用，满足任意一个即可）
    const requiredPermissions = this.reflector.getAllAndOverride<Permission[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (
      requiredPermissions?.length &&
      !roleHasAnyPermission(currentUser.role, requiredPermissions)
    ) {
      throw new ForbiddenException('当前角色无权执行该操作');
    }

    request.user = currentUser;

    return true;
  }

  /**
   * 取出请求携带的令牌。
   *
   * 优先读 Authorization 头；音频流是唯一的例外 ——
   * `<audio>` 标签无法自定义请求头，只能把 token 放在查询参数里。
   * 因此仅在「GET + 会议音频流路径」这一种情况下接受 ?token=，
   * 避免把 URL 传 token 变成通用能力（会被日志、历史记录泄露）。
   */
  private extractToken(request: {
    headers?: Record<string, unknown>;
    method?: string;
    path?: string;
    query?: Record<string, unknown>;
  }): string | null {
    const header = request.headers?.authorization;

    if (typeof header === 'string') {
      const [scheme, value] = header.split(' ');

      if (scheme?.toLowerCase() === 'bearer' && value) {
        return value;
      }
    }

    /**
     * 路径可能带全局前缀（本项目的接口前缀是 /api），
     * 先去掉前缀再匹配，否则带前缀时永远匹配不上、query token 形同失效。
     */
    const rawPath = typeof request.path === 'string' ? request.path : '';
    const path = rawPath.replace(/^\/api(?=\/)/, '');

    const isAudioStream =
      request.method === 'GET' &&
      /^\/meetings\/\d+\/audio$/.test(path);

    if (isAudioStream) {
      const queryToken = request.query?.token;

      if (typeof queryToken === 'string' && queryToken) {
        return queryToken;
      }
    }

    return null;
  }
}
