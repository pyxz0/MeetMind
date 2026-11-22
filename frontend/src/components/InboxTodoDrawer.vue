<script setup lang="ts">
/**
 * 收件箱待办抽屉：把「看」和「做」放在同一层。
 *
 * 之前收件箱的每一行都只能跳去会议详情，处理五条待办要跳五次页面、
 * 每次重新找到那条待办。这个抽屉承载闭环里真正要发生的动作：
 * 提交交付、验收通过、打回、改期、改派 —— 全部复用会议详情页那套接口，
 * 权限也仍然是后端说了算，前端只决定按钮显不显示。
 */
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { UploadUserFile } from 'element-plus'
import {
  acceptSubmission,
  downloadSubmissionAttachment,
  getMeeting,
  listTodoSubmissions,
  nudgeTodo,
  rejectSubmission,
  submitTodo,
  toggleTodoCheckItem,
  updateTodo,
  updateTodoStatus,
  uploadSubmissionAttachment,
  withdrawSubmission,
  type MeetingResult,
  type TodoItem,
  type TodoSubmissionRecord
} from '../api/meeting'
import { listContacts, type Contact } from '../api/auth'
import { authStore } from '../stores/auth'

const props = defineProps<{
  modelValue: boolean
  /** 要处理哪条待办；为空时抽屉不加载 */
  todoId: number | null
  meetingId: number | null
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
  /** 待办状态或信息变了，让收件箱重新拉一次 */
  (event: 'changed'): void
  (event: 'open-meeting', meetingId: number): void
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
})

const loading = ref(false)
const loadError = ref('')
const meeting = ref<MeetingResult | null>(null)
const todo = ref<TodoItem | null>(null)
const submissions = ref<TodoSubmissionRecord[]>([])

/** 抽屉内部的三种形态：看 / 提交 / 打回 */
const mode = ref<'view' | 'submit' | 'reject'>('view')

const submitting = ref(false)
const submitNote = ref('')
const submitFiles = ref<UploadUserFile[]>([])
const rejectReason = ref('')

/** 调整区（改期 / 改派）默认收起，避免和主操作抢注意力 */
const adjustOpen = ref(false)
const adjustSaving = ref(false)
const draftAssigneeId = ref<number | undefined>(undefined)
const draftDeadline = ref<string | null>(null)
const contacts = ref<Contact[]>([])
const contactsLoading = ref(false)

const latestSubmission = computed(() => {
  // 后端按 createdAt desc 返回，第一条就是最近一次
  const first = submissions.value[0]

  if (!first) return null

  return first
})

/** 待验收的那条提交：优先用 intent 指定的，否则取最近一条 PENDING */
const pendingSubmission = computed(() => {
  return submissions.value.find((row) => row.status === 'PENDING') ?? null
})

const canSubmit = computed(() => todo.value?.canSubmit === true)
const canReview = computed(
  () => pendingSubmission.value !== null && todo.value?.canReview === true
)
const canWithdraw = computed(() => todo.value?.canWithdraw === true)
const canAdjust = computed(() => meeting.value?.canEditTodos === true)
/** 勾选验收要点要会议编辑权限，验收人本身不一定有 */
const canTickChecklist = computed(() => meeting.value?.canEditTodos === true)

const checklist = computed(() => todo.value?.checklist ?? [])
const checklistDone = computed(
  () => checklist.value.filter((item) => item.done).length
)

const meId = computed(() => authStore.user?.id ?? null)

/**
 * 能不能催负责人：待办还没交，而我是验收人或会议负责人。
 * 还没交付的时候催「验收」没有意义，所以只留催负责人这一侧。
 */
const canNudgeAssignee = computed(() => {
  const item = todo.value

  if (!item) return false
  if (item.status !== 'OPEN' && item.status !== 'IN_PROGRESS') return false
  if (!item.assigneeUserId || item.assigneeUserId === meId.value) return false

  return item.reviewerId === meId.value || meeting.value?.canEditTodos === true
})

/** 能不能催验收人：我交了，还压着没人验 */
const canNudgeReviewer = computed(() => {
  const item = todo.value

  return (
    !!item &&
    item.status === 'SUBMITTED' &&
    item.assigneeUserId !== null &&
    item.assigneeUserId === meId.value
  )
})

const statusText = (status?: string) => {
  switch (status) {
    case 'OPEN':
      return '未开始'
    case 'IN_PROGRESS':
      return '进行中'
    case 'SUBMITTED':
      return '待验收'
    case 'COMPLETED':
      return '已完成'
    case 'CANCELLED':
      return '已取消'
    default:
      return '未知'
  }
}

const statusType = (status?: string) => {
  switch (status) {
    case 'COMPLETED':
      return 'success'
    case 'SUBMITTED':
      return 'warning'
    case 'CANCELLED':
      return 'info'
    default:
      return 'primary'
  }
}

const formatDay = (value?: string | null) => {
  if (!value) return '未指定'

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) return value

  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
}

const formatTime = (value?: string | null) => {
  if (!value) return ''

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) return value

  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

const formatSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const resetForms = () => {
  mode.value = 'view'
  submitNote.value = ''
  submitFiles.value = []
  rejectReason.value = ''
  adjustOpen.value = false
}

const loadDetail = async () => {
  if (!props.todoId || !props.meetingId) return

  loading.value = true
  loadError.value = ''

  try {
    const [meetingData, submissionRows] = await Promise.all([
      getMeeting(props.meetingId),
      listTodoSubmissions(props.todoId).catch(() => [])
    ])

    meeting.value = meetingData

    const found = (meetingData.todos ?? []).find(
      (item) => item.id === props.todoId
    )

    if (!found) {
      loadError.value = '这条待办已被删除或你已无权查看'
      todo.value = null

      return
    }

    todo.value = found
    submissions.value = submissionRows

    draftAssigneeId.value = found.assigneeUserId ?? undefined
    draftDeadline.value = found.deadlineAt
      ? found.deadlineAt.slice(0, 10)
      : null
  } catch (error: any) {
    const message = error?.response?.data?.message ?? '待办详情加载失败'
    loadError.value = Array.isArray(message) ? message.join('；') : message
  } finally {
    loading.value = false
  }
}

watch(
  () => [props.modelValue, props.todoId, props.meetingId] as const,
  ([open]) => {
    if (!open) {
      resetForms()
      meeting.value = null
      todo.value = null
      submissions.value = []

      return
    }

    void loadDetail()
  },
  { immediate: true }
)

const loadContacts = async () => {
  if (contacts.value.length || contactsLoading.value) return

  contactsLoading.value = true

  try {
    contacts.value = await listContacts()
  } catch {
    contacts.value = []
  } finally {
    contactsLoading.value = false
  }
}

const openSubmit = () => {
  mode.value = 'submit'
  submitNote.value = ''
  submitFiles.value = []
}

const openReject = () => {
  mode.value = 'reject'
  rejectReason.value = ''
}

const backToView = () => {
  mode.value = 'view'
}

/** 提交交付（被打回后重新提交也走这里，后端会递增 attemptNo） */
const handleSubmit = async () => {
  if (!todo.value?.id || submitting.value) return

  submitting.value = true

  try {
    const result = await submitTodo(
      todo.value.id,
      submitNote.value.trim() || undefined
    )

    let uploaded = 0
    const failed: string[] = []

    for (const item of submitFiles.value) {
      if (!item.raw) continue

      try {
        await uploadSubmissionAttachment(result.id, item.raw)
        uploaded += 1
      } catch {
        failed.push(item.name)
      }
    }

    if (failed.length) {
      ElMessage.warning(
        `已提交，${uploaded} 个附件成功；${failed.join('、')} 上传失败`
      )
    } else if (result?.status === 'ACCEPTED') {
      ElMessage.success('已提交；验收人是你本人，按通过处理')
    } else {
      ElMessage.success(
        uploaded ? `已提交，${uploaded} 个附件等待验收` : '已提交，等待验收'
      )
    }

    emit('changed')
    visible.value = false
  } catch (error: any) {
    const message = error?.response?.data?.message ?? '提交失败，请重试'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  } finally {
    submitting.value = false
  }
}

const handleAccept = async () => {
  const submission = pendingSubmission.value

  if (!submission || submitting.value) return

  const unchecked = checklist.value.length - checklistDone.value

  if (unchecked > 0) {
    try {
      await ElMessageBox.confirm(
        `还有 ${unchecked} 条验收要点没勾选，仍要通过吗？`,
        '验收要点未完成',
        { confirmButtonText: '仍要通过', cancelButtonText: '回去核对' }
      )
    } catch {
      return
    }
  }

  submitting.value = true

  try {
    const result = await acceptSubmission(submission.id)

    ElMessage.success(
      result?.uncheckedChecklist
        ? `已通过（${result.uncheckedChecklist} 条要点未勾）`
        : '已通过验收'
    )

    emit('changed')
    visible.value = false
  } catch (error: any) {
    const message = error?.response?.data?.message ?? '验收失败，请重试'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  } finally {
    submitting.value = false
  }
}

const handleReject = async () => {
  const submission = pendingSubmission.value

  if (!submission || submitting.value) return

  const text = rejectReason.value.trim()

  if (text.length < 5) {
    ElMessage.warning('请填写至少 5 个字的打回原因')
    return
  }

  submitting.value = true

  try {
    await rejectSubmission(submission.id, text)

    ElMessage.success('已打回，负责人会收到通知')
    emit('changed')
    visible.value = false
  } catch (error: any) {
    const message = error?.response?.data?.message ?? '打回失败，请重试'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  } finally {
    submitting.value = false
  }
}

const handleWithdraw = async () => {
  const submission = pendingSubmission.value

  if (!submission) return

  try {
    await ElMessageBox.confirm('撤回后回到进行中，需要重新提交。', '撤回交付', {
      confirmButtonText: '撤回',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }

  submitting.value = true

  try {
    await withdrawSubmission(submission.id)

    ElMessage.success('已撤回')
    emit('changed')
    await loadDetail()
  } catch (error: any) {
    const message = error?.response?.data?.message ?? '撤回失败'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  } finally {
    submitting.value = false
  }
}

const handleToggleCheck = async (itemId: number, done: boolean) => {
  if (!todo.value?.id || !canTickChecklist.value) return

  try {
    await toggleTodoCheckItem(todo.value.id, itemId, done)

    const target = checklist.value.find((item) => item.id === itemId)

    if (target) {
      target.done = done
    }
  } catch (error: any) {
    const message = error?.response?.data?.message ?? '勾选失败'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  }
}

/** 改期 / 改派：只有会议写权限的人能改，后端还会再校一次 */
const handleSaveAdjust = async () => {
  if (!todo.value?.id || adjustSaving.value) return

  const payload: {
    assigneeUserId?: number | null
    deadlineAt?: string | null
  } = {}

  const nextAssignee = draftAssigneeId.value ?? null

  if (nextAssignee !== (todo.value.assigneeUserId ?? null)) {
    payload.assigneeUserId = nextAssignee
  }

  const nextDeadline = draftDeadline.value || null
  const currentDeadline = todo.value.deadlineAt
    ? todo.value.deadlineAt.slice(0, 10)
    : null

  if (nextDeadline !== currentDeadline) {
    payload.deadlineAt = nextDeadline
  }

  if (!Object.keys(payload).length) {
    ElMessage.info('没有改动')
    return
  }

  adjustSaving.value = true

  try {
    await updateTodo(todo.value.id, payload)

    ElMessage.success('已更新')
    emit('changed')
    await loadDetail()
  } catch (error: any) {
    const message = error?.response?.data?.message ?? '更新失败'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  } finally {
    adjustSaving.value = false
  }
}

/** 负责人在抽屉里直接标记完成（有验收人时等同代替验收，后端会留审计） */
const handleComplete = async () => {
  if (!todo.value?.id || submitting.value) return

  try {
    await ElMessageBox.confirm(
      todo.value.reviewerId
        ? '这条待办有验收人，直接标记完成会跳过验收环节（会记录审计）。确定吗？'
        : '确认把这条待办标记为已完成？',
      '标记完成',
      { confirmButtonText: '标记完成', cancelButtonText: '取消' }
    )
  } catch {
    return
  }

  submitting.value = true

  try {
    await updateTodoStatus(todo.value.id, 'COMPLETED')

    ElMessage.success('已标记完成')
    emit('changed')
    visible.value = false
  } catch (error: any) {
    const message = error?.response?.data?.message ?? '操作失败'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  } finally {
    submitting.value = false
  }
}

/**
 * 催办。
 *
 * 只发一句话，不填表单 —— 催办是一个动作，不是一次沟通。
 * 真要说明白，用会议里的消息或直接打电话。
 */
const handleNudge = async (to: 'assignee' | 'reviewer') => {
  if (!todo.value?.id || submitting.value) return

  const targetName =
    to === 'assignee'
      ? todo.value.assigneeName || todo.value.assignee || '负责人'
      : todo.value.reviewerName || '验收人'

  try {
    await ElMessageBox.confirm(
      `给${targetName}发一条催办，会同时进入站内消息和邮件。同一条待办的同一个对象每天只能催一次。`,
      to === 'assignee' ? '催办负责人' : '催办验收人',
      { confirmButtonText: '发出去', cancelButtonText: '算了' }
    )
  } catch {
    return
  }

  submitting.value = true

  try {
    await nudgeTodo(todo.value.id, to)

    ElMessage.success(`已提醒${targetName}`)
  } catch (error: any) {
    const message = error?.response?.data?.message ?? '催办失败，请重试'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  } finally {
    submitting.value = false
  }
}

const handleDownload = async (url: string, fileName: string) => {  try {
    await downloadSubmissionAttachment(url, fileName)
  } catch {
    ElMessage.error('附件下载失败，请重试')
  }
}

const goMeeting = () => {
  if (!props.meetingId) return

  emit('open-meeting', props.meetingId)
  visible.value = false
}
</script>

<template>
  <el-drawer v-model="visible" size="min(540px, 92vw)">
    <template #header>
      <span class="drawer-title">处理待办</span>
    </template>

    <div class="drawer-body">
      <div v-if="loading" class="drawer-loading">
        <el-skeleton :rows="5" animated />
      </div>

      <el-alert v-else-if="loadError" :title="loadError" type="warning" :closable="false" show-icon />

      <template v-else-if="todo">
        <!-- 头部：待办本身 -->
        <header class="drawer-head">
          <div class="head-top">
            <el-tag :type="statusType(todo.status)" size="small" effect="light">
              {{ statusText(todo.status) }}
            </el-tag>
            <span v-if="todo.overdue" class="overdue-pill">逾期</span>
            <span class="meeting-link" @click="goMeeting">{{ meeting?.title }}</span>
          </div>

          <h2 class="todo-title">{{ todo.content }}</h2>

          <div class="meta-row">
            <span>负责人 {{ todo.assigneeName || todo.assignee || '未指定' }}</span>
            <span v-if="todo.reviewerName">验收人 {{ todo.reviewerName }}</span>
            <span>截止 {{ formatDay(todo.deadlineAt) }}</span>
          </div>
        </header>

        <!-- 验收要点：验收时逐条核对，有权限才能勾 -->
        <section v-if="checklist.length" class="block">
          <div class="block-head">
            <span class="block-title">验收要点</span>
            <span class="block-hint">{{ checklistDone }}/{{ checklist.length }} 已勾</span>
          </div>

          <ul class="checklist">
            <li v-for="item in checklist" :key="item.id" class="check-item">
              <el-checkbox :model-value="item.done" :disabled="!canTickChecklist"
                @change="(value: boolean) => handleToggleCheck(item.id, value)">
                <span :class="{ 'check-done': item.done }">{{ item.content }}</span>
              </el-checkbox>
            </li>
          </ul>
        </section>

        <!-- 最近一次交付 -->
        <section v-if="latestSubmission" class="block">
          <div class="block-head">
            <span class="block-title">最近一次交付</span>
            <span class="block-hint">
              第 {{ latestSubmission.attemptNo }} 次 · {{ formatTime(latestSubmission.createdAt) }}
            </span>
          </div>

          <div class="submission">
            <div class="submission-who">
              {{ latestSubmission.submitter?.name || '未知提交人' }}
              <el-tag v-if="latestSubmission.status === 'PENDING'" type="warning" size="small" effect="plain">
                待验收
              </el-tag>
              <el-tag v-else-if="latestSubmission.status === 'REJECTED'" type="danger" size="small" effect="plain">
                已打回
              </el-tag>
              <el-tag v-else-if="latestSubmission.status === 'ACCEPTED'" type="success" size="small" effect="plain">
                已通过
              </el-tag>
            </div>

            <p v-if="latestSubmission.note" class="submission-note">{{ latestSubmission.note }}</p>
            <p v-else-if="latestSubmission.canViewContent === false" class="submission-note muted">
              你无权查看这条交付的说明与附件
            </p>
            <p v-else class="submission-note muted">未填写交付说明</p>

            <p v-if="latestSubmission.rejectReason" class="reject-reason">
              打回原因：{{ latestSubmission.rejectReason }}
            </p>

            <div v-if="latestSubmission.attachments?.length" class="files">
              <button v-for="file in latestSubmission.attachments" :key="file.id" type="button" class="file-row"
                @click="handleDownload(file.url, file.fileName)">
                <span class="file-name">{{ file.fileName }}</span>
                <span class="file-size">{{ formatSize(file.sizeBytes) }}</span>
              </button>
            </div>
          </div>
        </section>

        <!-- 提交表单 -->
        <section v-if="mode === 'submit'" class="block form-block">
          <div class="block-head">
            <span class="block-title">{{ latestSubmission?.status === 'REJECTED' ? '重新提交' : '提交交付' }}</span>
            <el-button link size="small" @click="backToView">返回</el-button>
          </div>

          <el-input v-model="submitNote" type="textarea" :rows="4" maxlength="1000" show-word-limit
            placeholder="说明你交付了什么、放在哪里，验收人据此判断（可不填）" />

          <el-upload v-model:file-list="submitFiles" :auto-upload="false" :limit="5" class="upload-block">
            <el-button plain size="small">选择附件</el-button>
            <template #tip>
              <div class="upload-tip">最多 5 个，验收人可在收件箱直接下载</div>
            </template>
          </el-upload>

          <div class="form-actions">
            <el-button @click="backToView">取消</el-button>
            <el-button type="primary" :loading="submitting" @click="handleSubmit">
              提交
            </el-button>
          </div>
        </section>

        <!-- 打回表单 -->
        <section v-if="mode === 'reject'" class="block form-block">
          <div class="block-head">
            <span class="block-title">打回</span>
            <el-button link size="small" @click="backToView">返回</el-button>
          </div>

          <el-input v-model="rejectReason" type="textarea" :rows="4" maxlength="500" show-word-limit
            placeholder="写清楚哪里不行、要怎么改（至少 5 个字，负责人会收到通知）" />

          <div class="form-actions">
            <el-button @click="backToView">取消</el-button>
            <el-button type="danger" :loading="submitting" @click="handleReject">
              确认打回
            </el-button>
          </div>
        </section>

        <!-- 调整区：改期 / 改派 -->
        <section v-if="mode === 'view' && canAdjust" class="block">
          <div class="block-head clickable" @click="adjustOpen = !adjustOpen">
            <span class="block-title">调整待办</span>
            <span class="block-hint">{{ adjustOpen ? '收起' : '改期 / 改派' }}</span>
          </div>

          <div v-if="adjustOpen" class="adjust">
            <label class="field">
              <span class="field-label">负责人</span>
              <el-select v-model="draftAssigneeId" placeholder="未指定" clearable filterable :loading="contactsLoading"
                style="width: 100%" @focus="loadContacts">
                <el-option v-for="c in contacts" :key="c.id" :label="`${c.name}（${c.phone}）`" :value="c.id" />
              </el-select>
            </label>

            <label class="field">
              <span class="field-label">截止日期</span>
              <el-date-picker v-model="draftDeadline" type="date" value-format="YYYY-MM-DD" placeholder="未指定"
                style="width: 100%" />
            </label>

            <div class="form-actions">
              <el-button type="primary" plain :loading="adjustSaving" @click="handleSaveAdjust">
                保存调整
              </el-button>
            </div>
          </div>
        </section>

        <!-- 底部操作条 -->
        <footer v-if="mode === 'view'" class="drawer-foot">
          <el-button link class="foot-secondary" @click="goMeeting">在会议中查看</el-button>

          <div class="foot-actions">
            <el-button v-if="canNudgeAssignee" plain size="default" @click="handleNudge('assignee')">
              催负责人
            </el-button>

            <el-button v-if="canNudgeReviewer" plain size="default" @click="handleNudge('reviewer')">
              催验收人
            </el-button>

            <el-button v-if="canWithdraw" :loading="submitting" @click="handleWithdraw">
              撤回提交
            </el-button>

            <el-button v-if="canSubmit" type="primary" @click="openSubmit">
              {{ latestSubmission?.status === 'REJECTED' ? '重新提交' : '提交交付' }}
            </el-button>

            <template v-if="canReview">
              <el-button type="danger" plain @click="openReject">打回</el-button>
              <el-button type="primary" :loading="submitting" @click="handleAccept">
                通过验收
              </el-button>
            </template>

            <!--
              标记完成用后端给的 canChangeStatus：只有验收人、会议负责人或超管有这权力。
              不能靠「没有别的按钮」来推断 —— 普通成员看得见这条待办，但改不了状态。
            -->
            <el-button v-if="todo.canChangeStatus && !canReview && todo.status !== 'COMPLETED'" :loading="submitting"
              @click="handleComplete">
              标记完成
            </el-button>

            <el-tag v-if="todo.status === 'COMPLETED'" type="success" effect="light">已完成</el-tag>
          </div>
        </footer>
      </template>
    </div>
  </el-drawer>
</template>

<style scoped>
.drawer-body {
  padding: 4px 4px 80px;
}

.drawer-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--ink);
}

.drawer-loading {
  padding: 12px;
}

.drawer-head {
  padding-bottom: 16px;
  border-bottom: 1px solid var(--rule-soft);
}

.head-top {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.overdue-pill {
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--vermilion-wash);
  color: var(--vermilion);
  font-size: 12px;
}

.meeting-link {
  margin-left: auto;
  color: var(--el-color-primary);
  font-size: 12px;
  cursor: pointer;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meeting-link:hover {
  text-decoration: underline;
}

.todo-title {
  margin: 0 0 10px;
  font-size: 16px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--el-text-color-primary);
}

.meta-row {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

.block {
  padding: 16px 0;
  border-bottom: 1px solid var(--rule-soft);
}

.block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.block-head.clickable {
  cursor: pointer;
}

.block-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--el-text-color-primary);
}

.block-hint {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.checklist {
  margin: 0;
  padding: 0;
  list-style: none;
}

.check-item {
  padding: 3px 0;
}

.check-done {
  color: var(--el-text-color-secondary);
  text-decoration: line-through;
}

.submission-who {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--el-text-color-primary);
  margin-bottom: 8px;
}

.submission-note {
  margin: 0 0 8px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--paper-2);
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.submission-note.muted {
  color: var(--el-text-color-placeholder);
}

.reject-reason {
  margin: 0 0 8px;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--vermilion-wash);
  color: var(--vermilion);
  font-size: 12px;
  line-height: 1.6;
}

.files {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.file-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 10px;
  border: 1px solid var(--rule-soft);
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  font-size: 12px;
  color: var(--ink);
  text-align: left;
}

.file-row:hover {
  border-color: var(--brand-line);
  background: var(--brand-wash);
}

.file-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-size {
  flex-shrink: 0;
  color: var(--el-text-color-secondary);
}

.form-block .el-textarea {
  margin-bottom: 12px;
}

.upload-block {
  margin-bottom: 14px;
}

.upload-tip {
  margin-top: 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.adjust {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-label {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.drawer-foot {
  position: sticky;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 0 4px;
  background: var(--el-bg-color);
}

.foot-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.foot-secondary {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}

@media (max-width: 640px) {
  .drawer-foot {
    flex-direction: column;
    align-items: stretch;
  }

  .foot-actions {
    justify-content: flex-end;
  }
}
</style>
