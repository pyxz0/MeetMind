<template>
  <div class="app">
    <!-- 全局导航负责在纪要生成页和历史记录页之间切换。 -->
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
            to="/history"
            class="nav-item"
          >
            历史会议
          </router-link>
        </nav>

      </div>
    </header>

    <!-- 当前路由页面渲染在这里，导航栏在页面切换时保持不变。 -->
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
</style>
