import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import zhCn from 'element-plus/es/locale/lang/zh-cn'

import App from './App.vue'
import router from './router'
import { authStore } from './stores/auth'
import { fetchMe } from './api/auth'

/**
 * 先恢复登录态再挂载应用。
 *
 * 顺序很重要：路由守卫会读取 authStore.isAuthenticated，
 * 如果先挂载再异步恢复，首屏会被守卫误判为未登录而跳到 /login。
 */
const bootstrap = async () => {
  const token = authStore.restore()

  if (token) {
    try {
      // 用 token 换取最新的用户信息与权限位
      const user = await fetchMe()
      authStore.setUser(user)
    } catch {
      // token 失效（过期 / 被停用）：清掉本地状态，回到未登录
      authStore.clear()
    }
  }

  const app = createApp(App)

  // 将 Element Plus 的内置按钮、空状态和日期文案统一设为简体中文。
  app.use(ElementPlus, { locale: zhCn })
  app.use(router)

  app.mount('#app')
}

bootstrap()
