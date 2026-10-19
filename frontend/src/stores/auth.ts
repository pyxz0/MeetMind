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
  /** 手机号，唯一登录标识 */
  phone: string
  name: string
  role: Role
  roleLabel: string
  isActive: boolean
  permissions: Permission[]
  createdAt: string
}

const TOKEN_KEY = 'meetmind.token'

/** 代登时保存「原账号」的会话，供一键返回使用 */
const IMPERSONATION_KEY = 'meetmind.impersonation'

/** 代登状态：记录真实超管账号与被代登账号的信息 */
export interface ImpersonationState {
  originalToken: string
  originalUser: CurrentUser
  targetName: string
  targetPhone: string
}

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
  /** 非空表示当前处于「以他人身份浏览」状态 */
  impersonation: ImpersonationState | null
}>({
  token: null,
  user: null,
  ready: false,
  impersonation: null,
})

export const authStore = {
  state,

  /** 是否已登录 */
  isAuthenticated: computed(() => !!state.token && !!state.user),

  /** 是否正处于代登状态 */
  isImpersonating: computed(() => state.impersonation !== null),

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

    // 恢复代登状态：刷新页面后仍能显示身份提示条并返回原账号
    const raw = sessionStorage.getItem(IMPERSONATION_KEY)

    if (raw) {
      try {
        state.impersonation = JSON.parse(raw)
      } catch {
        // 数据损坏就当没在代登，避免卡在异常状态
        sessionStorage.removeItem(IMPERSONATION_KEY)
        state.impersonation = null
      }
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

  /**
   * 以他人身份浏览。
   *
   * 先把当前（超管）会话存入 sessionStorage，再切换到目标账号的 token。
   * 用 sessionStorage 而非 localStorage：代登属于临时状态，
   * 关掉标签页后不应残留。
   */
  startImpersonation(
    targetToken: string,
    targetUser: CurrentUser,
  ) {
    if (!state.token || !state.user) {
      return
    }

    const snapshot: ImpersonationState = {
      originalToken: state.token,
      originalUser: state.user,
      targetName: targetUser.name,
      targetPhone: targetUser.phone,
    }

    state.impersonation = snapshot
    sessionStorage.setItem(IMPERSONATION_KEY, JSON.stringify(snapshot))

    this.setSession(targetToken, targetUser)
  },

  /** 返回自己的账号：恢复原超管会话 */
  endImpersonation() {
    const snapshot = state.impersonation

    if (!snapshot) {
      return
    }

    state.impersonation = null
    sessionStorage.removeItem(IMPERSONATION_KEY)

    this.setSession(snapshot.originalToken, snapshot.originalUser)
  },

  /** 退出登录：清空内存与本地存储 */
  clear() {
    state.token = null
    state.user = null
    state.impersonation = null
    localStorage.removeItem(TOKEN_KEY)
    sessionStorage.removeItem(IMPERSONATION_KEY)
  },
}
