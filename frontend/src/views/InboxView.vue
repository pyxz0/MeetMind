<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  getInbox,
  markInboxRead,
  type InboxData,
  type InboxNotification
} from '../api/inbox'
import { useInboxStore } from '../composables/inboxStore'

const router = useRouter()
const inboxStore = useInboxStore()

const loading = ref(false)
const data = ref<InboxData>({ notifications: [], todos: [], unreadCount: 0, seenAt: null })

/** 当前标签页：通知 / 待办 */
const activeTab = ref<'notifications' | 'todos'>('notifications')

const unreadCount = computed(() => data.value.unreadCount)
const notificationCount = computed(() => data.value.notifications.length)
const todoCount = computed(() => data.value.todos.length)

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
                <span v-if="todoCount > 0" class="tab-total">{{ todoCount }}</span>
              </span>
            </template>

            <el-empty v-if="!loading && todoCount === 0" description="没有需要跟进的待办" />

            <ul v-else class="todo-list">
              <li v-for="item in data.todos" :key="item.id" class="todo-row" @click="openMeeting(item.meetingId)">
                <div class="todo-main">
                  <p class="todo-content">
                    {{ item.content }}
                  </p>

                  <div class="todo-meta">
                    <span class="todo-meeting">{{ item.meetingTitle }}</span>
                    <span class="todo-who">{{ item.assignee || '未指定负责人' }}</span>
                    <span v-if="item.deadline" class="num todo-when">截止 {{ item.deadline }}</span>
                  </div>
                </div>

                <span v-if="item.mine" class="todo-flag">指派给我</span>

                <span v-else class="todo-flag todo-flag-quiet">我负责的会议</span>

                <el-tag :type="item.status === 'IN_PROGRESS' ? 'warning' : 'info'" size="small">
                  {{ item.status === 'IN_PROGRESS' ? '进行中' : '待处理' }}
                </el-tag>
              </li>
            </ul>
          </el-tab-pane>
        </el-tabs>
      </section>
    </div>
  </div>
</template>

<style scoped>
.inbox {
  padding: 4px 22px 18px;
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
