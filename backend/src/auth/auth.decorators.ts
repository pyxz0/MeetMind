import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { AppRole, Permission } from './permissions';

/** 标记接口为公开访问，跳过 JWT 校验（登录、注册、健康检查等） */
export const IS_PUBLIC_KEY = 'auth:isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** 标记接口所需的权限（满足任意一个即可通过） */
export const PERMISSIONS_KEY = 'auth:permissions';
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/** 标记接口所需的最低角色（用于管人类接口，比权限位更直观） */
export const ROLES_KEY = 'auth:roles';
export const RequireRoles = (...roles: AppRole[]) =>
  SetMetadata(ROLES_KEY, roles);

/** 已通过 JWT 校验并加载的用户信息，挂在 request.user 上 */
export interface AuthenticatedUser {
  id: number;
  phone: string;
  name: string;
  role: AppRole;
  isActive: boolean;
  /**
   * 代登操作者 ID：非空表示当前会话是「以他人身份浏览」。
   *
   * 由 JWT 的 imp 声明带入，用于前端显示身份提示条、
   * 以及禁止代登会话再次发起代登（避免权限链）。
   */
  impersonatedBy?: number;
}

/**
 * 从请求中取出当前登录用户。
 *
 * 配合 JwtAuthGuard 使用；守卫已保证该值存在。
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest();
    return request.user as AuthenticatedUser;
  },
);
