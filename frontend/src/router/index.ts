import { createRouter, createWebHistory } from 'vue-router'

import HomeView from '../views/HomeView.vue'
import MeetMindView from '../views/MeetMindView.vue'
import MinutesView from '../views/MinutesView.vue'
import UploadMinutesView from '../views/UploadMinutesView.vue'
import InboxView from '../views/InboxView.vue'
import AuditView from '../views/AuditView.vue'
import HistoryView from '../views/HistoryView.vue'
import MeetingDetailView from '../views/MeetingDetailView.vue'
import DraftsView from '../views/DraftsView.vue'
import DashboardView from '../views/DashboardView.vue'
import LoginView from '../views/LoginView.vue'
import ResetPasswordView from '../views/ResetPasswordView.vue'
import ForgotPasswordView from '../views/ForgotPasswordView.vue'
import UsersView from '../views/UsersView.vue'
import ProfileView from '../views/ProfileView.vue'
import { authStore, type Permission } from '../stores/auth'

declare module 'vue-router' {
  interface RouteMeta {
    /** 是否需要登录，默认 true */
    requiresAuth?: boolean
    /** 访问该页面所需的权限（满足任意一个即可） */
    permissions?: Permission[]
  }
}

const router = createRouter({
  history: createWebHistory(),

  routes: [
    {
      path: '/login',
      name: 'login',
      component: LoginView,
      meta: { requiresAuth: false },
    },

    {
      /** 自助找回：输入绑定邮箱，收一次性链接 */
      path: '/forgot-password',
      name: 'forgot-password',
      component: ForgotPasswordView,
      meta: { requiresAuth: false },
    },

    {
      /**
       * 重置密码：管理员发来的一次性链接落到这里。
       *
       * 不需要登录——忘记了密码的人本来就没有会话。
       */
      path: '/reset-password',
      name: 'reset-password',
      component: ResetPasswordView,
      meta: { requiresAuth: false },
    },

    {
      /**
       * 首页：MeetMind 入口页。
       *
       * 暂时只放四个功能入口（对应左侧导航的四个按钮），
       * 后续可以在这里继续扩展模块。
       */
      path: '/',
      name: 'home',
      component: MeetMindView,
    },

    {
      /** 智能纪要入口：临时会议 / 正式会议 */
      path: '/minutes',
      name: 'minutes',
      component: MinutesView,
    },

    {
      /** 上传录音 / 会议文件，服务端转写后生成纪要 */
      path: '/minutes/upload',
      name: 'minutes-upload',
      component: UploadMinutesView,
    },

    {
      /** 临时会议的即时纪要流程（原首页内容） */
      path: '/minutes/instant',
      name: 'minutes-instant',
      component: HomeView,
    },

    {
      path: '/dashboard',
      name: 'dashboard',
      component: DashboardView,
    },

    {
      path: '/drafts',
      name: 'drafts',
      component: DraftsView,
    },

    {
      /** 收件箱：会议通知与待办提醒 */
      path: '/inbox',
      name: 'inbox',
      component: InboxView,
    },

    {
      path: '/history',
      name: 'history',
      component: HistoryView,
    },

    {
      path: '/history/:id',
      name: 'meeting-detail',
      component: MeetingDetailView,
      props: true,
    },

    {
      /**
       * 个人中心。
       *
       * 不放进侧边栏导航：入口是左下角的头像 / 用户名。
       * 任何登录用户都能访问自己的个人中心，因此不设额外权限。
       */
      path: '/profile',
      name: 'profile',
      component: ProfileView,
    },

    {
      /**
       * 审计日志：只读，入口在个人中心（仅具备 audit:read 的角色可见）。
       */
      path: '/audit',
      name: 'audit',
      component: AuditView,
      meta: { permissions: ['audit:read'] },
    },

    {
      /**
       * 用户管理：管理员管所有账号的页面。
       *
       * 同样不占导航栏，入口在个人中心里（仅具备 user:read 的角色可见）。
       */
      path: '/users',
      name: 'users',
      component: UsersView,
      meta: { permissions: ['user:read'] },
    },

    {
      // 未匹配到的路径回首页，避免白屏
      path: '/:pathMatch(.*)*',
      redirect: '/',
    },
  ],
})

/**
 * 全局路由守卫。
 *
 * 前端守卫只负责体验（避免闪一下未授权页面），
 * 真正的权限判定始终在后端 —— 前端隐藏按钮不等于安全。
 */
router.beforeEach((to) => {
  const requiresAuth = to.meta.requiresAuth !== false

  if (!requiresAuth) {
    // 已登录还去登录页就直接回首页
    if (to.name === 'login' && authStore.isAuthenticated.value) {
      return { path: '/' }
    }

    return true
  }

  if (!authStore.isAuthenticated.value) {
    return {
      path: '/login',
      query: { redirect: to.fullPath },
    }
  }

  const required = to.meta.permissions

  if (required?.length && !authStore.canAny(required)) {
    // 无权访问时回首页；后端同样会拒绝，这里只是避免看到空页面
    return { path: '/' }
  }

  return true
})

export default router
