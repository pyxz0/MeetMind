import api from './http'
import type { Permission, TenantRole, TenantType } from '../stores/auth'

/** 我所属的一个空间 */
export interface MyTenant {
  id: string
  name: string
  type: TenantType
  role: TenantRole
  memberCount: number
  /** 是否是当前浏览的空间 */
  isActive: boolean
}

/** 切换空间后的结果：新空间信息 + 重新算过的权限位 */
export interface SwitchTenantResult {
  activeTenantId: string
  tenantName: string
  tenantRole: TenantRole
  tenantType: TenantType
  permissions: Permission[]
}

/** 空间成员 */
export interface TenantMember {
  id: number
  name: string
  phone: string
  avatar: string | null
  isActive: boolean
  role: TenantRole
  joinedAt: string
}

/** 我的空间列表（前端切换器用） */
export const listMyTenants = async (): Promise<MyTenant[]> => {
  const response = await api.get<MyTenant[]>('/tenants/mine')

  return response.data
}

/** 创建企业空间；创建者成为所有者并自动切过去 */
export const createTenant = async (name: string): Promise<MyTenant> => {
  const response = await api.post<MyTenant>('/tenants', { name })

  return response.data
}

/**
 * 切换当前空间。
 *
 * 不换 token —— 后端守卫每次请求都会回库读 active_tenant_id。
 * 但页面上的列表数据是按空间过滤的，所以调用方要在成功后重新拉一遍。
 */
export const switchTenant = async (
  tenantId: string
): Promise<SwitchTenantResult> => {
  const response = await api.patch<SwitchTenantResult>('/tenants/active', {
    tenantId,
  })

  return response.data
}

/** 成员列表（仅 OWNER / ADMIN 可调） */
export const listTenantMembers = async (
  tenantId: string
): Promise<TenantMember[]> => {
  const response = await api.get<TenantMember[]>(
    `/tenants/${tenantId}/members`
  )

  return response.data
}

/** 移除成员 */
export const removeTenantMember = async (
  tenantId: string,
  userId: number
): Promise<{ removed: boolean }> => {
  const response = await api.delete<{ removed: boolean }>(
    `/tenants/${tenantId}/members/${userId}`
  )

  return response.data
}

/* ---------- 邀请链接 ---------- */

/** 刚生成的邀请；token 是明文，只此一次 */
export interface CreatedInvite {
  id: number
  token: string
  role: TenantRole
  phone: string | null
  maxUses: number
  expiresAt: string
}

/** 已发出的邀请（不含令牌） */
export interface InviteRecord {
  id: number
  phone: string | null
  role: TenantRole
  maxUses: number
  usedCount: number
  expiresAt: string
  createdAt: string
  status: 'ACTIVE' | 'EXPIRED' | 'USED_UP'
}

/** 邀请页展示的信息（公开接口，手机号已脱敏） */
export interface InviteInfo {
  tenantName: string
  tenantType: TenantType
  role: TenantRole
  phoneMasked: string | null
  expired: boolean
  usedUp: boolean
  valid: boolean
}

export interface AcceptInviteResult {
  tenantId: string
  tenantName: string
  role: TenantRole
  alreadyMember: boolean
}

/** 生成邀请链接（明文 token 只返回这一次） */
export const createInvite = async (
  tenantId: string,
  data: { phone?: string; role?: 'ADMIN' | 'MEMBER'; maxUses?: number }
): Promise<CreatedInvite> => {
  const response = await api.post<CreatedInvite>(
    `/tenants/${tenantId}/invites`,
    data
  )

  return response.data
}

/** 已发出的邀请列表 */
export const listInvites = async (tenantId: string): Promise<InviteRecord[]> => {
  const response = await api.get<InviteRecord[]>(`/tenants/${tenantId}/invites`)

  return response.data
}

/** 撤销邀请：链接立刻失效 */
export const revokeInvite = async (
  tenantId: string,
  inviteId: number
): Promise<{ revoked: boolean }> => {
  const response = await api.delete<{ revoked: boolean }>(
    `/tenants/${tenantId}/invites/${inviteId}`
  )

  return response.data
}

/** 校验邀请令牌（未登录也能调，用于邀请页展示企业名） */
export const inspectInvite = async (token: string): Promise<InviteInfo> => {
  const response = await api.post<InviteInfo>('/invites/inspect', { token })

  return response.data
}

/**
 * 接受邀请（需登录）。
 *
 * 加入后当前空间会被切到该企业，前端要再拉一次 /auth/me 刷新权限位。
 */
export const acceptInvite = async (
  token: string
): Promise<AcceptInviteResult> => {
  const response = await api.post<AcceptInviteResult>('/invites/accept', {
    token,
  })

  return response.data
}
