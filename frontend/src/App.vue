<script setup lang="ts">
import { onMounted } from 'vue'
import { provideDraftStore } from './composables/draftStore'

const draftStore = provideDraftStore()

onMounted(async () => {
  await draftStore.refresh()
})
</script>

<template>
  <div class="app">
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
  flex: 0 0 200px;
  width: 200px;

  display: flex;
  flex-direction: column;

  background: #ffffff;
  border-right: 1px solid #ebeef5;
}

.main {
  flex: 1;
  min-width: 0;
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

/**
 * 窄屏下改为上下堆叠，重新回到「导航在顶部」的形态，
 * 因为 200px 的侧边栏会挤占过多横向空间。
 */
@media (max-width: 768px) {
  .app {
    flex-direction: column;
  }

  .sidebar {
    flex: 0 0 auto;
    width: 100%;
    border-right: none;
    border-bottom: 1px solid #ebeef5;
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