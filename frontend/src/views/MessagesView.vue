<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  listConversations,
  listMessages,
  openConversation,
  sendMessage,
  type ConversationSummary,
  type MessageView,
} from '../api/message'
import { listContacts, type Contact } from '../api/auth'
import { authStore } from '../stores/auth'
import { useMessageStore } from '../composables/messageStore'

const route = useRoute()
const router = useRouter()
const messageStore = useMessageStore()

const currentUser = computed(() => authStore.user)

const conversations = ref<ConversationSummary[]>([])
const contacts = ref<Contact[]>([])
const loading = ref(false)

/** 当前打开的会话 */
const activeConversationId = ref<number | null>(null)
const activePeer = ref<ConversationSummary | null>(null)
const messages = ref<MessageView[]>([])
const messagesLoading = ref(false)

/** 输入区 */
const draft = ref('')
const sending = ref(false)
const pendingFile = ref<File | null>(null)

/** 发起新会话弹窗 */
const newChatVisible = ref(false)
const newChatPeerId = ref<number | null>(null)
const newChatLoading = ref(false)

const messagesEnd = ref<HTMLElement | null>(null)

const scrollToBottom = async () => {
  await nextTick()
  messagesEnd.value?.scrollIntoView({ behavior: 'auto' })
}

/** 会话列表（已按后端排序） */
const loadConversations = async () => {
  loading.value = true

  try {
    conversations.value = await listConversations()
  } catch (error: any) {
    const message = error?.response?.data?.message ?? '会话列表加载失败'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  } finally {
    loading.value = false
  }
}

/** 打开某个会话：加载消息并推进已读 */
const openChat = async (conversationId: number) => {
  // 从「个人主页 → 发私信」进来时，新会话还不在列表里，先补齐再取对方信息
  if (!conversations.value.some((c) => c.id === conversationId)) {
    await loadConversations()
  }

  activeConversationId.value = conversationId
  activePeer.value = conversations.value.find((c) => c.id === conversationId) ?? null
  messages.value = []
  messagesLoading.value = true

  try {
    messages.value = await listMessages(conversationId)
    await scrollToBottom()

    // 拉取即已读：刷新会话列表（清未读角标）与导航角标
    await refreshUnread()
  } catch (error: any) {
    const message = error?.response?.data?.message ?? '消息加载失败'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  } finally {
    messagesLoading.value = false
  }
}

const refreshUnread = async () => {
  await loadConversations()
  await messageStore.refresh()
}

/** 发送文字消息 */
const handleSend = async () => {
  const text = draft.value.trim()

  if (!text && !pendingFile.value) {
    ElMessage.warning('请输入消息内容')
    return
  }

  if (!activeConversationId.value) return

  sending.value = true

  try {
    const file = pendingFile.value ?? undefined
    const kind = file ? (isImageFile(file) ? 'IMAGE' : 'FILE') : 'TEXT'

    const sent = await sendMessage(activeConversationId.value, {
      content: text || undefined,
      kind,
      file,
    })

    messages.value.push(sent)
    draft.value = ''
    pendingFile.value = null
    await scrollToBottom()
    await refreshUnread()
  } catch (error: any) {
    const message = error?.response?.data?.message ?? '发送失败'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  } finally {
    sending.value = false
  }
}

const isImageFile = (file: File) => file.type.startsWith('image/')

/** 选择文件（图片或普通文件） */
const onPickFile = (event: Event) => {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]

  if (!file) return

  if (file.size > 20 * 1024 * 1024) {
    ElMessage.warning('文件不能超过 20MB')
    input.value = ''
    return
  }

  pendingFile.value = file
  input.value = ''
}

const clearPendingFile = () => {
  pendingFile.value = null
}

/** 发起新会话 */
const openNewChat = () => {
  newChatPeerId.value = null
  newChatVisible.value = true

  if (!contacts.value.length) void loadContacts()
}

const loadContacts = async () => {
  try {
    contacts.value = (await listContacts()).filter(
      (c) => c.id !== currentUser.value?.id,
    )
  } catch {
    contacts.value = []
  }
}

const startNewChat = async () => {
  if (!newChatPeerId.value) {
    ElMessage.warning('请选择要聊天的同事')
    return
  }

  newChatLoading.value = true

  try {
    const { conversationId } = await openConversation(newChatPeerId.value)
    newChatVisible.value = false
    await loadConversations()
    await openChat(conversationId)
  } catch (error: any) {
    const message = error?.response?.data?.message ?? '发起会话失败'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  } finally {
    newChatLoading.value = false
  }
}

/** 时间格式化：今天只显时分，否则显月日时分 */
const formatTime = (iso: string) => {
  const date = new Date(iso)
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')

  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`

  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()

  return sameDay ? hm : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${hm}`
}

/** 会话列表的时间（简短） */
const shortTime = (iso: string) => {
  const date = new Date(iso)
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')

  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()

  return sameDay
    ? `${pad(date.getHours())}:${pad(date.getMinutes())}`
    : `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 头像首字 */
const peerInitial = (name?: string | null) => name?.slice(0, 1) ?? '·'

/** 文件名/大小 */
const formatSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 下载附件（带鉴权，直接走 window 打开） */
const downloadAttachment = (url: string, fileName: string) => {
  const base = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:3000/api'
  const token = localStorage.getItem('meetmind.token')

  // 用隐藏表单 + 链接的方式带 token 下载，避免 axios 处理二进制
  const link = document.createElement('a')
  link.href = `${base}${url}`
  link.download = fileName

  // 鉴权下载走 URL 无法带 Bearer，改为 fetch 拿到 blob
  void (async () => {
    try {
      const res = await fetch(`${base}${url}`, {
        headers: { Authorization: `Bearer ${token ?? ''}` },
      })

      if (!res.ok) throw new Error()

      const blob = await res.blob()
      const objectUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = fileName
      a.click()
      URL.revokeObjectURL(objectUrl)
    } catch {
      ElMessage.error('下载失败，请重试')
    }
  })()
}

/** 图片附件预览地址（同样带鉴权，用 fetch 转 blob 太重，这里直接内联显示） */
const imageSrc = (url: string) => {
  const base = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:3000/api'
  return `${base}${url}`
}

/** 从 URL 打开会话（支持 /messages/:id 直链） */
watch(
  () => route.params.id,
  async (id) => {
    if (id) {
      const conversationId = Number(id)

      if (!conversations.value.length) await loadConversations()
      await openChat(conversationId)
    }
  },
)

onMounted(async () => {
  await loadConversations()
  await messageStore.refresh()

  if (route.params.id) {
    await openChat(Number(route.params.id))
  }
})
</script>

<template>
  <div class="page messages-page">
    <div class="page-inner">
      <header class="page-head">
        <div>
          <h1>私信</h1>
          <p class="page-desc">一对一的站内聊天。文字、图片与文件都能发。</p>
        </div>

        <el-button type="primary" @click="openNewChat">
          发起会话
        </el-button>
      </header>

      <div class="chat-shell sheet">
        <!-- 左：会话列表 -->
        <aside class="chat-list" :class="{ 'chat-list--empty': !conversations.length }">
          <div v-loading="loading" class="chat-list-inner">
            <el-empty
              v-if="!loading && !conversations.length"
              description="还没有会话，点右上角「发起会话」"
              :image-size="80"
            />

            <button
              v-for="conv in conversations"
              :key="conv.id"
              type="button"
              class="conv-item"
              :class="{ 'conv-item--active': conv.id === activeConversationId }"
              @click="openChat(conv.id)"
            >
              <span class="conv-avatar">
                <img v-if="conv.peerAvatar" :src="conv.peerAvatar" alt="" class="conv-avatar-img" />
                <template v-else>{{ peerInitial(conv.peerName) }}</template>
              </span>

              <span class="conv-main">
                <span class="conv-head">
                  <b class="conv-name">{{ conv.peerName }}</b>
                  <i class="conv-time num">{{ shortTime(conv.lastMessageAt) }}</i>
                </span>

                <span class="conv-last">{{ conv.lastMessage }}</span>
              </span>

              <span v-if="conv.unreadCount > 0" class="conv-badge">
                {{ conv.unreadCount > 99 ? '99+' : conv.unreadCount }}
              </span>
            </button>
          </div>
        </aside>

        <!-- 右：聊天窗口 -->
        <section class="chat-main">
          <template v-if="activeConversationId">
            <header class="chat-head">
              <span class="chat-peer">
                <b>{{ activePeer?.peerName ?? '会话' }}</b>
                <i v-if="activePeer?.peerPhone" class="num">{{ activePeer.peerPhone }}</i>
              </span>
            </header>

            <div v-loading="messagesLoading" class="chat-body">
              <p v-if="!messagesLoading && !messages.length" class="chat-empty">
                和 {{ activePeer?.peerName ?? '对方' }} 打个招呼吧。
              </p>

              <div v-for="msg in messages" :key="msg.id" class="msg" :class="msg.mine ? 'msg--mine' : 'msg--peer'">
                <div class="msg-bubble">
                  <template v-if="msg.kind === 'TEXT'">
                    <p class="msg-text">{{ msg.content }}</p>
                  </template>

                  <template v-else>
                    <div v-for="att in msg.attachments" :key="att.id" class="msg-att">
                      <img
                        v-if="att.isImage"
                        :src="imageSrc(att.url)"
                        alt=""
                        class="msg-image"
                        @click="downloadAttachment(att.url, att.fileName)"
                      />

                      <button v-else type="button" class="msg-file" @click="downloadAttachment(att.url, att.fileName)">
                        <span class="msg-file-name">{{ att.fileName }}</span>
                        <span class="msg-file-size num">{{ formatSize(att.sizeBytes) }}</span>
                      </button>
                    </div>

                    <p v-if="msg.content" class="msg-text">{{ msg.content }}</p>
                  </template>

                  <span class="msg-time num">{{ formatTime(msg.createdAt) }}</span>
                </div>
              </div>

              <div ref="messagesEnd" />
            </div>

            <footer class="chat-input">
              <div v-if="pendingFile" class="chat-pending">
                <span class="chat-pending-name">{{ pendingFile.name }}</span>
                <span class="chat-pending-size num">{{ formatSize(pendingFile.size) }}</span>
                <el-button link @click="clearPendingFile">移除</el-button>
              </div>

              <div class="chat-input-row">
                <input
                  v-model="draft"
                  type="text"
                  class="chat-text"
                  placeholder="输入消息，回车发送"
                  @keydown.enter.prevent="handleSend"
                />

                <label class="chat-file-btn" title="发送图片或文件">
                  <input type="file" class="chat-file-input" @change="onPickFile" />
                  ＋
                </label>

                <el-button type="primary" :loading="sending" @click="handleSend">
                  发送
                </el-button>
              </div>
            </footer>
          </template>

          <div v-else class="chat-placeholder">
            <el-empty description="选择左侧会话开始聊天，或发起一个新会话" :image-size="120" />
          </div>
        </section>
      </div>
    </div>

    <!-- 发起会话弹窗 -->
    <el-dialog v-model="newChatVisible" title="发起会话" width="min(440px, 92vw)">
      <el-form label-width="0">
        <el-form-item>
          <el-select
            v-model="newChatPeerId"
            placeholder="选择要聊天的同事"
            filterable
            :loading="newChatLoading"
            style="width: 100%"
          >
            <el-option
              v-for="c in contacts"
              :key="c.id"
              :label="`${c.name}（${c.phone}）`"
              :value="c.id"
            />
          </el-select>
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="newChatVisible = false">取消</el-button>
        <el-button type="primary" :loading="newChatLoading" @click="startNewChat">
          开始聊天
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.messages-page {
  display: flex;
  flex-direction: column;
}

.page-inner {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.chat-shell {
  display: grid;
  grid-template-columns: 280px 1fr;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 0;
}

/* ---------- 左：会话列表 ---------- */
.chat-list {
  border-right: 1px solid var(--rule);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.chat-list-inner {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px;
}

.conv-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  text-align: left;
  transition: background-color 0.15s;
}

.conv-item:hover {
  background: var(--paper-2);
}

.conv-item--active {
  background: var(--brand-wash);
}

.conv-avatar {
  flex-shrink: 0;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  background: var(--paper-3);
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--song);
  font-size: 15px;
  color: var(--ink-2);
  overflow: hidden;
}

.conv-avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.conv-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.conv-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.conv-name {
  font-size: 13.5px;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.conv-time {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--ink-3);
}

.conv-last {
  font-size: 12px;
  color: var(--ink-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.conv-badge {
  flex-shrink: 0;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--brand);
  color: #fff;
  font-size: 11px;
  line-height: 18px;
  text-align: center;
}

/* ---------- 右：聊天窗口 ---------- */
.chat-main {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.chat-head {
  flex-shrink: 0;
  padding: 12px 18px;
  border-bottom: 1px solid var(--rule);
}

.chat-peer {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.chat-peer b {
  font-family: var(--song);
  font-size: 15px;
  color: var(--ink);
}

.chat-peer i {
  font-size: 12px;
  color: var(--ink-3);
}

.chat-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  background: var(--paper);
}

.chat-empty {
  margin: auto;
  font-size: 13px;
  color: var(--ink-3);
}

.msg {
  display: flex;
}

.msg--mine {
  justify-content: flex-end;
}

.msg--peer {
  justify-content: flex-start;
}

.msg-bubble {
  max-width: 68%;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 9px 12px;
  border-radius: 10px;
}

.msg--mine .msg-bubble {
  background: var(--brand);
  color: #fff;
}

.msg--peer .msg-bubble {
  background: #fff;
  border: 1px solid var(--rule);
  color: var(--ink);
}

.msg-text {
  margin: 0;
  font-size: 14px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.msg--mine .msg-text {
  color: #fff;
}

.msg-time {
  font-size: 10.5px;
  color: var(--ink-3);
  align-self: flex-end;
}

.msg--mine .msg-time {
  color: rgba(255, 255, 255, 0.7);
}

.msg-att {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.msg-image {
  max-width: 240px;
  max-height: 200px;
  border-radius: 6px;
  cursor: pointer;
  display: block;
}

.msg-file {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: 1px solid var(--rule);
  border-radius: 6px;
  background: var(--paper-2);
  cursor: pointer;
  text-align: left;
}

.msg--mine .msg-file {
  background: rgba(255, 255, 255, 0.15);
  border-color: rgba(255, 255, 255, 0.3);
}

.msg-file-name {
  font-size: 13px;
  color: var(--ink);
  max-width: 200px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.msg--mine .msg-file-name {
  color: #fff;
}

.msg-file-size {
  font-size: 11px;
  color: var(--ink-3);
}

.msg--mine .msg-file-size {
  color: rgba(255, 255, 255, 0.7);
}

/* ---------- 输入区 ---------- */
.chat-input {
  flex-shrink: 0;
  padding: 12px 16px;
  border-top: 1px solid var(--rule);
  background: #fff;
}

.chat-pending {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  margin-bottom: 8px;
  background: var(--brand-wash);
  border: 1px solid var(--brand-line);
  border-radius: 6px;
  font-size: 12.5px;
}

.chat-pending-name {
  color: var(--ink);
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chat-pending-size {
  color: var(--ink-3);
}

.chat-input-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.chat-text {
  flex: 1;
  min-width: 0;
  height: 38px;
  padding: 0 12px;
  border: 1px solid var(--rule);
  border-radius: 8px;
  font-size: 14px;
  color: var(--ink);
  outline: none;
}

.chat-text:focus {
  border-color: var(--brand);
}

.chat-file-btn {
  flex-shrink: 0;
  width: 38px;
  height: 38px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--rule);
  border-radius: 8px;
  font-size: 20px;
  color: var(--ink-2);
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}

.chat-file-btn:hover {
  border-color: var(--brand);
  color: var(--brand);
}

.chat-file-input {
  display: none;
}

.chat-placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

@media (max-width: 720px) {
  .chat-shell {
    grid-template-columns: 1fr;
  }

  .chat-list {
    border-right: none;
    border-bottom: 1px solid var(--rule);
    max-height: 200px;
  }

  .chat-main {
    min-height: 320px;
  }
}
</style>
