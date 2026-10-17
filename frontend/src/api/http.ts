import axios from 'axios'

const TOKEN_KEY = 'meetmind.token'

/**
 * 统一的 axios 实例。
 *
 * 所有请求自动带上 JWT；收到 401 时清理登录态并跳登录页。
 * token 直接读 localStorage 而不是 import authStore，
 * 是为了避免 api ← → stores 的循环依赖。
 */
const api = axios.create({
  baseURL:
    import.meta.env.VITE_API_BASE_URL ||
    'http://127.0.0.1:3000/api',
  timeout: 60000,
  headers: {
    'Content-Type': 'application/json'
  }
})

api.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY)

  if (token) {
    config.headers = config.headers ?? {}
    config.headers.Authorization = `Bearer ${token}`
  }

  return config
})

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error?.response?.status

    /**
     * 401 表示登录失效：清理本地 token 并回登录页。
     *
     * 登录 / 注册接口本身返回 401 时不跳转，
     * 否则用户输错密码会被整页刷新，看不到错误提示。
     */
    const url: string = error?.config?.url ?? ''
    const isAuthEndpoint = url.includes('/auth/login') || url.includes('/auth/register')

    if (status === 401 && !isAuthEndpoint) {
      localStorage.removeItem(TOKEN_KEY)

      const current = window.location.pathname + window.location.search

      if (!current.startsWith('/login')) {
        window.location.href = `/login?redirect=${encodeURIComponent(current)}`
      }
    }

    return Promise.reject(error)
  }
)

export default api
