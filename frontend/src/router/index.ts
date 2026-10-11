import { createRouter, createWebHistory } from 'vue-router'

import HomeView from '../views/HomeView.vue'
import HistoryView from '../views/HistoryView.vue'
import MeetingDetailView from '../views/MeetingDetailView.vue'
import DraftsView from '../views/DraftsView.vue'
import DashboardView from '../views/DashboardView.vue'

const router = createRouter({
  history: createWebHistory(),

  routes: [
    {
      path: '/',
      name: 'home',
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
  ],
})

export default router