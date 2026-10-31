<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import {
  askMeeting,
  listMeetingChat,
  type MeetingChatMessageRecord
} from '../api/meeting'

/**
 * 会议追问抽屉。
 *
 * 定位是「读」：AI 只解释这份纪要，不改任何数据。
 * 所以这里没有编辑控件，回答也不会变成待办 —— 想改数据，
 * 走页面上原有的待办与状态入口，那里才有权限与审计。
 */
const props = defineProps<{
  modelValue: boolean
  meetingId: number
  meetingTitle?: string
}>()

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
})

/** 建议问题：空态时给几个能直接点的，比让人对着空输入框想问题友好得多 */
const suggestions = [
  '这场会定了哪些事？',
  '还有哪些没有定下来？',
  '谁要做什么，什么时候交？',
  '用三句话总结给我'
]

const messages = ref<MeetingChatMessageRecord[]>([])
const draft = ref('')
const pending = ref(false)
const loadingHistory = ref(false)
const historyLoaded = ref(false)
const error = ref('')
const listEl = ref<HTMLElement | null>(null)

let tempId = 0
/** 本地消息用负数 id，避免和历史消息的真实 id 撞 key */
const nextLocalId = () => {
  tempId += 1
  return -tempId
}

const formatTime = (value: string) => {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) return ''

  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  })
}

const scrollToBottom = async () => {
  await nextTick()
  const el = listEl.value

  if (el) {
    el.scrollTop = el.scrollHeight
  }
}

/** 首次打开时从头读，而不是一进来就停在最后一条的中间 */
const scrollToTop = async () => {
  await nextTick()
  const el = listEl.value

  if (el) {
    el.scrollTop = 0
  }
}

/** 只在第一次打开时拉历史：来回开关抽屉不该反复请求 */
const loadHistory = async () => {
  if (historyLoaded.value) return

  loadingHistory.value = true

  try {
    messages.value = await listMeetingChat(props.meetingId)
    historyLoaded.value = true
    await scrollToTop()
  } catch {
    // 历史拉不到不影响提问，静默降级成空对话
    error.value = '历史记录加载失败，不影响继续提问'
  } finally {
    loadingHistory.value = false
  }
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      error.value = ''
      void loadHistory()
    }
  }
)

/** 换一场会议就清空，避免把上一场的对话显示到这一场 */
watch(
  () => props.meetingId,
  () => {
    messages.value = []
    historyLoaded.value = false
    draft.value = ''
    error.value = ''
  }
)

const send = async (preset?: string) => {
  const question = (preset ?? draft.value).trim()

  if (!question || pending.value) return

  error.value = ''
  draft.value = ''
  pending.value = true

  // 先把问题贴上去，不等接口回来 —— 否则点完没反应，像卡住了
  messages.value.push({
    id: nextLocalId(),
    role: 'USER',
    content: question,
    createdAt: new Date().toISOString()
  })

  await scrollToBottom()

  try {
    const { answer, createdAt } = await askMeeting(props.meetingId, question)

    messages.value.push({
      id: nextLocalId(),
      role: 'ASSISTANT',
      content: answer,
      createdAt
    })
  } catch (err: any) {
    const status = err?.response?.status
    const message = err?.response?.data?.message

    if (status === 429) {
      // 限流是正常的保护，说清楚「等一下」，别让人以为是坏了
      error.value = message || '问得有点快，请稍等一会儿再试'
    } else if (status === 404) {
      error.value = '这场会议已经不存在，或者你没有访问权限'
    } else {
      error.value = message || '回答生成失败，请稍后重试'
    }

    // 问题没被回答就撤销，避免留下一条永远等不到回复的提问
    messages.value = messages.value.filter((item) => item.id > 0)
  } finally {
    pending.value = false
    await scrollToBottom()
  }
}

const onKeydown = (event: KeyboardEvent) => {
  // 中文输入法选词时的回车不能当发送
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return

  event.preventDefault()
  void send()
}

const copyAnswer = async (content: string) => {
  try {
    await navigator.clipboard.writeText(content)
    ElMessage.success('已复制')
  } catch {
    ElMessage.warning('浏览器不允许复制，请手动选中')
  }
}

/* =========================
   极简 Markdown
   ========================= */

/**
 * 模型习惯用 **加粗** 和列表组织答案。直接按纯文本显示，
 * 满屏都是星号，一眼就像没做完的半成品。
 *
 * 这里只支持确实会出现的几种：加粗、行内代码、无序/有序列表、段落。
 * 所有文本先转义再拼标签 —— 会议原文可能包含尖括号，
 * 不能让它变成可执行标记。
 */
const escapeHtml = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/** 行内样式：先转义，再替换语法，顺序不能反 */
const inline = (text: string) =>
  escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')

const renderMarkdown = (source: string): string => {
  const html: string[] = []
  let items: string[] = []
  let ordered = false

  const flushList = () => {
    if (!items.length) return

    const tag = ordered ? 'ol' : 'ul'

    html.push(`<${tag}>${items.map((item) => `<li>${item}</li>`).join('')}</${tag}>`)
    items = []
  }

  for (const raw of source.split('\n')) {
    const line = raw.trimEnd()

    if (!line.trim()) {
      flushList()
      continue
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/)
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/)

    if (bullet) {
      if (ordered) flushList()
      ordered = false
      items.push(inline(bullet[1]))
      continue
    }

    if (numbered) {
      if (!ordered) flushList()
      ordered = true
      items.push(inline(numbered[1]))
      continue
    }

    flushList()
    html.push(`<p>${inline(line)}</p>`)
  }

  flushList()

  return html.join('')
}
</script>

<template>
  <el-drawer
    v-model="visible"
    direction="rtl"
    size="460px"
    :with-header="false"
    class="mm-ask"
  >
    <div class="mm-ask-shell">
      <header class="mm-ask-head">
        <div class="mm-ask-head-main">
          <p class="mm-ask-title">
            问这场会
          </p>

          <p class="mm-ask-sub">
            {{ meetingTitle || '这份纪要' }} · 只依据纪要内容回答
          </p>
        </div>

        <button type="button" class="mm-ask-close" aria-label="关闭" @click="visible = false">
          ×
        </button>
      </header>

      <div ref="listEl" class="mm-ask-list">
        <div v-if="!messages.length && !loadingHistory" class="mm-ask-empty">
          <p class="mm-ask-empty-t">
            可以从这些问起
          </p>

          <button v-for="item in suggestions" :key="item" type="button" class="mm-ask-chip"
            @click="send(item)">
            {{ item }}
          </button>

          <p class="mm-ask-empty-note">
            助手只读这份纪要，不会修改会议、待办或成员。
          </p>
        </div>

        <div v-for="msg in messages" :key="msg.id" class="mm-ask-row"
          :class="msg.role === 'USER' ? 'is-user' : 'is-ai'">
          <!-- 用户输入是纯文本（保留换行），回答走极简 Markdown 渲染 -->
          <div v-if="msg.role === 'USER'" class="mm-ask-bubble mm-ask-plain">
            {{ msg.content }}
          </div>

          <div v-else class="mm-ask-bubble mm-ask-md" v-html="renderMarkdown(msg.content)" />

          <div class="mm-ask-meta">
            <time class="mm-ask-time">{{ formatTime(msg.createdAt) }}</time>

            <button v-if="msg.role === 'ASSISTANT'" type="button" class="mm-ask-copy"
              title="复制这段回答" @click="copyAnswer(msg.content)">
              复制
            </button>
          </div>
        </div>

        <div v-if="pending" class="mm-ask-row is-ai">
          <div class="mm-ask-bubble mm-ask-typing" aria-label="正在生成回答">
            <i /><i /><i />
          </div>
        </div>

        <p v-if="error" class="mm-ask-error">
          {{ error }}
        </p>
      </div>

      <footer class="mm-ask-foot">
        <textarea v-model="draft" class="mm-ask-input" rows="2" maxlength="500"
          placeholder="问点什么，比如「哪些事还没定？」" :disabled="pending" @keydown="onKeydown" />

        <div class="mm-ask-foot-bar">
          <span class="mm-ask-hint">Enter 发送 · Shift + Enter 换行</span>

          <button type="button" class="mm-ask-send" :disabled="pending || !draft.trim()" @click="send()">
            {{ pending ? '思考中' : '发送' }}
          </button>
        </div>
      </footer>
    </div>
  </el-drawer>
</template>

<style>
/* 抽屉挂在 body 下，样式不能 scoped，统一用 mm-ask 前缀避免污染 */

.mm-ask .el-drawer__body {
  padding: 0;
  overflow: hidden;
}

.mm-ask-shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--paper, #fbfbfd);
}

.mm-ask-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 18px 20px 14px;
  border-bottom: 1px solid var(--rule-soft, #e6e9f1);
  background: #fff;
}

.mm-ask-head-main {
  min-width: 0;
}

.mm-ask-title {
  margin: 0;
  font-family: var(--song, serif);
  font-size: 17px;
  font-weight: 500;
  color: var(--ink, #151a2e);
  letter-spacing: 0.02em;
}

.mm-ask-sub {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: #7d859b;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mm-ask-close {
  flex: none;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: #7d859b;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  transition: background 0.15s ease;
}

.mm-ask-close:hover {
  background: var(--band, #f1f2f7);
  color: var(--ink, #151a2e);
}

.mm-ask-list {
  flex: 1;
  min-height: 0;
  padding: 18px 20px 8px;
  overflow-y: auto;
  scroll-behavior: smooth;
}

.mm-ask-empty {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 8px;
}

.mm-ask-empty-t {
  margin: 0 0 4px;
  font-size: 12px;
  letter-spacing: 0.06em;
  color: #7d859b;
}

.mm-ask-chip {
  padding: 10px 12px;
  border: 1px solid var(--rule, #d5d9e5);
  border-radius: 8px;
  background: #fff;
  color: var(--ink-body, #232838);
  font-family: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.mm-ask-chip:hover {
  border-color: var(--brand-line, #c9ccf8);
  background: var(--brand-soft, #f6f7fe);
}

.mm-ask-empty-note {
  margin: 10px 0 0;
  font-size: 11.5px;
  line-height: 1.6;
  color: #8f97a8;
}

.mm-ask-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 14px;
}

.mm-ask-row.is-user {
  align-items: flex-end;
}

.mm-ask-row.is-ai {
  align-items: flex-start;
}

.mm-ask-bubble {
  position: relative;
  max-width: 88%;
  padding: 10px 13px;
  border-radius: 10px;
  font-size: 13.5px;
  line-height: 1.72;
  word-break: break-word;
}

/* 用户输入保留原始换行；回答由 Markdown 渲染成块级元素 */
.mm-ask-plain {
  white-space: pre-wrap;
}

.mm-ask-md p {
  margin: 0 0 8px;
}

.mm-ask-md p:last-child {
  margin-bottom: 0;
}

.mm-ask-md ul,
.mm-ask-md ol {
  margin: 6px 0 8px;
  padding-left: 18px;
}

.mm-ask-md li {
  margin: 3px 0;
}

.mm-ask-md li::marker {
  color: #a3aab9;
}

.mm-ask-md strong {
  font-weight: 500;
  color: #10142a;
}

.mm-ask-md code {
  padding: 1px 4px;
  border-radius: 4px;
  background: #f1f2f7;
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12.5px;
}

.is-user .mm-ask-bubble {
  background: var(--brand, #4f46e5);
  color: #fff;
  border-bottom-right-radius: 3px;
}

.is-ai .mm-ask-bubble {
  background: #fff;
  color: var(--ink-body, #232838);
  border: 1px solid var(--rule-soft, #e6e9f1);
  border-bottom-left-radius: 3px;
}

.mm-ask-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mm-ask-copy {
  padding: 0;
  border: none;
  background: transparent;
  color: #b3b9c7;
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
  transition: color 0.15s ease;
}

.mm-ask-copy:hover {
  color: var(--brand, #4f46e5);
}

.mm-ask-time {
  font-size: 11px;
  color: #b3b9c7;
}

.mm-ask-typing {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 14px 16px;
}

.mm-ask-typing i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #c2c7d4;
  animation: mm-ask-blink 1.2s infinite ease-in-out;
}

.mm-ask-typing i:nth-child(2) {
  animation-delay: 0.18s;
}

.mm-ask-typing i:nth-child(3) {
  animation-delay: 0.36s;
}

@keyframes mm-ask-blink {
  0%, 80%, 100% {
    opacity: 0.3;
    transform: translateY(0);
  }

  40% {
    opacity: 1;
    transform: translateY(-2px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .mm-ask-typing i {
    animation: none;
    opacity: 0.6;
  }
}

.mm-ask-error {
  margin: 0 0 12px;
  padding: 9px 12px;
  border-radius: 8px;
  background: #fdf1ef;
  color: #a8322a;
  font-size: 12.5px;
  line-height: 1.6;
}

.mm-ask-foot {
  flex: none;
  padding: 12px 20px 16px;
  border-top: 1px solid var(--rule-soft, #e6e9f1);
  background: #fff;
}

.mm-ask-input {
  display: block;
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--rule, #d5d9e5);
  border-radius: 8px;
  background: #fff;
  color: var(--ink-body, #232838);
  font-family: inherit;
  font-size: 13.5px;
  line-height: 1.6;
  resize: none;
  outline: none;
  transition: border-color 0.15s ease;
}

.mm-ask-input:focus {
  border-color: var(--brand-line, #c9ccf8);
}

.mm-ask-input:disabled {
  background: #f7f8fb;
  cursor: not-allowed;
}

.mm-ask-foot-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 8px;
}

.mm-ask-hint {
  font-size: 11px;
  color: #a3aab9;
}

.mm-ask-send {
  padding: 7px 18px;
  border: none;
  border-radius: 7px;
  background: var(--brand, #4f46e5);
  color: #fff;
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s ease;
}

.mm-ask-send:hover:not(:disabled) {
  background: var(--brand-strong, #4338ca);
}

.mm-ask-send:disabled {
  background: #c9ccdf;
  cursor: not-allowed;
}

@media (max-width: 520px) {
  /* class 可能落在 overlay 或 drawer 本体上，两种都覆盖 */
  .mm-ask .el-drawer,
  .el-drawer.mm-ask {
    width: 100% !important;
  }
}
</style>
