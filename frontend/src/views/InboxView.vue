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
    case 'reminder': {
      const when = item.scheduledAt ? formatTime(item.scheduledAt) : ''

      return `「${item.meetingTitle}」${when} 开始，请准时参加`
    }
    case 'leader':
      return `你被添加为「${item.meetingTitle}」的负责人`
    case 'member':
      return `你被添加为「${item.meetingTitle}」的成员`
    default:
      return `${item.actorName ?? '有人'} 把「${item.meetingTitle}」共享给你（${item.permission === 'EDIT' ? '可编辑' : '只读'}）`
  }
}

/** 通知图标 */
const notificationIcon = (item: InboxNotification) => {
  switch (item.type) {
    case 'reminder':
      return '⏰'
    case 'leader':
      return '👑'
    case 'member':
      return '👥'
    default:
      return '🔗'
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
  <div class="inbox-page">
    <div class="page-container">
      <div class="page-header">
        <div>
          <h1>收件箱</h1>
          <p>与你相关的会议通知与待办提醒</p>
        </div>

        <el-button :loading="loading" @click="load">
          刷新
        </el-button>
      </div>

      <el-card class="inbox-card" shadow="never">
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
              <el-button link type="primary" :loading="markingRead" :disabled="unreadCount === 0"
                @click="handleMarkRead">
                全部标记已读
              </el-button>
            </div>

            <el-empty v-if="!loading && notificationCount === 0" description="暂无通知" :image-size="70" />

            <ul v-else class="notice-list">
              <li v-for="item in data.notifications" :key="item.key"
                :class="['notice-item', { unread: !item.read }]" @click="openNotification(item)">
                <span class="notice-icon">{{ notificationIcon(item) }}</span>

                <div class="notice-body">
                  <div class="notice-text">{{ notificationText(item) }}</div>
                  <div class="notice-time">{{ formatTime(item.createdAt) }}</div>
                </div>

                <span v-if="!item.read" class="dot" />

                <span class="notice-arrow">→</span>
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

            <el-empty v-if="!loading && todoCount === 0" description="没有需要跟进的待办" :image-size="70" />

            <ul v-else class="todo-list">
              <li v-for="item in data.todos" :key="item.id" class="todo-item" @click="openMeeting(item.meetingId)">
                <div class="todo-main">
                  <div class="todo-content">{{ item.content }}</div>

                  <div class="todo-meta">
                    <span>{{ item.meetingTitle }}</span>
                    <span>·</span>
                    <span>{{ item.assignee || '未指定负责人' }}</span>
                    <span v-if="item.deadline">·截止 {{ item.deadline }}</span>
                  </div>
                </div>

                <el-tag v-if="item.mine" type="warning" size="small">
                  指派给我
                </el-tag>

                <el-tag v-else type="info" size="small">
                  我负责的会议
                </el-tag>

                <el-tag :type="item.status === 'IN_PROGRESS' ? 'warning' : 'info'" size="small" effect="plain">
                  {{ item.status === 'IN_PROGRESS' ? '进行中' : '待处理' }}
                </el-tag>
              </li>
            </ul>
          </el-tab-pane>
        </el-tabs>
      </el-card>
    </div>
  </div>
</template>

<style scoped>
.inbox-page {
  min-height: 100%;
  background: #f5f7fa;
  padding: 40px 20px 60px;
}

.page-container {
  max-width: 900px;
  margin: 0 auto;
}

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
}

.page-header h1 {
  margin: 0 0 6px;
  font-size: 30px;
  font-weight: 600;
  color: #303133;
}

.page-header p {
  margin: 0;
  color: #909399;
  font-size: 14px;
}

.inbox-card {
  border-radius: 12px;
}

.tab-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.tab-badge {
  min-width: 18px;
  height: 18px;
  padding: 0 5px;

  display: inline-flex;
  align-items: center;
  justify-content: center;

  border-radius: 9px;
  background: #f56c6c;
  color: #ffffff;

  font-size: 11px;
  font-weight: 600;
}

.tab-total {
  color: #c0c4cc;
  font-size: 12px;
}

.tab-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 6px;
}

.notice-list,
.todo-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.notice-item {
  display: flex;
  align-items: center;
  gap: 12px;

  padding: 12px 8px;
  border-bottom: 1px solid #f5f7fa;
  cursor: pointer;

  transition: background 0.15s;
}

.notice-item:last-child {
  border-bottom: none;
}

.notice-item:hover {
  background: #fafcff;
}

.notice-item.unread .notice-text {
  font-weight: 600;
}

.notice-icon {
  width: 28px;
  height: 28px;
  flex-shrink: 0;

  display: flex;
  align-items: center;
  justify-content: center;

  border-radius: 50%;
  background: #f0f7ff;
  font-size: 14px;
}

.notice-body {
  flex: 1;
  min-width: 0;
}

.notice-text {
  color: #303133;
  font-size: 14px;
  margin-bottom: 3px;
}

.notice-time {
  color: #c0c4cc;
  font-size: 12px;
}

.dot {
  width: 7px;
  height: 7px;
  flex-shrink: 0;
  border-radius: 50%;
  background: #f56c6c;
}

.notice-arrow {
  flex-shrink: 0;
  color: #c0c4cc;
  font-size: 13px;
}

.todo-item {
  display: flex;
  align-items: center;
  gap: 10px;

  padding: 12px 8px;
  border-bottom: 1px solid #f5f7fa;
  cursor: pointer;

  transition: background 0.15s;
}

.todo-item:last-child {
  border-bottom: none;
}

.todo-item:hover {
  background: #fafcff;
}

.todo-main {
  flex: 1;
  min-width: 0;
}

.todo-content {
  color: #303133;
  font-size: 14px;
  margin-bottom: 4px;
}

.todo-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  color: #909399;
  font-size: 12px;
}
</style>
