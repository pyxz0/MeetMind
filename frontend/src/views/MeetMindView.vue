<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { authStore } from '../stores/auth'
import { getMeetings, type MeetingRecord } from '../api/meeting'

const router = useRouter()

const user = computed(() => authStore.user)

/* =========================
   置顶会议提醒
   ========================= */

const pinnedMeetings = ref<MeetingRecord[]>([])

/** 首页只展示少量置顶，多了反而变成第二个列表页 */
const PINNED_PREVIEW_LIMIT = 3

const visiblePinned = computed(() =>
  pinnedMeetings.value.slice(0, PINNED_PREVIEW_LIMIT)
)

const hiddenPinnedCount = computed(() =>
  Math.max(0, pinnedMeetings.value.length - PINNED_PREVIEW_LIMIT)
)

const getPinnedStatusText = (meeting: MeetingRecord) => {
  switch (meeting.completionStatus) {
    case 'COMPLETED':
      return '已完成'
    case 'IN_PROGRESS':
      return '进行中'
    case 'CANCELLED':
      return '已取消'
    default:
      return '未开始'
  }
}

const getPinnedStatusType = (meeting: MeetingRecord) => {
  switch (meeting.completionStatus) {
    case 'COMPLETED':
      return 'success'
    case 'IN_PROGRESS':
      return 'warning'
    case 'CANCELLED':
      return 'danger'
    default:
      return 'info'
  }
}

/** 接口已按「置顶优先 + 置顶时间倒序」排好，这里只过滤置顶项 */
const loadPinnedMeetings = async () => {
  try {
    const all = await getMeetings()

    pinnedMeetings.value = all.filter((meeting) => !!meeting.pinnedAt)
  } catch (error) {
    // 提醒区属于辅助信息，加载失败不应打断首页
    console.error('置顶会议加载失败：', error)
    pinnedMeetings.value = []
  }
}

onMounted(loadPinnedMeetings)

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

      <!-- 置顶会议提醒：只占一小块，用于把重要会议顶到眼前 -->
      <div v-if="visiblePinned.length" class="pinned-bar">
        <div class="pinned-head">
          <span class="pinned-head-icon">📌</span>

          <span class="pinned-head-title">置顶会议</span>

          <span class="pinned-head-count">{{ pinnedMeetings.length }}</span>

          <el-button link type="primary" size="small" class="pinned-head-more" @click="go('/history')">
            查看全部
          </el-button>
        </div>

        <ul class="pinned-list">
          <li v-for="meeting in visiblePinned" :key="meeting.id" class="pinned-item" :title="meeting.title"
            @click="go(`/history/${meeting.id}`)">
            <span class="pinned-item-title">
              {{ meeting.title || `会议 #${meeting.id}` }}
            </span>

            <el-tag :type="getPinnedStatusType(meeting)" size="small" class="pinned-item-tag">
              {{ getPinnedStatusText(meeting) }}
            </el-tag>

            <span class="pinned-item-arrow">→</span>
          </li>
        </ul>

        <div v-if="hiddenPinnedCount > 0" class="pinned-more-tip">
          还有 {{ hiddenPinnedCount }} 场置顶会议，可到历史会议查看
        </div>
      </div>

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

/**
 * 置顶会议提醒条：琥珀色左边框 + 浅底，占位小但足够显眼。
 */
.pinned-bar {
  margin-bottom: 20px;
  padding: 12px 16px;

  background: #fffdf7;
  border: 1px solid #f3d19e;
  border-left: 3px solid #e6a23c;
  border-radius: 10px;
}

.pinned-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.pinned-head-icon {
  font-size: 14px;
  line-height: 1;
}

.pinned-head-title {
  color: #303133;
  font-size: 13px;
  font-weight: 600;
}

.pinned-head-count {
  min-width: 18px;
  height: 18px;
  padding: 0 5px;

  display: inline-flex;
  align-items: center;
  justify-content: center;

  border-radius: 9px;
  background: #fdf0d9;
  color: #b88230;

  font-size: 11px;
  font-weight: 600;
}

.pinned-head-more {
  margin-left: auto;
}

.pinned-list {
  margin: 0;
  padding: 0;
  list-style: none;

  display: flex;
  flex-direction: column;
  gap: 2px;
}

.pinned-item {
  display: flex;
  align-items: center;
  gap: 10px;

  padding: 5px 6px;
  border-radius: 6px;
  cursor: pointer;

  transition: background 0.15s;
}

.pinned-item:hover {
  background: #fdf3e2;
}

.pinned-item-title {
  flex: 1;
  min-width: 0;
  color: #303133;
  font-size: 13px;

  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pinned-item:hover .pinned-item-title {
  color: #409eff;
}

.pinned-item-tag {
  flex-shrink: 0;
}

.pinned-item-arrow {
  flex-shrink: 0;
  color: #c0c4cc;
  font-size: 13px;
}

.pinned-more-tip {
  margin-top: 6px;
  padding-left: 6px;
  color: #b88230;
  font-size: 12px;
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
