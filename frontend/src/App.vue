<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { provideDraftStore } from './composables/draftStore'
import { authStore } from './stores/auth'

const draftStore = provideDraftStore()
const route = useRoute()

/**
 * 登录页不渲染侧边栏与内容框架。
 *
 * 用 route.meta.requiresAuth === false 判断，
 * 后续再加公开页面时无需改这里。
 */
const isPublicPage = computed(() => route.meta.requiresAuth === false)

const currentUser = computed(() => authStore.user)

onMounted(async () => {
  // 未登录时（登录页）不拉草稿数量，避免无谓的 401
  if (authStore.isAuthenticated.value) {
    await draftStore.refresh()
  }
})
</script>

<template>
  <!-- 登录页：整页渲染，不带侧边栏 -->
  <router-view v-if="isPublicPage" />

  <div v-else class="app">
    <!-- 竖向侧边导航：在纪要生成页、数据看板、历史记录和草稿箱之间切换。 -->
    <aside class="sidebar">
      <router-link
        to="/"
        class="logo"
      >
        <span class="logo-icon">🧠</span>
        <span class="logo-text">MeetMind</span>
      </router-link>

      <nav class="nav">
        <router-link
          to="/"
          class="nav-item"
        >
          <span class="nav-icon">📝</span>
          <span class="nav-label">智能纪要</span>
        </router-link>

        <router-link
          to="/dashboard"
          class="nav-item"
        >
          <span class="nav-icon">📊</span>
          <span class="nav-label">数据看板</span>
        </router-link>

        <router-link
          to="/history"
          class="nav-item"
        >
          <span class="nav-icon">🗂</span>
          <span class="nav-label">历史会议</span>
        </router-link>

        <router-link
          to="/drafts"
          class="nav-item"
        >
          <span class="nav-icon">📥</span>
          <span class="nav-label">草稿箱</span>

          <span
            v-if="draftStore.count > 0"
            class="draft-count"
          >
            {{
              draftStore.count > 99
                ? '99+'
                : draftStore.count
            }}
          </span>
        </router-link>
      </nav>

      <!--
        当前登录用户区，固定在侧边栏底部。

        头像与用户名本身就是「个人中心」的入口 —— 因此导航栏里不再需要
        个人中心/用户管理这类条目，点这里即可进入。
        退出登录已移入个人中心页，这里不再放按钮，避免在侧边栏误触退出。
      -->
      <div v-if="currentUser" class="user-panel">
        <router-link
          to="/profile"
          class="user-main"
          :class="{ 'user-active': route.path === '/profile' }"
          title="进入个人中心"
        >
          <span class="user-avatar">
            {{ currentUser.name.slice(0, 1) }}
          </span>

          <div class="user-meta">
            <div class="user-name">
              {{ currentUser.name }}
            </div>

            <div class="user-role">
              {{ currentUser.roleLabel }}
            </div>
          </div>

          <span class="user-arrow">›</span>
        </router-link>
      </div>
    </aside>

    <main class="main">
      <router-view />
    </main>
  </div>
</template>

<style>
* {
  box-sizing: border-box;
}

html,
body,
#app {
  margin: 0;
  min-height: 100%;
}

body {
  font-family:
    Inter,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    "Microsoft YaHei",
    sans-serif;

  color: #303133;
  background: #f5f7fa;
}

a {
  text-decoration: none;
}

/**
 * 竖向侧边栏 + 内容区的两栏布局。
 *
 * 用 min-height 而不是 height，页面变长时由文档整体滚动，
 * 侧边栏是正常文档流的一部分，自然会被拉满整列高度。
 * 这样避免给内容区再加一层独立滚动条（会出现双滚动条）。
 */
.app {
  display: flex;
  align-items: stretch;
  min-height: 100vh;
}

.sidebar {
  width: 200px;

  display: flex;
  flex-direction: column;

  background: #ffffff;
  border-right: 1px solid #ebeef5;

  /**
   * 固定定位，脱离文档流。
   *
   * 曾用 sticky + 100vh，但 sticky 只在父容器范围内生效：
   * 页面极长时滚到底部，侧边栏会被父容器边界推出视口，
   * 左下角的个人中心入口就点不到了。
   * fixed 让它始终贴住视口，内容区用 margin-left 让出宽度。
   */
  position: fixed;
  top: 0;
  left: 0;
  bottom: 0;

  overflow-y: auto;
  z-index: 100;
}

.main {
  flex: 1;
  min-width: 0;
  /* 侧边栏已脱离文档流，这里让出它的宽度 */
  margin-left: 200px;
}

.logo {
  display: flex;
  align-items: center;
  gap: 8px;

  height: 64px;
  padding: 0 20px;
  /* 与导航项左内边距对齐，图标与文字能连成一条竖线 */
  flex-shrink: 0;

  color: #303133;
  font-size: 20px;
  font-weight: 700;

  border-bottom: 1px solid #f2f3f5;
}

.logo-icon {
  font-size: 24px;
}

.logo-text {
  white-space: nowrap;
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 4px;

  padding: 12px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;

  padding: 11px 12px;
  border-radius: 8px;

  color: #606266;
  font-size: 14px;

  transition: background 0.2s, color 0.2s;
}

.nav-item:hover {
  color: #409eff;
  background: #f5f7fa;
}

.nav-item.router-link-active {
  color: #409eff;
  font-weight: 600;
  background: #ecf5ff;
}

/* 固定宽度让四个图标在竖向上对齐 */
.nav-icon {
  width: 18px;
  flex-shrink: 0;
  text-align: center;
  font-size: 15px;
}

.nav-label {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.draft-count {
  min-width: 18px;
  height: 18px;
  padding: 0 5px;

  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;

  border-radius: 10px;

  background: #f56c6c;
  color: #ffffff;

  font-size: 11px;
  line-height: 18px;
  font-weight: 600;
}

/* 侧边栏底部的当前用户区 */
.user-panel {
  margin-top: auto;
  padding: 14px 16px 16px;
  border-top: 1px solid #f2f3f5;

  display: flex;
  flex-direction: column;
  gap: 10px;
}

.user-main {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;

  /* 整块是「个人中心」入口，做成可点区域并给出悬停反馈 */
  padding: 6px 8px;
  margin: -6px -8px;
  border-radius: 8px;

  color: inherit;
  transition: background 0.2s;
}

.user-main:hover {
  background: #f5f7fa;
}

/* 进入个人中心时高亮，让用户知道自己当前在哪一页 */
.user-main.user-active {
  background: #ecf5ff;
}

.user-avatar {
  width: 30px;
  height: 30px;
  flex-shrink: 0;

  display: flex;
  align-items: center;
  justify-content: center;

  border-radius: 50%;
  background: #ecf5ff;
  color: #409eff;

  font-size: 14px;
  font-weight: 600;
}

/* 个人中心页高亮时，头像底色也跟着变深一点 */
.user-main.user-active .user-avatar {
  background: #d9ecff;
}

.user-arrow {
  margin-left: auto;
  flex-shrink: 0;
  color: #c0c4cc;
  font-size: 16px;
  line-height: 1;
}

.user-meta {
  min-width: 0;
  flex: 1;
}

.user-name {
  color: #303133;
  font-size: 13px;
  font-weight: 600;

  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.user-role {
  color: #909399;
  font-size: 12px;
}

/**
 * 窄屏下改为上下堆叠，重新回到「导航在顶部」的形态，
 * 因为 200px 的侧边栏会挤占过多横向空间。
 */
@media (max-width: 768px) {
  .app {
    flex-direction: column;
  }

  .sidebar {
    width: 100%;
    border-right: none;
    border-bottom: 1px solid #ebeef5;

    /* 窄屏改成上下堆叠，固定定位会把内容盖住，恢复为普通流式布局 */
    position: static;
    overflow-y: visible;
  }

  .main {
    /* 窄屏侧边栏回到文档流，不再需要让出宽度 */
    margin-left: 0;
  }

  .logo {
    height: 56px;
  }

  .nav {
    flex-direction: row;
    overflow-x: auto;
    padding: 8px 12px;
  }

  .nav-item {
    flex-shrink: 0;
    padding: 8px 12px;
  }

  .nav-label {
    flex: 0 0 auto;
  }
}
</style>