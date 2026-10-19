import api from './http'
import type { CurrentUser, Role } from '../stores/auth'

export interface LoginResult {
  token: string
  user: CurrentUser
}

/** 登录 */
export const login = async (
  phone: string,
  password: string
): Promise<LoginResult> => {
  const response = await api.post<LoginResult>('/auth/login', {
    phone,
    password
  })

  return response.data
}

/** 自助注册（只会得到 USER 角色） */
export const register = async (data: {
  phone: string
  password: string
  name: string
}): Promise<LoginResult> => {
  const response = await api.post<LoginResult>('/auth/register', data)

  return response.data
}

/** 拉取当前登录用户（刷新页面后恢复权限） */
export const fetchMe = async (): Promise<CurrentUser> => {
  const response = await api.get<CurrentUser>('/auth/me')

  return response.data
}

/**
 * 修改自己的资料（个人中心）。
 *
 * 只要求登录即可调用：普通用户也需要能改自己的姓名与密码，
 * 而管理用户的接口需要 user:manage 权限。
 * 改密码时必须同时提供原密码。
 */
export const updateProfile = async (data: {
  name?: string
  currentPassword?: string
  newPassword?: string
}): Promise<CurrentUser> => {
  const response = await api.patch<CurrentUser>('/auth/me', data)

  return response.data
}

/** ───────────── 用户管理（管理员及以上） ───────────── */

export interface ManagedUser {
  id: number
  phone: string
  name: string
  role: Role
  isActive: boolean
  createdAt: string
}

/** 用户列表，可供分享时挑选接收人 */
export const listUsers = async (params?: {
  keyword?: string
  role?: string
}): Promise<ManagedUser[]> => {
  const response = await api.get<ManagedUser[]>('/users', { params })

  return response.data
}

/**
 * 通讯录：只含姓名与手机号的最小集合。
 *
 * 任何已登录用户都能调用，用于在会议里指定负责人与成员 ——
 * 普通用户没有 user:read 权限，无法使用完整用户列表。
 */
export interface Contact {
  id: number
  name: string
  phone: string
}

export const listContacts = async (): Promise<Contact[]> => {
  const response = await api.get<Contact[]>('/users/contacts')

  return response.data
}

/** 新建账号 */
export const createUser = async (data: {
  phone: string
  password: string
  name: string
  role?: Role
}): Promise<ManagedUser> => {
  const response = await api.post<ManagedUser>('/users', data)

  return response.data
}

/** 修改资料 / 手机号 / 角色 / 启用状态 */
export const updateUser = async (
  id: number,
  data: {
    phone?: string
    name?: string
    role?: Role
    isActive?: boolean
    password?: string
  }
): Promise<ManagedUser> => {
  const response = await api.patch<ManagedUser>(`/users/${id}`, data)

  return response.data
}

/** 删除账号 */
export const deleteUser = async (id: number) => {
  const response = await api.delete(`/users/${id}`)

  return response.data
}

/**
 * 以指定账号身份浏览（超级管理员专用）。
 *
 * 后端返回该账号的 token 与其公开信息，用于前端切换会话。
 */
export const impersonateUser = async (
  id: number
): Promise<{
  token: string
  user: CurrentUser
  impersonatedBy: { id: number; name: string }
}> => {
  const response = await api.post(`/users/${id}/impersonate`)

  return response.data
}

/** ───────────── 会议共享 ───────────── */

export type SharePermission = 'READ' | 'EDIT'

export interface MeetingShare {
  id: number
  userId: number
  phone: string
  name: string
  role?: Role
  permission: SharePermission
  grantedBy?: string
  createdAt: string
}

/** 查看某场会议的共享名单 */
export const listShares = async (
  meetingId: number
): Promise<MeetingShare[]> => {
  const response = await api.get<MeetingShare[]>(
    `/meetings/${meetingId}/shares`
  )

  return response.data
}

/** 共享会议给某人（重复调用即更新权限） */
export const shareMeeting = async (
  meetingId: number,
  userId: number,
  permission: SharePermission
): Promise<MeetingShare> => {
  const response = await api.post<MeetingShare>(
    `/meetings/${meetingId}/shares`,
    { userId, permission }
  )

  return response.data
}

/** 撤销某人的共享 */
export const revokeShare = async (
  meetingId: number,
  userId: number
) => {
  const response = await api.delete(
    `/meetings/${meetingId}/shares/${userId}`
  )

  return response.data
}
