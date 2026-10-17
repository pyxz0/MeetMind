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

    let payload: { sub?: number };

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
     * 每次请求都回库读用户，而不是只信 JWT 里的角色。
     * 原因：停用账号或降级角色后，旧 token 必须立刻失效，
     * 否则权限回收要等到 token 过期才生效。
     */
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isActive: true,
      },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('账号不可用，请联系管理员');
    }

    const currentUser: AuthenticatedUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role as AppRole,
      isActive: user.isActive,
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

  /** 从 Authorization: Bearer <token> 中取出令牌 */
  private extractToken(request: {
    headers?: Record<string, unknown>;
  }): string | null {
    const header = request.headers?.authorization;

    if (typeof header !== 'string') {
      return null;
    }

    const [scheme, value] = header.split(' ');

    return scheme?.toLowerCase() === 'bearer' && value ? value : null;
  }
}
