<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { authStore } from '../stores/auth'

const router = useRouter()

const user = computed(() => authStore.user)

/** 首页四个入口，对应左侧导航的四个功能 */
const entries = [
  {
    key: 'minutes',
    icon: '📝',
    title: '智能纪要',
    desc: '输入或实时转写会议内容，交给 AI 生成摘要、决策与待办',
    path: '/minutes'
  },
  {
    key: 'dashboard',
    icon: '📊',
    title: '数据看板',
    desc: '查看会议、待办与决策的整体统计和完成情况',
    path: '/dashboard'
  },
  {
    key: 'history',
    icon: '🗂',
    title: '历史会议',
    desc: '检索、置顶、修改状态，回听录音与核对纪要',
    path: '/history'
  },
  {
    key: 'drafts',
    icon: '📥',
    title: '草稿箱',
    desc: '存放未生成的会议原文，稍后继续生成纪要',
    path: '/drafts'
  }
]

const go = (path: string) => {
  router.push(path)
}
</script>

<template>
  <div class="meetmind-page">
    <div class="page-container">
      <header class="hero">
        <div class="hero-mark">M</div>

        <h1>MeetMind</h1>

        <p class="hero-sub">
          AI 智能会议纪要
        </p>

        <p v-if="user" class="hero-welcome">
          {{ user.name }}，欢迎回来
        </p>
      </header>

      <div class="entry-grid">
        <button v-for="entry in entries" :key="entry.key" type="button" class="entry-card"
          @click="go(entry.path)">
          <span class="entry-icon">{{ entry.icon }}</span>

          <span class="entry-body">
            <span class="entry-title">{{ entry.title }}</span>
            <span class="entry-desc">{{ entry.desc }}</span>
          </span>

          <span class="entry-arrow">→</span>
        </button>
      </div>

      <p class="footnote">
        更多模块陆续加入中
      </p>
    </div>
  </div>
</template>

<style scoped>
.meetmind-page {
  min-height: 100%;
  background: #f5f7fa;
  padding: 56px 20px 80px;
}

.page-container {
  max-width: 900px;
  margin: 0 auto;
}

.hero {
  text-align: center;
  margin-bottom: 40px;
}

.hero-mark {
  width: 56px;
  height: 56px;
  margin: 0 auto 16px;

  display: flex;
  align-items: center;
  justify-content: center;

  border-radius: 16px;
  background: #409eff;
  color: #ffffff;

  font-size: 26px;
  font-weight: 700;
}

.hero h1 {
  margin: 0 0 8px;
  font-size: 34px;
  font-weight: 700;
  color: #303133;
}

.hero-sub {
  margin: 0;
  color: #909399;
  font-size: 14px;
}

.hero-welcome {
  margin: 14px 0 0;
  color: #606266;
  font-size: 14px;
}

.entry-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.entry-card {
  display: flex;
  align-items: center;
  gap: 14px;

  padding: 20px 18px;
  text-align: left;

  background: #ffffff;
  border: 1px solid #ebeef5;
  border-radius: 12px;

  cursor: pointer;
  transition: border-color 0.2s, box-shadow 0.2s, transform 0.2s;
}

.entry-card:hover {
  border-color: #a0cfff;
  box-shadow: 0 6px 18px rgba(64, 158, 255, 0.12);
  transform: translateY(-1px);
}

.entry-icon {
  width: 44px;
  height: 44px;
  flex-shrink: 0;

  display: flex;
  align-items: center;
  justify-content: center;

  border-radius: 12px;
  background: #f0f7ff;

  font-size: 22px;
}

.entry-body {
  flex: 1;
  min-width: 0;

  display: flex;
  flex-direction: column;
  gap: 4px;
}

.entry-title {
  color: #303133;
  font-size: 16px;
  font-weight: 600;
}

.entry-desc {
  color: #909399;
  font-size: 12px;
  line-height: 1.6;
}

.entry-arrow {
  flex-shrink: 0;
  color: #c0c4cc;
  font-size: 16px;
  transition: color 0.2s;
}

.entry-card:hover .entry-arrow {
  color: #409eff;
}

.footnote {
  margin-top: 32px;
  text-align: center;
  color: #c0c4cc;
  font-size: 12px;
}

@media (max-width: 768px) {
  .meetmind-page {
    padding: 32px 12px 48px;
  }

  .entry-grid {
    grid-template-columns: 1fr;
  }

  .hero h1 {
    font-size: 26px;
  }
}
</style>
