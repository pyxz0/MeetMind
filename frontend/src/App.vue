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
    <!-- 全局导航负责在纪要生成页、数据看板、历史记录和草稿箱之间切换。 -->
    <header class="navbar">
      <div class="navbar-inner">

        <router-link
          to="/"
          class="logo"
        >
          <span class="logo-icon">🧠</span>
          <span>MeetMind</span>
        </router-link>

        <nav class="nav">
          <router-link
            to="/"
            class="nav-item"
          >
            智能纪要
          </router-link>

          <router-link
            to="/dashboard"
            class="nav-item"
          >
            数据看板
          </router-link>

          <router-link
            to="/history"
            class="nav-item"
          >
            历史会议
          </router-link>

          <router-link
            to="/drafts"
            class="nav-item draft-nav-item"
          >
            <span>草稿箱</span>

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

      </div>
    </header>

    <main>
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

.navbar {
  height: 64px;
  background: #ffffff;
  border-bottom: 1px solid #ebeef5;
}

.navbar-inner {
  max-width: 1000px;
  height: 100%;
  margin: 0 auto;
  padding: 0 20px;

  display: flex;
  justify-content: space-between;
  align-items: center;
}

.logo {
  display: flex;
  align-items: center;
  gap: 8px;

  color: #303133;
  font-size: 20px;
  font-weight: 700;
}

.logo-icon {
  font-size: 24px;
}

.nav {
  height: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
}

.nav-item {
  height: 100%;
  padding: 0 16px;

  display: flex;
  align-items: center;

  color: #606266;
  font-size: 14px;

  transition: all 0.2s;
}

.nav-item:hover {
  color: #409eff;
}

.nav-item.router-link-active {
  color: #409eff;
  font-weight: 600;
}

.draft-nav-item {
  position: relative;
  gap: 6px;
}

.draft-count {
  min-width: 18px;
  height: 18px;
  padding: 0 5px;

  display: inline-flex;
  align-items: center;
  justify-content: center;

  border-radius: 10px;

  background: #f56c6c;
  color: #ffffff;

  font-size: 11px;
  line-height: 18px;
  font-weight: 600;
}
</style>