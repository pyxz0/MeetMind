import { createRouter, createWebHistory } from 'vue-router'

import HomeView from '../views/HomeView.vue'
import HistoryView from '../views/HistoryView.vue'

// 集中声明工作台的页面地址、页面标题和切页后的滚动行为。
const router = createRouter({
  history: createWebHistory(),

  routes: [
    {
      path: '/',
      name: 'home',
      component: HomeView,
      meta: {
        title: '智能会议纪要'
      }
    },

    {
      path: '/history',
      name: 'history',
      component: HistoryView,
      meta: {
        title: '历史会议'
      }
    }
  ],

  // 切换页面时回到顶部，避免沿用上一页的滚动位置。
  scrollBehavior() {
    return {
      top: 0
    }
  }
})

// 页面切换完成后同步浏览器标签标题，便于区分当前功能页。
router.afterEach((to) => {
  document.title =
    `${to.meta.title || 'MeetMind'} - MeetMind`
})

export default router
