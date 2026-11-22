<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  getInbox,
  markInboxRead,
  type InboxData,
  type InboxNotification,
  type InboxUnclaimed
} from '../api/inbox'
import { claimTodo } from '../api/meeting'
import { useInboxStore } from '../composables/inboxStore'
import UserProfileDialog from '../components/UserProfileDialog.vue'
import InboxTodoDrawer from '../components/InboxTodoDrawer.vue'

const router = useRouter()

/** 个人主页名片：点提交人打开 */
const profileVisible = ref(false)
const profileUserId = ref<number | null>(null)

const openProfile = (userId?: number | null) => {
  if (!userId) return

  profileUserId.value = userId
  profileVisible.value = true
}
const inboxStore = useInboxStore()

const loading = ref(false)
const data = ref<InboxData>({ notifications: [], todos: [], unreadCount: 0, seenAt: null })

/** 当前标签页：通知 / 待办 / 验收 */
const activeTab = ref<'notifications' | 'todos' | 'reviews'>('notifications')

const unreadCount = computed(() => data.value.unreadCount)
const notificationCount = computed(() => data.value.notifications.length)
const todoCount = computed(() => data.value.todos.length)
const unclaimedCount = computed(() => data.value.unclaimed?.length ?? 0)
const reviewCount = computed(() => data.value.reviews?.length ?? 0)
const rejectedCount = computed(() => data.value.rejected?.length ?? 0)
const reviewTotal = computed(() => reviewCount.value + rejectedCount.value)

const load = async () => {
  loading.value = true

  try {
    data.value = await getInbox()

    inboxStore.setUnreadCount(data.value.unreadCount)
  } catch (error: any) {
    const message = error?.response?.data?.message ?? '收件箱加载失败'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  } finally {
    loading.value = false
  }
}

/** 标记全部通知已读 */
const markingRead = ref(false)

const handleMarkRead = async () => {
  if (!unreadCount.value) return

  markingRead.value = true

  try {
    await markInboxRead()

    data.value.notifications = data.value.notifications.map((n) => ({ ...n, read: true }))
    data.value.unreadCount = 0
    data.value.seenAt = new Date().toISOString()

    inboxStore.setUnreadCount(0)

    ElMessage.success('已全部标记为已读')
  } catch (error: any) {
    const message = error?.response?.data?.message ?? '操作失败'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  } finally {
    markingRead.value = false
  }
}

/** 通知文案 */
const notificationText = (item: InboxNotification) => {
  switch (item.type) {
    case 'notice':
      // 消息正文由后端按收件人视角生成，直接展示
      return item.content ?? `「${item.meetingTitle}」有新的会议消息`
    case 'leader':
      return `你被添加为「${item.meetingTitle}」的负责人`
    case 'member':
      return `你被添加为「${item.meetingTitle}」的成员`
    default:
      return `${item.actorName ?? '有人'} 把「${item.meetingTitle}」共享给你（${item.permission === 'EDIT' ? '可编辑' : '只读'}）`
  }
}

const formatTime = (value: string) => {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) return value

  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

const openMeeting = (meetingId: number) => {
  router.push(`/history/${meetingId}`)
}

/**
 * 点击通知：先把它标为已读（红点消失、未读数减一），再进入会议。
 *
 * 用本地更新而非整页刷新，保证点击后返回收件箱时状态已经是新的；
 * 同时同步侧边栏角标。
 */
const openNotification = async (item: InboxNotification) => {
  if (!item.read) {
    // 先本地更新，避免等待请求导致的视觉延迟
    const target = data.value.notifications.find((n) => n.key === item.key)

    if (target) {
      target.read = true
    }

    const nextUnread = Math.max(0, data.value.unreadCount - 1)

    data.value.unreadCount = nextUnread
    inboxStore.setUnreadCount(nextUnread)

    try {
      const result = await markInboxRead([item.key])

      // 以服务端结果为准，防止多处点击造成计数漂移
      data.value.unreadCount = result.unreadCount
      inboxStore.setUnreadCount(result.unreadCount)
    } catch {
      // 标记失败时回滚本地状态
      if (target) {
        target.read = false
      }

      data.value.unreadCount = nextUnread + 1
      inboxStore.setUnreadCount(nextUnread + 1)
    }
  }

  openMeeting(item.meetingId)
}

onMounted(load)

/* ---------- 待办抽屉：把「看」和「做」放在一起 ---------- */

const drawerVisible = ref(false)
const drawerTodoId = ref<number | null>(null)
const drawerMeetingId = ref<number | null>(null)

/**
 * 点待办行打开抽屉，而不是直接跳会议详情。
 *
 * 跳转会把「看一眼这条要干什么」变成「离开收件箱、在新页面重新定位」，
 * 五条待办就是五次来回。抽屉里能直接提交、验收、打回、改期。
 */
const openTodoDrawer = (meetingId: number, todoId: number) => {
  drawerMeetingId.value = meetingId
  drawerTodoId.value = todoId
  drawerVisible.value = true
}

/** 抽屉里操作成功后，收件箱要重算（该走的条目会消失） */
const handleDrawerChanged = async () => {
  await load()
}

const handleDrawerOpenMeeting = (meetingId: number) => {
  router.push(`/history/${meetingId}`)
}

/* ---------- 待认领 ---------- */

const claimingId = ref<number | null>(null)

/**
 * 认领。
 *
 * 先到先得：别人抢先一步时后端返回 409，这里刷新列表让那条从池子里消失，
 * 而不是停在原地让用户反复点。
 */
const handleClaim = async (item: InboxUnclaimed) => {
  if (claimingId.value) return

  claimingId.value = item.id

  try {
    await claimTodo(item.id)

    ElMessage.success('已认领，现在可以提交交付了')
    await load()
  } catch (error: any) {
    const message = error?.response?.data?.message ?? '认领失败，请重试'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)

    await load()
  } finally {
    claimingId.value = null
  }
}
</script>

<template>
  <div class="page">
    <div class="page-inner">
      <header class="page-head">
        <div>
          <h1>收件箱</h1>

          <p class="page-desc">
            与你相关的会议通知与待办提醒。读完即存档。
          </p>
        </div>

        <div class="page-head-actions">
          <el-button :loading="loading" @click="load">
            刷新
          </el-button>
        </div>
      </header>

      <section class="sheet inbox">
        <el-tabs v-model="activeTab">
          <!-- 通知 -->
          <el-tab-pane name="notifications">
            <template #label>
              <span class="tab-label">
                通知
                <span v-if="unreadCount > 0" class="tab-badge">{{ unreadCount }}</span>
                <span v-else-if="notificationCount > 0" class="tab-total">{{ notificationCount }}</span>
              </span>
            </template>

            <div v-if="notificationCount > 0" class="tab-toolbar">
              <span class="tab-tip">
                未读 {{ unreadCount }} 条
              </span>

              <el-button link type="primary" :loading="markingRead" :disabled="unreadCount === 0"
                @click="handleMarkRead">
                全部标记已读
              </el-button>
            </div>

            <el-empty v-if="!loading && notificationCount === 0" description="暂无通知" />

            <ul v-else class="notice-list">
              <li v-for="item in data.notifications" :key="item.key" :class="['notice-row', { unread: !item.read }]"
                @click="openNotification(item)">
                <span class="notice-flag" />

                <div class="notice-body">
                  <p class="notice-text">
                    {{ notificationText(item) }}
                  </p>

                  <span class="notice-time num">{{ formatTime(item.createdAt) }}</span>
                </div>
              </li>
            </ul>
          </el-tab-pane>

          <!-- 待办 -->
          <el-tab-pane name="todos">
            <template #label>
              <span class="tab-label">
                待办
                <span v-if="todoCount + unclaimedCount > 0" class="tab-total">{{ todoCount + unclaimedCount }}</span>
              </span>
            </template>

            <el-empty v-if="!loading && todoCount === 0 && unclaimedCount === 0" description="没有需要跟进的待办" />

            <template v-else>
              <!-- 待认领：AI 没认出负责人，或会上没点谁做 -->
              <div v-if="unclaimedCount > 0" class="review-group">
                <p class="review-title">
                  待认领
                  <span class="group-hint">没指定负责人，谁认谁做</span>
                </p>

                <ul class="todo-list">
                  <li v-for="item in data.unclaimed" :key="`unclaimed-${item.id}`" class="todo-row">
                    <div class="todo-main">
                      <p class="todo-content">
                        {{ item.content }}
                      </p>

                      <div class="todo-meta">
                        <span class="todo-meeting">{{ item.meetingTitle }}</span>
                        <span v-if="item.assigneeHint" class="todo-who">
                          原文写「{{ item.assigneeHint }}」
                        </span>
                        <span v-if="item.deadline" class="num todo-when">截止 {{ item.deadline }}</span>
                        <span v-if="item.overdue" class="overdue-pill">逾期</span>
                      </div>
                    </div>

                    <el-button size="small" type="primary" plain :loading="claimingId === item.id"
                      @click.stop="handleClaim(item)">
                      我来负责
                    </el-button>
                  </li>
                </ul>
              </div>

              <ul v-if="todoCount > 0" class="todo-list">
              <li v-for="item in data.todos" :key="item.id" class="todo-row"
                @click="openTodoDrawer(item.meetingId, item.id)">
                <div class="todo-main">
                  <p class="todo-content">
                    {{ item.content }}
                  </p>

                  <div class="todo-meta">
                    <span class="todo-meeting">{{ item.meetingTitle }}</span>
                    <span class="todo-who">{{ item.assignee || '未指定负责人' }}</span>
                    <span v-if="item.deadline" class="num todo-when">截止 {{ item.deadline }}</span>
                    <span v-if="item.overdue" class="overdue-pill">逾期</span>
                  </div>
                </div>

                <span v-if="item.mine" class="todo-flag">指派给我</span>

                <span v-else class="todo-flag todo-flag-quiet">我负责的会议</span>

                <el-tag :type="item.status === 'IN_PROGRESS' ? 'warning' : 'info'" size="small">
                  {{ item.status === 'IN_PROGRESS' ? '进行中' : '待处理' }}
                </el-tag>

                <button type="button" class="row-go" title="在会议中查看"
                  @click.stop="openMeeting(item.meetingId)">
                  会议
                </button>
              </li>
              </ul>
            </template>
          </el-tab-pane>

          <!-- 验收：待我验收 + 被打回 -->
          <el-tab-pane name="reviews">
            <template #label>
              <span class="tab-label">
                验收
                <span v-if="reviewTotal > 0" class="tab-badge">{{ reviewTotal }}</span>
              </span>
            </template>

            <el-empty v-if="!loading && reviewTotal === 0" description="没有待验收或被打回的交付" />

            <template v-else>
              <div v-if="reviewCount > 0" class="review-group">
                <p class="review-title">待我验收</p>

                <ul class="todo-list">
                  <li v-for="item in data.reviews" :key="`review-${item.submissionId}`" class="todo-row"
                    @click="openTodoDrawer(item.meetingId, item.todoId)">
                    <div class="todo-main">
                      <p class="todo-content">
                        {{ item.todoContent }}
                      </p>

                      <!-- 交付说明：验收人不用点开就能判断该不该通过 -->
                      <p v-if="item.note" class="todo-note">{{ item.note }}</p>

                      <div class="todo-meta">
                        <span class="todo-meeting">{{ item.meetingTitle }}</span>
                        <span class="todo-who">
                          <button type="button" class="name-link" @click.stop="openProfile(item.submitterId)">
                            {{ item.submitterName }}
                          </button>
                          提交 · 第 {{ item.attemptNo }} 次
                        </span>
                        <span v-if="item.attachmentCount" class="todo-chip">
                          附件 {{ item.attachmentCount }}
                        </span>
                        <span v-if="item.checklistTotal" class="todo-chip">
                          要点 {{ item.checklistDone }}/{{ item.checklistTotal }}
                        </span>
                        <span v-if="item.overdue" class="overdue-pill">逾期</span>
                        <span class="num todo-when">{{ formatTime(item.submittedAt) }}</span>
                      </div>
                    </div>

                    <el-tag type="warning" size="small">待验收</el-tag>

                    <button type="button" class="row-go" title="在会议中查看"
                      @click.stop="openMeeting(item.meetingId)">
                      会议
                    </button>
                  </li>
                </ul>
              </div>

              <div v-if="rejectedCount > 0" class="review-group">
                <p class="review-title">需重新提交</p>

                <ul class="todo-list">
                  <li v-for="item in data.rejected" :key="`rejected-${item.submissionId}`" class="todo-row"
                    @click="openTodoDrawer(item.meetingId, item.todoId)">
                    <div class="todo-main">
                      <p class="todo-content">
                        {{ item.todoContent }}
                      </p>

                      <p v-if="item.rejectReason" class="review-reason">
                        打回原因：{{ item.rejectReason }}
                      </p>

                      <div class="todo-meta">
                        <span class="todo-meeting">{{ item.meetingTitle }}</span>
                        <span class="num todo-when">{{ formatTime(item.submittedAt) }}</span>
                      </div>
                    </div>

                    <el-tag type="danger" size="small" effect="plain">被打回</el-tag>

                    <button type="button" class="row-go" title="在会议中查看"
                      @click.stop="openMeeting(item.meetingId)">
                      会议
                    </button>
                  </li>
                </ul>
              </div>
            </template>
          </el-tab-pane>
        </el-tabs>
      </section>
    </div>

    <!-- 个人主页：点提交人打开 -->
    <UserProfileDialog v-model="profileVisible" :user-id="profileUserId" />

    <!-- 待办处理抽屉：提交 / 验收 / 打回 / 改期 / 改派 -->
    <InboxTodoDrawer v-model="drawerVisible" :todo-id="drawerTodoId" :meeting-id="drawerMeetingId"
      @changed="handleDrawerChanged" @open-meeting="handleDrawerOpenMeeting" />
  </div>
</template>

<style scoped>
.inbox {
  padding: 4px 22px 18px;
}

/* 可点击人名：与会议详情页同一套视觉 */
.name-link {
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  color: inherit;
  cursor: pointer;
  text-decoration: underline dotted var(--rule);
  text-underline-offset: 3px;
  transition: color 0.15s, text-decoration-color 0.15s;
}

.name-link:hover {
  color: var(--brand);
  text-decoration-color: var(--brand);
}

.name-link:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 2px;
  border-radius: 2px;
}

.tab-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.tab-badge {
  min-width: 16px;
  padding: 0 4px;
  line-height: 15px;

  font-family: var(--num);
  font-size: 10px;
  text-align: center;

  color: var(--vermilion);
  border: 1px solid currentColor;
}

.tab-total {
  font-family: var(--num);
  font-size: 10.5px;
  color: var(--ink-3);
}

.tab-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 2px 6px;
  border-bottom: 1px solid var(--rule-soft);
}

.tab-tip {
  flex: 1;
  font-size: 11.5px;
  color: var(--ink-3);
}

/* ---------- 通知 ---------- */
.notice-list,
.todo-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.notice-row {
  display: flex;
  gap: 12px;
  padding: 14px 4px;
  border-bottom: 1px solid var(--rule-soft);
  cursor: pointer;
  transition: background-color 0.16s;
}

.notice-row:last-child {
  border-bottom: none;
}

.notice-row:hover {
  background: var(--paper-2);
}

.notice-flag {
  flex-shrink: 0;
  width: 3px;
  height: 15px;
  margin-top: 3px;
  background: var(--rule);
}

.notice-row.unread .notice-flag {
  background: var(--vermilion);
}

.notice-body {
  min-width: 0;
}

.notice-text {
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--ink-2);
}

.notice-row.unread .notice-text {
  color: var(--ink);
  font-weight: 600;
}

.notice-time {
  display: block;
  margin-top: 4px;
  font-size: 10.5px;
  color: var(--ink-3);
}

/* ---------- 待办 ---------- */
.review-group {
  margin-top: 12px;
}

.review-title {
  margin: 0;
  padding: 8px 4px 4px;
  font-size: 11px;
  letter-spacing: 0.08em;
  color: var(--ink-3);
}

/** 分组标题后的一句说明，用来解释「待认领」到底是什么意思 */
.group-hint {
  margin-left: 6px;
  letter-spacing: 0;
  font-size: 10.5px;
  color: var(--ink-3);
  opacity: 0.75;
}

.review-reason {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: #a33;
}

/** 交付说明摘要：验收人在列表里就能判断该不该点开 */
.todo-note {
  margin: 5px 0 0;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;

  font-size: 12px;
  line-height: 1.65;
  color: var(--ink-3);
}

/** 附件数 / 要点进度这类小标记 */
.todo-chip {
  padding: 0 5px;
  border: 1px solid var(--rule-soft);
  border-radius: 3px;

  font-size: 10.5px;
  line-height: 15px;
  color: var(--ink-3);
}

/** 「去会议」次要入口：行内默认隐藏，hover 才出现，避免和主点击抢注意力 */
.row-go {
  flex-shrink: 0;
  padding: 2px 7px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;

  font-size: 10.5px;
  color: var(--ink-3);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.16s, color 0.16s, border-color 0.16s;
}

.todo-row:hover .row-go {
  opacity: 1;
}

.row-go:hover {
  border-color: var(--brand-line);
  background: var(--brand-wash);
  color: var(--brand);
}

/** 触屏没有 hover，常显 */
@media (hover: none) {
  .row-go {
    opacity: 1;
  }
}

.overdue-pill {
  padding: 0 4px;
  font-size: 10px;
  line-height: 14px;
  color: #a33;
  border: 1px solid currentColor;
}

.todo-row {
  display: flex;
  align-items: center;
  gap: 14px;

  padding: 13px 4px;
  border-bottom: 1px solid var(--rule-soft);
  cursor: pointer;
  transition: background-color 0.16s;
}

.todo-row:last-child {
  border-bottom: none;
}

.todo-row:hover {
  background: var(--paper-2);
}

.todo-main {
  flex: 1;
  min-width: 0;
}

.todo-content {
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--ink);
}

.todo-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  margin-top: 5px;
  font-size: 11px;
  color: var(--ink-3);
}

.todo-who {
  font-family: var(--song);
  font-size: 12px;
  letter-spacing: 0.03em;
}

.todo-when {
  font-size: 10.5px;
}

.todo-flag {
  flex-shrink: 0;
  padding: 1px 6px;

  font-size: 10.5px;
  color: var(--ochre-ink);
  background: var(--ochre-wash);
  border: 1px solid var(--ochre-line);
}

.todo-flag-quiet {
  color: var(--ink-2);
  background: var(--paper-2);
  border-color: var(--rule);
}

@media (max-width: 640px) {
  .page {
    padding: 22px 14px 48px;
  }

  .inbox {
    padding: 4px 14px 14px;
  }

  .todo-row {
    flex-wrap: wrap;
  }

  .todo-flag {
    order: 3;
    margin-left: 0;
  }
}
</style>
