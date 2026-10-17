/**
 * 权限目录与三级角色定义。
 *
 * 设计要点：
 * 1. 权限用「资源:动作」的字符串枚举，角色映射到权限集合。
 *    这样新增功能只需登记权限，改分级只改映射表，不在业务代码里散落角色判断。
 * 2. 会议这类「有归属」的资源，数据级权限（owner / share）在业务层判定，
 *    这里只放全局能力位，避免权限表膨胀。
 */

/** 全局能力位 */
export const PERMISSIONS = {
  /** 查看自己的会议 */
  MEETING_READ_OWN: 'meeting:read:own',
  /** 新建会议 */
  MEETING_CREATE: 'meeting:create',
  /** 修改自己拥有的会议 */
  MEETING_UPDATE_OWN: 'meeting:update:own',
  /** 删除自己拥有的会议 */
  MEETING_DELETE_OWN: 'meeting:delete:own',
  /** 查看全部会议（跨用户） */
  MEETING_READ_ALL: 'meeting:read:all',
  /** 修改任意会议 */
  MEETING_UPDATE_ALL: 'meeting:update:all',
  /** 删除任意会议 */
  MEETING_DELETE_ALL: 'meeting:delete:all',
  /** 把自己的会议共享给别人 */
  MEETING_SHARE_OWN: 'meeting:share:own',
  /** 移除任意会议的共享授权 */
  MEETING_SHARE_ALL: 'meeting:share:all',
  /** 查看用户列表 */
  USER_READ: 'user:read',
  /** 创建/启用/停用普通用户 */
  USER_MANAGE: 'user:manage',
  /** 管理管理员账号（提升/降级/删除） */
  USER_MANAGE_ADMIN: 'user:manage:admin',
  /** 查看审计日志 */
  AUDIT_READ: 'audit:read',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** 角色枚举，与 Prisma 的 Role 保持一致 */
export type AppRole = 'SUPER_ADMIN' | 'ADMIN' | 'USER';

/** 普通用户的权限集合 */
const USER_PERMISSIONS: Permission[] = [
  PERMISSIONS.MEETING_READ_OWN,
  PERMISSIONS.MEETING_CREATE,
  PERMISSIONS.MEETING_UPDATE_OWN,
  PERMISSIONS.MEETING_DELETE_OWN,
  PERMISSIONS.MEETING_SHARE_OWN,
];

/**
 * 管理员：在普通用户之上，可查看与编辑全部会议、管理普通用户。
 * 注意「编辑全部」但「不能管理管理员」——这是与超级管理员的关键区别。
 */
const ADMIN_PERMISSIONS: Permission[] = [
  ...USER_PERMISSIONS,
  PERMISSIONS.MEETING_READ_ALL,
  PERMISSIONS.MEETING_UPDATE_ALL,
  PERMISSIONS.MEETING_DELETE_ALL,
  PERMISSIONS.MEETING_SHARE_ALL,
  PERMISSIONS.USER_READ,
  PERMISSIONS.USER_MANAGE,
  PERMISSIONS.AUDIT_READ,
];

/** 超级管理员：全部权限 */
const SUPER_ADMIN_PERMISSIONS: Permission[] = [
  ...ADMIN_PERMISSIONS,
  PERMISSIONS.USER_MANAGE_ADMIN,
];

/** 角色 → 权限映射表 */
export const ROLE_PERMISSIONS: Record<AppRole, Permission[]> = {
  USER: USER_PERMISSIONS,
  ADMIN: ADMIN_PERMISSIONS,
  SUPER_ADMIN: SUPER_ADMIN_PERMISSIONS,
};

/** 判断某角色是否具备指定权限 */
export const roleHasPermission = (
  role: AppRole,
  permission: Permission,
): boolean => (ROLE_PERMISSIONS[role] ?? []).includes(permission);

/** 判断某角色是否具备任意一个指定权限（满足其一即可） */
export const roleHasAnyPermission = (
  role: AppRole,
  permissions: Permission[],
): boolean =>
  permissions.length === 0
    ? true
    : permissions.some((p) => roleHasPermission(role, p));

/** 角色的中文名，供前端与管理接口展示 */
export const ROLE_LABELS: Record<AppRole, string> = {
  SUPER_ADMIN: '超级管理员',
  ADMIN: '管理员',
  USER: '用户',
};
