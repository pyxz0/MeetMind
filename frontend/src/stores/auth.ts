import { computed, reactive } from 'vue'

/** 与后端保持一致的权限字符串 */
export type Permission =
  | 'meeting:read:own'
  | 'meeting:create'
  | 'meeting:update:own'
  | 'meeting:delete:own'
  | 'meeting:read:all'
  | 'meeting:update:all'
  | 'meeting:delete:all'
  | 'meeting:share:own'
  | 'meeting:share:all'
  | 'user:read'
  | 'user:manage'
  | 'user:manage:admin'
  | 'audit:read'

export type Role = 'SUPER_ADMIN' | 'ADMIN' | 'USER'

export interface CurrentUser {
  id: number
  email: string
  name: string
  role: Role
  roleLabel: string
  isActive: boolean
  permissions: Permission[]
  createdAt: string
}

const TOKEN_KEY = 'meetmind.token'

/**
 * 全局认证状态。
 *
 * token 持久化到 localStorage：刷新页面后保持登录，
 * 与后端 7 天有效期配合。
 */
const state = reactive<{
  token: string | null
  user: CurrentUser | null
  /** 是否已完成首次恢复（避免路由守卫误判跳登录页） */
  ready: boolean
}>({
  token: null,
  user: null,
  ready: false,
})

export const authStore = {
  state,

  /** 是否已登录 */
  isAuthenticated: computed(() => !!state.token && !!state.user),

  get token() {
    return state.token
  },

  get user() {
    return state.user
  },

  /** 当前用户是否具备某权限 */
  can(permission: Permission) {
    return !!state.user?.permissions?.includes(permission)
  },

  /** 是否具备任意一个权限 */
  canAny(permissions: Permission[]) {
    return permissions.some((p) => this.can(p))
  },

  /** 从 localStorage 恢复 token，供应用启动时调用 */
  restore() {
    const token = localStorage.getItem(TOKEN_KEY)

    if (token) {
      state.token = token
    }

    state.ready = true

    return token
  },

  setSession(token: string, user: CurrentUser) {
    state.token = token
    state.user = user
    localStorage.setItem(TOKEN_KEY, token)
  },

  setUser(user: CurrentUser) {
    state.user = user
  },

  /** 退出登录：清空内存与本地存储 */
  clear() {
    state.token = null
    state.user = null
    localStorage.removeItem(TOKEN_KEY)
  },
}
