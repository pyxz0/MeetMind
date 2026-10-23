<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { authStore } from '../stores/auth'
import { getMeeting, getMeetingsPage, type MeetingRecord } from '../api/meeting'

const router = useRouter()

const user = computed(() => authStore.user)

/* =========================
   置顶会议提醒
   ========================= */

const pinnedMeetings = ref<MeetingRecord[]>([])

/** 尚未开始的会议：预约时间还没到 */
const upcomingMeetings = ref<MeetingRecord[]>([])

/** 最近生成的一份纪要：首页也要能看到纪要本身，而不只是入口 */
const latest = ref<MeetingRecord | null>(null)

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

/** 两个提醒块都为空时，右栏显示一句提示而不是空白 */
const hasNotice = computed(
  () => pinnedMeetings.value.length > 0 || upcomingMeetings.value.length > 0
)

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

/** 最新纪要的日期：2026-10-22 21:19 */
const dayOf = (value?: string | null) => {
  if (!value) return '—'

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) return '—'

  const pad = (n: number) => String(n).padStart(2, '0')

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 文号：与登记簿一致，用会议 ID 补三位 */
const refNo = (id: number) => String(id).padStart(3, '0')

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

/** 状态 → .m-status 的修饰词，颜色统一在 style.css 里 */
const getPinnedStatusKey = (meeting: MeetingRecord) => {
  switch (meeting.completionStatus) {
    case 'COMPLETED':
      return 'done'
    case 'IN_PROGRESS':
      return 'live'
    case 'CANCELLED':
      return 'cancel'
    default:
      return 'wait'
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

    // 底部放一份最新纪要：首页也要能看到纪要本身，而不只是入口
    const recentPage = await getMeetingsPage({ pageSize: 1 })

    latest.value = recentPage.items.length
      ? await getMeeting(recentPage.items[0].id)
      : null
  } catch (error) {
    // 提醒区属于辅助信息，加载失败不应打断首页
    console.error('会议提醒加载失败：', error)
    pinnedMeetings.value = []
    upcomingMeetings.value = []
  }
}

onMounted(loadMeetings)

/** 四个入口，对应顶部导航的四个功能 */
const entries = [
  {
    key: 'minutes',
    no: '一',
    title: '智能纪要',
    desc: '输入或实时转写会议内容，交给 AI 生成摘要、决策与待办',
    path: '/minutes'
  },
  {
    key: 'dashboard',
    no: '二',
    title: '数据看板',
    desc: '查看会议、待办与决策的整体统计和完成情况',
    path: '/dashboard'
  },
  {
    key: 'history',
    no: '三',
    title: '历史会议',
    desc: '检索、置顶、修改状态，回听录音与核对纪要',
    path: '/history'
  },
  {
    key: 'drafts',
    no: '四',
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
  <div class="page">
    <div class="page-inner">
      <header class="page-head">
        <div>
          <h1>会议室</h1>

          <p class="page-desc">
            {{ user?.name }}，欢迎回来。开会就记，散会成卷。
          </p>
        </div>

        <div class="page-head-actions">
          <el-button @click="go('/minutes')">
            预约会议
          </el-button>

          <el-button type="primary" @click="go('/minutes/instant')">
            开始临时会议
          </el-button>
        </div>
      </header>

      <div class="home-grid">
        <!-- 左：四个入口，按行排，不做等大卡片 -->
        <section class="sheet entries">
          <div class="entries-head">
            <span class="sec-t">去哪儿</span>
            <span class="sec-x">按日常使用频率排的</span>
          </div>

          <button
            v-for="entry in entries"
            :key="entry.key"
            type="button"
            class="entry-row"
            @click="go(entry.path)"
          >
            <span class="entry-no">{{ entry.no }}</span>

            <span class="entry-main">
              <span class="entry-name">{{ entry.title }}</span>
              <span class="entry-desc">{{ entry.desc }}</span>
            </span>

            <span class="entry-go">进入</span>
          </button>
        </section>

        <!-- 右：置顶与未开始，作为今天的提示 -->
        <aside class="side">
          <section v-if="visiblePinned.length" class="sheet side-block">
            <div class="side-head">
              <span class="sec-t">置顶</span>
              <span class="sec-x">{{ pinnedMeetings.length }}</span>
            </div>

            <ul class="side-list">
              <li
                v-for="meeting in visiblePinned"
                :key="meeting.id"
                class="side-row"
                :title="meeting.title"
                @click="go(`/history/${meeting.id}`)"
              >
                <span class="side-title">
                  {{ meeting.title || `会议 #${meeting.id}` }}
                </span>

                <span class="m-status" :class="`m-status--${getPinnedStatusKey(meeting)}`">
                  <i class="m-status-dot" />

                  {{ getPinnedStatusText(meeting) }}
                </span>
              </li>
            </ul>

            <p v-if="hiddenPinnedCount > 0" class="side-more">
              还有 {{ hiddenPinnedCount }} 场置顶会议
            </p>
          </section>

          <section v-if="visibleUpcoming.length" class="sheet side-block">
            <div class="side-head">
              <span class="sec-t">未开始</span>
              <span class="sec-x">{{ upcomingMeetings.length }}</span>
            </div>

            <ul class="side-list">
              <li
                v-for="meeting in visibleUpcoming"
                :key="meeting.id"
                class="side-row"
                :title="meeting.title"
                @click="go(`/history/${meeting.id}`)"
              >
                <span class="side-title">
                  {{ meeting.title || `会议 #${meeting.id}` }}
                </span>

                <span class="side-when">
                  <span class="num side-time">{{ formatScheduled(meeting.scheduledAt) }}</span>
                  <span class="side-count">{{ formatCountdown(meeting.scheduledAt) }}</span>
                </span>
              </li>
            </ul>

            <p v-if="hiddenUpcomingCount > 0" class="side-more">
              还有 {{ hiddenUpcomingCount }} 场未开始
            </p>
          </section>

          <p v-if="!hasNotice" class="side-note sheet">
            今天没有置顶或待开始的会议。<br />
            开会之前，可以先预约一场，参会人会收到提醒。
          </p>
        </aside>
      </div>

      <!-- 最新一份纪要：让入口页也能看到纪要本身 -->
      <section v-if="latest" class="sheet latest">
        <div class="latest-head">
          <span class="sec-t">最新纪要</span>

          <span class="sec-x num">MM-{{ refNo(latest.id) }}</span>

          <span v-if="latest.completionStatus === 'COMPLETED'" class="stamp">已归档</span>
        </div>

        <div class="latest-body">
          <div class="latest-main">
            <h2 class="latest-title">
              {{ latest.title || `会议 #${latest.id}` }}
            </h2>

            <p class="prose latest-summary">
              {{ latest.summary || '这份纪要还没有摘要。' }}
            </p>
          </div>

          <div class="latest-side">
            <div class="latest-kv">
              <span>记录于</span>
              <b class="num">{{ dayOf(latest.createdAt) }}</b>
            </div>

            <div class="latest-kv">
              <span>核心决策</span>
              <b class="num">{{ latest.decisions?.length ?? 0 }} 条</b>
            </div>

            <div class="latest-kv">
              <span>待办</span>
              <b class="num">{{ latest.todos?.length ?? 0 }} 项</b>
            </div>

            <el-button class="latest-open" @click="go(`/history/${latest.id}`)">
              打开纪要
            </el-button>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.home-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 330px;
  gap: 18px;
  align-items: start;
}

/* ---------- 左：入口 ---------- */
.entries {
  padding: 20px 26px 8px;
}

.entries-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--rule);
}

.entries-head .sec-x {
  margin-left: auto;
}

.entry-row {
  display: flex;
  align-items: baseline;
  gap: 16px;

  width: 100%;
  padding: 15px 6px 15px 2px;

  background: transparent;
  border: none;
  border-bottom: 1px solid var(--rule-soft);

  text-align: left;
  cursor: pointer;
  font-family: inherit;
  transition: background-color 0.16s;
}

.entry-row:last-of-type {
  border-bottom: none;
}

.entry-row:hover {
  background: var(--paper-2);
}

.entry-no {
  flex-shrink: 0;
  width: 18px;

  font-family: var(--song);
  font-size: 13px;
  color: var(--brand);
}

.entry-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.entry-name {
  font-family: var(--song);
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--ink);
}

.entry-desc {
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--ink-2);
}

.entry-go {
  margin-left: auto;
  flex-shrink: 0;
  align-self: center;

  font-size: 11.5px;
  color: var(--ink-3);

  border-bottom: 1px solid transparent;
  transition: color 0.16s, border-color 0.16s;
}

.entry-row:hover .entry-go {
  color: var(--ink);
  border-bottom-color: var(--ink);
}

/* ---------- 右：提示 ---------- */
.side {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.side-block {
  padding: 16px 18px 12px;
}

.side-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--rule);
}

.side-head .sec-x {
  margin-left: auto;
}

.side-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.side-row {
  display: flex;
  align-items: center;
  gap: 10px;

  padding: 9px 4px;
  margin: 0 -4px;
  border-bottom: 1px solid var(--rule-soft);

  cursor: pointer;
  transition: background-color 0.16s;
}

.side-row:last-child {
  border-bottom: none;
}

.side-row:hover {
  background: var(--paper-2);
}

.side-title {
  flex: 1;
  min-width: 0;

  font-size: 12.5px;
  color: var(--ink);

  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.side-when {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  flex-shrink: 0;
}

.side-time {
  font-size: 10.5px;
  color: var(--ink-3);
}

.side-count {
  font-size: 10.5px;
  color: var(--vermilion);
}

.side-more {
  margin-top: 8px;
  font-size: 11px;
  color: var(--ink-3);
}

.side-note {
  padding: 18px;
  font-size: 12px;
  line-height: 1.9;
  color: var(--ink-3);
}

/* ---------- 最新纪要 ---------- */
.latest {
  margin-top: 18px;
  padding: 20px 26px 22px;
}

.latest-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--rule);
}

.latest-head .sec-x {
  margin-left: auto;
}

.latest-head .stamp {
  margin-left: 4px;
  font-size: 11.5px;
}

.latest-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 210px;
  gap: 30px;
  margin-top: 18px;
}

.latest-title {
  font-size: 21px;
  letter-spacing: 0.05em;
  line-height: 1.4;
}

.latest-summary {
  margin-top: 10px;

  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.latest-side {
  display: flex;
  flex-direction: column;
  gap: 9px;

  padding-left: 22px;
  border-left: 1px solid var(--rule-soft);
}

.latest-kv {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;

  font-size: 11.5px;
  color: var(--ink-3);
}

.latest-kv b {
  font-weight: 400;
  font-size: 12px;
  color: var(--ink);
}

.latest-open {
  margin-top: auto;
  width: 100%;
}

@media (max-width: 980px) {
  .latest-body {
    grid-template-columns: minmax(0, 1fr);
    gap: 18px;
  }

  .latest-side {
    padding-left: 0;
    padding-top: 16px;
    border-left: none;
    border-top: 1px solid var(--rule-soft);
  }

  .latest-open {
    margin-top: 6px;
  }
}

@media (max-width: 980px) {
  .home-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 640px) {
  .page {
    padding: 22px 14px 48px;
  }

  .page-head {
    flex-direction: column;
    align-items: flex-start;
    gap: 14px;
  }

  .page-head-actions {
    margin-left: 0;
  }

  .page-head-actions .el-button {
    margin-left: 0;
  }

  .entries {
    padding: 16px 16px 6px;
  }

  .entry-row {
    align-items: flex-start;
  }

  .entry-go {
    display: none;
  }
}
</style>
