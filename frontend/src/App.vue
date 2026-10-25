<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { provideDraftStore } from './composables/draftStore'
import { useInboxStore } from './composables/inboxStore'
import { useMessageStore } from './composables/messageStore'
import {
  recordingStatus,
  formatRecordingTime,
} from './composables/recordingStatus'
import { authStore } from './stores/auth'
import {
  getMeetingsPage,
  type MeetingRecord,
  type MeetingCompletionStatusValue,
} from './api/meeting'

const draftStore = provideDraftStore()
const inboxStore = useInboxStore()
const messageStore = useMessageStore()

const route = useRoute()
const router = useRouter()

/**
 * 登录页不渲染登记簿与内容框架。
 *
 * 用 route.meta.requiresAuth === false 判断，
 * 后续再加公开页面时无需改这里。
 */
const isPublicPage = computed(() => route.meta.requiresAuth === false)

const currentUser = computed(() => authStore.user)

/** 当前是否处于「以他人身份浏览」状态 */
const impersonation = computed(() => authStore.state.impersonation)

/** 后台录音时，在其他页面顶部提示，避免忘了还在录 */
const showRecordingTip = computed(
  () => recordingStatus.recording && route.path !== '/minutes/instant'
)

const backToRecording = async () => {
  await router.push('/minutes/instant')
}

/* =========================
   顶部导航
   ========================= */

const navItems = computed(() => [
  { path: '/minutes', label: '智能纪要', count: 0 },
  { path: '/dashboard', label: '数据看板', count: 0 },
  { path: '/history', label: '历史会议', count: 0 },
  { path: '/drafts', label: '草稿箱', count: draftStore.count },
  {
    path: '/inbox',
    label: '收件箱',
    count: inboxStore.unreadCount.value,
  },
  {
    path: '/messages',
    label: '私信',
    count: messageStore.unreadCount.value,
  },
])

/* =========================
   左侧登记簿：最近生成的几份纪要
   ========================= */

const recentMeetings = ref<MeetingRecord[]>([])
const recentTotal = ref(0)

/** 只取最新的几份，登记簿是索引不是列表页 */
const RECENT_LIMIT = 6

const loadRecent = async () => {
  if (!authStore.isAuthenticated.value) return

  try {
    const page = await getMeetingsPage({ pageSize: RECENT_LIMIT })

    recentMeetings.value = page.items.slice(0, RECENT_LIMIT)
    recentTotal.value = page.total ?? page.items.length
  } catch {
    // 登记簿属于辅助信息，拉取失败时留空，不打断页面
    recentMeetings.value = []
    recentTotal.value = 0
  }
}

/** 文号：用会议 ID 补足三位，像档案编号 */
const refNo = (id: number) => String(id).padStart(3, '0')

const toMonthDay = (value?: string | null) => {
  if (!value) return ''

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) return ''

  const pad = (n: number) => String(n).padStart(2, '0')

  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const dotClass = (status?: MeetingCompletionStatusValue | null) => {
  switch (status) {
    case 'COMPLETED':
      return 'dot-done'
    case 'IN_PROGRESS':
      return 'dot-live'
    case 'CANCELLED':
      return 'dot-cancel'
    default:
      return 'dot-wait'
  }
}

/** 返回自己的账号 */
const backToMyAccount = async () => {
  authStore.endImpersonation()

  ElMessage.success('已返回自己的账号')

  // 回到用户管理，方便继续处理其他账号
  await router.push('/users')
}

/** 用户名首字，作为登记簿与顶栏的头像 */
const initial = computed(() => currentUser.value?.name?.slice(0, 1) ?? '·')

const isProfile = computed(() => route.path === '/profile')

/** 当前打开的会议，用于登记簿高亮 */
const isActiveEntry = (id: number) => route.path === `/history/${id}`

onMounted(async () => {
  // 未登录时（登录页）不拉草稿数量与角标，避免无谓的 401
  if (authStore.isAuthenticated.value) {
    await Promise.all([draftStore.refresh(), inboxStore.refresh(), messageStore.refresh()])
    await loadRecent()
  }
})

/** 切换页面后同步登记簿：新生成的纪要要立刻出现在左侧 */
watch(
  () => route.fullPath,
  async (path) => {
    if (path !== '/login') {
      await loadRecent()
    }
  }
)
</script>

<template>
  <!-- 登录页：整页渲染，不带侧栏 -->
  <router-view v-if="isPublicPage" />

  <div v-else class="app">
    <div class="shell">
      <!-- 竖向侧栏：品牌 → 五个入口 → 最近登记 → 用户 -->
      <aside class="side">
        <router-link to="/" class="brand-row" aria-label="MeetMind 首页">
          <img class="brand-logo" src="/meetmind-logo.svg" alt="MeetMind" width="111" height="30" />
          <span class="brand-sub">AI 智能会议纪要</span>
        </router-link>

        <nav class="nav" aria-label="主导航">
          <router-link
            v-for="item in navItems"
            :key="item.path"
            :to="item.path"
            class="nav-item"
          >
            <span class="nav-label">{{ item.label }}</span>

            <span v-if="item.count > 0" class="nav-count">
              {{ item.count > 99 ? '99+' : item.count }}
            </span>
          </router-link>
        </nav>

        <!-- 登记簿：最近生成的纪要，点一行直接进详情 -->
        <div class="rail">
          <div class="rail-head">
            <span class="rail-title">最近登记</span>

            <router-link to="/history" class="rail-all">
              全部 {{ recentTotal }} 份
            </router-link>
          </div>

          <router-link
            v-for="meeting in recentMeetings"
            :key="meeting.id"
            :to="`/history/${meeting.id}`"
            class="entry"
            :class="{ 'entry-on': isActiveEntry(meeting.id) }"
            :title="meeting.title || `会议 #${meeting.id}`"
          >
            <span class="entry-meta">
              <span class="entry-no">{{ refNo(meeting.id) }}</span>
              <span class="entry-date">{{ toMonthDay(meeting.createdAt) }}</span>
              <i class="dot" :class="dotClass(meeting.completionStatus)" />
            </span>

            <span class="entry-title">
              {{ meeting.title || `会议 #${meeting.id}` }}
            </span>
          </router-link>

          <p v-if="!recentMeetings.length" class="rail-empty">
            还没有会议记录，去「智能纪要」开始第一场。
          </p>

          <div class="rail-foot">
            纪要带文号、时间码与印。<br />
            原文可回听，纪要只认这一份。
          </div>
        </div>

        <!-- 用户：侧栏底部，点进个人中心 -->
        <div class="side-foot">
          <router-link
            to="/profile"
            class="who"
            :class="{ 'who-on': isProfile }"
            :title="`${currentUser?.name} · ${currentUser?.roleLabel}`"
          >
            <span class="who-avatar">
  <img v-if="currentUser?.avatar" :src="currentUser.avatar" alt="" class="who-avatar-img" />
  <template v-else>{{ initial }}</template>
</span>

            <span class="who-meta">
              <b>{{ currentUser?.name }}</b>
              <i>{{ currentUser?.roleLabel }}</i>
            </span>
          </router-link>
        </div>
      </aside>

      <main class="main">
        <!-- 代登身份提示条：始终可见，避免误以为自己就是对方账号 -->
        <div v-if="impersonation" class="strip strip-impersonation">
          <span class="strip-text">
            正在以 <strong>{{ currentUser?.name }}</strong>
            （{{ currentUser?.phone }}）的身份浏览
          </span>

          <el-button size="small" @click="backToMyAccount">
            返回我的账号
          </el-button>
        </div>

        <!-- 后台录音提示：切到其他页面时仍能看到录音在进行 -->
        <div v-if="showRecordingTip" class="strip strip-recording">
          <span class="strip-dot" />

          <span class="strip-text">
            {{ recordingStatus.paused ? '会议录音已暂停' : '会议录音与转写进行中' }}
            <strong class="num">{{ formatRecordingTime(recordingStatus.seconds) }}</strong>
          </span>

          <el-button size="small" type="primary" @click="backToRecording">
            返回会议
          </el-button>
        </div>

        <router-view v-slot="{ Component }">
          <!--
            纪要页用 KeepAlive 缓存：切到其他页面时组件不卸载，
            SpeechRecognition 与 MediaRecorder 就能继续在后台录音转写，
            回到该页时计时与转写内容都保持原样。
          -->
          <keep-alive :include="['MinutesInstant']">
            <component :is="Component" />
          </keep-alive>
        </router-view>
      </main>
    </div>
  </div>
</template>

<style scoped>
.app {
  min-height: 100vh;
  background: var(--desk);
}

.shell {
  display: flex;
  align-items: stretch;
  min-height: 100vh;
}

/* ---------- 左侧竖栏 ---------- */

.side {
  width: 276px;
  flex-shrink: 0;

  position: sticky;
  top: 0;
  height: 100vh;

  display: flex;
  flex-direction: column;
  overflow: hidden;

  background: var(--paper);
  border-right: 1px solid var(--rule);
}

.brand-row {
  height: 64px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 20px;

  border-bottom: 1px solid var(--rule);
}

.brand-logo {
  display: block;
  height: 36px;
  width: auto;
  flex-shrink: 0;
}

.brand-sub {
  padding-left: 10px;
  border-left: 1px solid var(--rule);

  font-size: 10.5px;
  color: var(--ink-3);
  letter-spacing: 0.02em;
  white-space: nowrap;
}

/* ---------- 五个入口：竖向，靠左边墨线与字重区分当前页 ---------- */
.nav {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;

  padding: 10px 8px 12px;
  border-bottom: 1px solid var(--rule);
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;

  height: 36px;
  padding: 0 10px;

  border-left: 2px solid transparent;

  font-size: 13px;
  color: var(--ink-2);
  letter-spacing: 0.02em;

  transition: background-color 0.16s, color 0.16s, border-color 0.16s;
}

.nav-item:hover {
  color: var(--ink);
  background: var(--paper-2);
}

.nav-item.router-link-active {
  color: var(--brand-deep);
  font-weight: 600;
  background: var(--brand-soft);
  border-left-color: var(--brand);
}

.nav-label {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nav-count {
  margin-left: auto;
  flex-shrink: 0;

  font-family: var(--num);
  font-size: 10.5px;
  line-height: 1;
  padding: 2px 4px;

  color: var(--vermilion);
  border: 1px solid currentColor;
}

/* ---------- 登记簿 ---------- */
.rail {
  flex: 1;
  min-height: 0;
  overflow-y: auto;

  display: flex;
  flex-direction: column;
}

.rail-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;

  padding: 16px 20px 10px;
  border-bottom: 1px solid var(--rule-soft);
}

.rail-title {
  font-family: var(--song);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--ink);
}

.rail-all {
  font-size: 11px;
  color: var(--ink-3);
  white-space: nowrap;
}

.rail-all:hover {
  color: var(--brand-strong);
}

.entry {
  display: block;
  padding: 10px 20px 11px 18px;

  border-left: 2px solid transparent;
  border-bottom: 1px solid var(--rule-soft);

  transition: background-color 0.16s;
}

.entry:hover {
  background: var(--paper-2);
}

.entry-on {
  border-left-color: var(--brand);
  background: var(--brand-soft);
}

.entry-meta {
  display: flex;
  align-items: center;
  gap: 8px;

  font-family: var(--num);
  font-size: 10.5px;
  color: var(--ink-3);
  font-variant-numeric: tabular-nums;
}

.entry-no {
  letter-spacing: 0.04em;
}

.entry-title {
  display: block;
  margin-top: 4px;

  font-size: 12.5px;
  line-height: 1.45;
  color: var(--ink);

  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.dot {
  width: 5px;
  height: 5px;
  margin-left: auto;
  border-radius: 50%;
  background: var(--rule);
}

.dot-done {
  background: #7d8a7f;
}

.dot-live {
  background: var(--vermilion);
}

.dot-cancel {
  background: var(--ink-3);
}

.dot-wait {
  background: var(--rule);
}

.rail-empty {
  padding: 16px 20px;
  font-size: 11.5px;
  line-height: 1.8;
  color: var(--ink-3);
}

.rail-foot {
  margin-top: auto;
  padding: 14px 20px 16px;
  border-top: 1px solid var(--rule-soft);

  font-family: var(--fang);
  font-size: 11.5px;
  line-height: 1.9;
  color: var(--ink-3);
}

/* ---------- 用户 ---------- */
.side-foot {
  flex-shrink: 0;
  padding: 10px 8px;
  border-top: 1px solid var(--rule);
}

.who {
  display: flex;
  align-items: center;
  gap: 9px;

  padding: 6px 8px;
  border: 1px solid transparent;
}

.who:hover,
.who-on {
  border-color: var(--rule);
  background: var(--paper-2);
}

.who-avatar {
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  overflow: hidden;

  display: flex;
  align-items: center;
  justify-content: center;

  background: var(--ink);
  color: var(--on-ink);
  font-size: 12px;
  letter-spacing: 0;
}

.who-avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.who-meta {
  min-width: 0;
  display: flex;
  flex-direction: column;
  line-height: 1.25;
}

.who-meta b {
  font-size: 12px;
  font-weight: 600;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.who-meta i {
  font-size: 10.5px;
  font-style: normal;
  color: var(--ink-3);
}

/* ---------- 内容区 ---------- */
.main {
  flex: 1;
  min-width: 0;
}

.strip {
  position: sticky;
  top: 0;
  z-index: 50;

  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 22px;

  font-size: 12.5px;
  border-bottom: 1px solid var(--rule);
}

.strip-recording {
  background: var(--vermilion-wash);
  color: #7d2a22;
  border-bottom-color: var(--vermilion-line);
}

.strip-impersonation {
  background: var(--ochre-wash);
  color: var(--ochre-deep);
  border-bottom-color: var(--ochre-line);
}

.strip-text {
  flex: 1;
  min-width: 0;
}

.strip-text strong {
  font-weight: 600;
}

.strip-dot {
  width: 7px;
  height: 7px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--vermilion);
  animation: strip-pulse 1.6s ease-in-out infinite;
}

@keyframes strip-pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }

  50% {
    opacity: 0.4;
    transform: scale(0.82);
  }
}

/* ---------- 窄屏：竖栏折成顶部横条，登记簿收起 ---------- */
@media (max-width: 1080px) {
  .shell {
    flex-direction: column;
  }

  /* 顶栏折成横条后，提示条要贴在这条横条下面 */
  .strip {
    top: 57px;
  }


  .side {
    width: 100%;
    height: auto;
    position: sticky;
    top: 0;
    z-index: 60;

    flex-direction: row;
    align-items: center;
    overflow: visible;

    border-right: none;
    border-bottom: 1px solid var(--rule);
    padding-right: 6px;
  }

  .brand-row {
    height: 56px;
    padding: 0 14px;
    border-bottom: none;
  }

  .brand-logo {
    height: 26px;
  }

  .brand-sub {
    display: none;
  }

  .nav {
    flex: 1;
    min-width: 0;
    flex-direction: row;
    gap: 0;
    padding: 0;
    border-bottom: none;
    overflow-x: auto;
    scrollbar-width: none;

    /* 右侧渐隐，提示还能横向滚动 */
    -webkit-mask-image: linear-gradient(90deg, #000 92%, transparent 100%);
    mask-image: linear-gradient(90deg, #000 92%, transparent 100%);
  }

  .nav::-webkit-scrollbar {
    display: none;
  }

  .nav-item {
    height: 56px;
    padding: 0 10px;

    border-left: none;
    border-bottom: 2px solid transparent;

    font-size: 12.5px;
    white-space: nowrap;
  }

  .nav-item.router-link-active {
    background: transparent;
    border-bottom-color: var(--ink);
  }

  .rail {
    display: none;
  }

  .side-foot {
    flex-shrink: 0;
    padding: 0 4px;
    border-top: none;
  }

  .who {
    padding: 4px;
    border-color: transparent;
  }

  .who-meta {
    display: none;
  }
}

@media (max-width: 560px) {
  .brand-row {
    padding: 0 10px;
  }

  .brand-logo {
    height: 24px;
  }

  .nav-item {
    padding: 0 8px;
    font-size: 12px;
  }
}
</style>
