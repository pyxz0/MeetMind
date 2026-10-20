<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { authStore } from '../stores/auth'
import { getMeetingsPage, type MeetingRecord } from '../api/meeting'

const router = useRouter()

const user = computed(() => authStore.user)

/* =========================
   置顶会议提醒
   ========================= */

const pinnedMeetings = ref<MeetingRecord[]>([])

/** 尚未开始的会议：预约时间还没到 */
const upcomingMeetings = ref<MeetingRecord[]>([])

/** 首页只展示少量置顶，多了反而变成第二个列表页 */
const PINNED_PREVIEW_LIMIT = 3
const UPCOMING_PREVIEW_LIMIT = 3

const visiblePinned = computed(() =>
  pinnedMeetings.value.slice(0, PINNED_PREVIEW_LIMIT)
)

const visibleUpcoming = computed(() =>
  upcomingMeetings.value.slice(0, UPCOMING_PREVIEW_LIMIT)
)

const hiddenPinnedCount = computed(() =>
  Math.max(0, pinnedMeetings.value.length - PINNED_PREVIEW_LIMIT)
)

const hiddenUpcomingCount = computed(() =>
  Math.max(0, upcomingMeetings.value.length - UPCOMING_PREVIEW_LIMIT)
)

/** 两个提醒块都为空时整行不渲染 */
const hasNotice = computed(
  () => pinnedMeetings.value.length > 0 || upcomingMeetings.value.length > 0
)

/** 只有一个块有数据时占满整行，避免留下半列空白 */
const noticeColumns = computed(() => {
  const count =
    Number(pinnedMeetings.value.length > 0) +
    Number(upcomingMeetings.value.length > 0)

  return count === 1 ? 'single' : 'double'
})

/** 距离开始还有多久，用于给出直观的紧迫感 */
const formatCountdown = (value?: string | null) => {
  if (!value) return ''

  const diff = new Date(value).getTime() - Date.now()

  if (diff <= 0) return '即将开始'

  const minutes = Math.floor(diff / 60000)

  if (minutes < 60) return `${minutes} 分钟后`

  const hours = Math.floor(minutes / 60)

  if (hours < 24) return `${hours} 小时后`

  return `${Math.floor(hours / 24)} 天后`
}

const formatScheduled = (value?: string | null) => {
  if (!value) return ''

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) return ''

  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

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

/** 首页只需两小块数据：置顶的、未开始的，各自单独查询，不拉全量历史 */
const loadMeetings = async () => {
  try {
    const [pinnedPage, upcomingPage] = await Promise.all([
      getMeetingsPage({ pinned: true, pageSize: 20 }),
      getMeetingsPage({ upcoming: true, pageSize: 20 })
    ])

    pinnedMeetings.value = pinnedPage.items

    upcomingMeetings.value = [...upcomingPage.items].sort(
      (a, b) =>
        new Date(a.scheduledAt as string).getTime() -
        new Date(b.scheduledAt as string).getTime()
    )
  } catch (error) {
    // 提醒区属于辅助信息，加载失败不应打断首页
    console.error('会议提醒加载失败：', error)
    pinnedMeetings.value = []
    upcomingMeetings.value = []
  }
}

onMounted(loadMeetings)

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

      <!-- 置顶会议 + 未开始的会议：并排展示，都为空时整行不渲染 -->
      <div v-if="hasNotice" :class="['notice-row', noticeColumns]">
        <!-- 置顶会议 -->
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

        <!-- 未开始的会议 -->
        <div v-if="visibleUpcoming.length" class="upcoming-bar">
          <div class="pinned-head">
            <span class="pinned-head-icon">🕒</span>

            <span class="pinned-head-title">未开始的会议</span>

            <span class="pinned-head-count upcoming-count">{{ upcomingMeetings.length }}</span>
          </div>

          <ul class="pinned-list">
            <li v-for="meeting in visibleUpcoming" :key="meeting.id" class="pinned-item" :title="meeting.title"
              @click="go(`/history/${meeting.id}`)">
              <span class="pinned-item-title">
                {{ meeting.title || `会议 #${meeting.id}` }}
              </span>

              <span class="upcoming-time">
                {{ formatScheduled(meeting.scheduledAt) }}
              </span>

              <el-tag type="primary" size="small" effect="plain" class="pinned-item-tag">
                {{ formatCountdown(meeting.scheduledAt) }}
              </el-tag>

              <span class="pinned-item-arrow">→</span>
            </li>
          </ul>

          <div v-if="hiddenUpcomingCount > 0" class="upcoming-more-tip">
            还有 {{ hiddenUpcomingCount }} 场未开始的会议
          </div>
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
/* 两个提醒块并排；只有一个时占满整行 */
.notice-row {
  display: grid;
  gap: 16px;
  margin-bottom: 20px;
}

.notice-row.double {
  grid-template-columns: 1fr 1fr;
}

.notice-row.single {
  grid-template-columns: 1fr;
}

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

/* ---- 未开始的会议：与置顶区分开，用蓝色系 ---- */
.upcoming-bar {
  padding: 12px 16px;

  background: #f7fbff;
  border: 1px solid #c6e2ff;
  border-left: 3px solid #409eff;
  border-radius: 10px;
}

.upcoming-count {
  background: #e6f2ff;
  color: #337ecc;
}

.upcoming-time {
  flex-shrink: 0;
  color: #909399;
  font-size: 12px;
}

.upcoming-more-tip {
  margin-top: 6px;
  padding-left: 6px;
  color: #337ecc;
  font-size: 12px;
}

@media (max-width: 900px) {
  .notice-row.double {
    grid-template-columns: 1fr;
  }
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
