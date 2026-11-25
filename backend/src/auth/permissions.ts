/**
 * 权限目录与角色定义。
 *
 * 多租户后权限拆成两层（见 docs/multi-tenant-plan-v2.md §5）：
 *
 *   平台层  users.role            → 开租户、运维；**默认读不到任何企业数据**
 *   租户层  membership.role       → 管本企业成员、看本企业全部会议
 *   资源层  owner/leader/share    → 单场会议能不能读写（在业务层判定）
 *
 * 设计要点：
 * 1. 权限用「资源:动作」的字符串枚举，角色映射到权限集合。
 *    新增功能只需登记权限，改分级只改映射表。
 * 2. 会议这类「有归属」的资源，数据级权限在业务层判定，这里只放全局能力位。
 * 3. **平台超管刻意不含任何 MEETING_\* 权限**。企业客户一定会问
 *    「你们员工能看到我们的会议纪要吗」，答案必须是"不能"。
 *    需要排查时走「以该成员身份进入」（impersonate），有审计、有提示条。
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
  /** 查看**本租户内**全部会议（多租户前是"全平台"，语义已收窄） */
  MEETING_READ_ALL: 'meeting:read:all',
  /** 修改本租户内任意会议 */
  MEETING_UPDATE_ALL: 'meeting:update:all',
  /** 删除本租户内任意会议 */
  MEETING_DELETE_ALL: 'meeting:delete:all',
  /** 把自己的会议共享给别人 */
  MEETING_SHARE_OWN: 'meeting:share:own',
  /** 移除本租户内任意会议的共享授权 */
  MEETING_SHARE_ALL: 'meeting:share:all',
  /** 查看**本租户**用户列表 */
  USER_READ: 'user:read',
  /** 创建/启用/停用本租户普通成员 */
  USER_MANAGE: 'user:manage',
  /** 管理本租户的管理员（仅 OWNER） */
  USER_MANAGE_ADMIN: 'user:manage:admin',
  /** 查看审计日志（本租户） */
  AUDIT_READ: 'audit:read',
  /** 查看后台任务运行状态（运维视角，不含业务数据） */
  SYSTEM_READ: 'system:read',
  /** 查看租户列表（平台视角） */
  TENANT_READ: 'tenant:read',
  /** 创建 / 停用租户（平台视角） */
  TENANT_MANAGE: 'tenant:manage',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** 平台角色枚举，与 Prisma 的 Role 保持一致 */
export type AppRole = 'SUPER_ADMIN' | 'ADMIN' | 'USER';

/** 租户内角色，与 Prisma 的 TenantRole 保持一致 */
export type TenantRoleName = 'OWNER' | 'ADMIN' | 'MEMBER';

/** 空间类型，与 Prisma 的 TenantType 保持一致 */
export type TenantTypeName = 'PERSONAL' | 'COMPANY';

/**
 * 判定权限所需的身份：平台角色 + **当前空间**里的角色。
 *
 * 只带 tenantRole 而不是整个 user，是为了让 permissions.ts 不依赖 auth.decorators，
 * 避免循环 import。
 */
export interface PermissionIdentity {
  role: AppRole;
  tenantRole: TenantRoleName | null;
}

/** 租户内普通成员的能力：只管自己的会议 */
const USER_PERMISSIONS: Permission[] = [
  PERMISSIONS.MEETING_READ_OWN,
  PERMISSIONS.MEETING_CREATE,
  PERMISSIONS.MEETING_UPDATE_OWN,
  PERMISSIONS.MEETING_DELETE_OWN,
  PERMISSIONS.MEETING_SHARE_OWN,
];

/**
 * 租户管理员：在普通成员之上，可查看与编辑**本租户**全部会议、管理普通成员。
 * 注意「编辑全部」但「不能管理管理员」——这是与 OWNER 的关键区别。
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
  PERMISSIONS.SYSTEM_READ,
];

/** 租户内角色 → 权限集合 */
const TENANT_ROLE_PERMISSIONS: Record<TenantRoleName, Permission[]> = {
  MEMBER: USER_PERMISSIONS,
  ADMIN: ADMIN_PERMISSIONS,
  OWNER: [...ADMIN_PERMISSIONS, PERMISSIONS.USER_MANAGE_ADMIN],
};

/**
 * 平台层权限：只管平台能力，**刻意不含任何 MEETING_\* / USER_READ / AUDIT_READ**。
 *
 * 平台超管不在某个租户里时，连一场会议都读不到 —— 这是产品承诺，不是疏忽。
 * 他若同时是某企业的成员，那部分能力来自 membership，不是来自 SUPER_ADMIN。
 */
const PLATFORM_PERMISSIONS: Record<AppRole, Permission[]> = {
  SUPER_ADMIN: [
    PERMISSIONS.TENANT_READ,
    PERMISSIONS.TENANT_MANAGE,
    PERMISSIONS.SYSTEM_READ,
  ],
  /** 已废弃，见文档 §5.1；存量数据由迁移降级为 USER */
  ADMIN: [],
  USER: [],
};

/** 判断某个身份是否具备指定权限（平台能力 ∪ 当前租户能力） */
export const hasPermission = (
  identity: PermissionIdentity,
  permission: Permission,
): boolean => {
  if ((PLATFORM_PERMISSIONS[identity.role] ?? []).includes(permission)) {
    return true;
  }

  return identity.tenantRole
    ? (TENANT_ROLE_PERMISSIONS[identity.tenantRole] ?? []).includes(permission)
    : false;
};

/** 判断是否具备任意一个指定权限（满足其一即可） */
export const hasAnyPermission = (
  identity: PermissionIdentity,
  permissions: Permission[],
): boolean =>
  permissions.length === 0
    ? true
    : permissions.some((permission) => hasPermission(identity, permission));

/**
 * 该身份能通过的全部权限。
 *
 * 登录响应里回给前端做按钮显隐 —— 前端不能自己按 role 猜，
 * 否则租户角色一变按钮就错了。切换空间后要重新拉一次。
 */
export const permissionsOf = (identity: PermissionIdentity): Permission[] => {
  const platform = PLATFORM_PERMISSIONS[identity.role] ?? [];
  const tenant = identity.tenantRole
    ? (TENANT_ROLE_PERMISSIONS[identity.tenantRole] ?? [])
    : [];

  return [...new Set([...platform, ...tenant])];
};

/**
 * @deprecated 只查**平台**角色，不再包含租户能力。
 * 业务代码请用 hasPermission(identity, ...)；这个函数只用于
 * "这个人是不是平台超管"这类纯平台判断。
 */
export const roleHasPermission = (
  role: AppRole,
  permission: Permission,
): boolean => (PLATFORM_PERMISSIONS[role] ?? []).includes(permission);

/** @deprecated 同 roleHasPermission，仅限纯平台判断 */
export const roleHasAnyPermission = (
  role: AppRole,
  permissions: Permission[],
): boolean =>
  permissions.length === 0
    ? true
    : permissions.some((permission) => roleHasPermission(role, permission));

/** 平台角色的中文名 */
export const ROLE_LABELS: Record<AppRole, string> = {
  SUPER_ADMIN: '超级管理员',
  ADMIN: '管理员',
  USER: '用户',
};

/** 租户内角色的中文名，供成员管理页展示 */
export const TENANT_ROLE_LABELS: Record<TenantRoleName, string> = {
  OWNER: '所有者',
  ADMIN: '管理员',
  MEMBER: '成员',
};
