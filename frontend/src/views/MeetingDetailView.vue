<script setup lang="ts">
import { computed, reactive, ref, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { UploadUserFile } from 'element-plus'
import {
  getMeeting,
  updateTodoStatus,
  createTodo,
  deleteTodo,
  updateTodo,
  submitTodo,
  listTodoSubmissions,
  listTodoEvents,
  listMeetingEvents,
  acceptSubmission,
  rejectSubmission,
  withdrawSubmission,
  uploadSubmissionAttachment,
  downloadSubmissionAttachment,
  setTodoChecklist,
  toggleTodoCheckItem,
  type ChecklistItem,
  updateMeeting,
  regenerateMeeting,
  updateMeetingCompletionStatus,
  addMeetingLeader,
  removeMeetingLeader,
  addMeetingMember,
  removeMeetingMember,
  updateMeetingAudioOpen,
  updateMeetingPinned,
  updateScheduledMeeting,
  exportMeetingMarkdown,
  type MeetingRecord,
  type MemberBrief,
  type TodoItem,
  type TodoSubmissionRecord,
  type TodoEventRecord,
  type MeetingEventRecord
} from '../api/meeting'
import { listContacts, type Contact } from '../api/auth'
import MeetingAudioPlayer from '../components/MeetingAudioPlayer.vue'
import MeetingResultComponent from '../components/MeetingResult.vue'
import UserProfileDialog from '../components/UserProfileDialog.vue'
import MeetingShareDialog from '../components/MeetingShareDialog.vue'
import MeetingAskDrawer from '../components/MeetingAskDrawer.vue'
const route = useRoute()
const router = useRouter()

const meeting = ref<MeetingRecord | null>(null)

/** 分享弹窗状态 */
const shareDialogVisible = ref(false)

/** 追问抽屉：只读问答，不改任何数据 */
const askDrawerVisible = ref(false)

/** 打开平台入会链接；noopener 防止新页面拿到 window.opener */
const joinPlatformMeeting = () => {
  const url = meeting.value?.externalJoinUrl

  if (url) {
    window.open(url, '_blank', 'noopener')
  }
}

/** 个人主页名片：点负责人 / 成员 / 待办负责人 / 验收人 / 提交人都会打开 */
const profileVisible = ref(false)
const profileUserId = ref<number | null>(null)

const openProfile = (userId?: number | null) => {
  if (!userId) return

  profileUserId.value = userId
  profileVisible.value = true
}

/**
 * 权限判断集中在这里，模板只读这些计算属性。
 *
 * 后端已强制校验，前端隐藏按钮只为避免用户点了才收到 403。
 */
const canEdit = computed(() => meeting.value?.canEdit === true)
const canShare = computed(() => meeting.value?.canShare === true)
const canEditTodos = computed(() => meeting.value?.canEditTodos === true)
const canManageMembers = computed(
  () => meeting.value?.canManageMembers === true
)
const canToggleAudio = computed(
  () => meeting.value?.canToggleAudio === true
)
const canListenAudio = computed(
  () => meeting.value?.canListenAudio === true
)
/** 有录音但当前用户无权听 */
const audioBlocked = computed(
  () => !!meeting.value?.hasAudio && !canListenAudio.value
)
const isReadOnly = computed(
  () => !!meeting.value && meeting.value.canEdit === false
)

const todoDialogVisible = ref(false)
const todoSubmitting = ref(false)
const editTodoDialogVisible = ref(false)
const editTodoSubmitting = ref(false)

// 编辑会议标题
const editTitleDialogVisible = ref(false)
const editTitleSubmitting = ref(false)
const editTitle = ref('')

const editTodoForm = ref({
  id: 0,
  content: '',
  assigneeUserId: undefined as number | undefined,
  reviewerId: undefined as number | undefined,
  /** 截止日期，YYYY-MM-DD（日历选择） */
  deadlineAt: '',
  /** 用户是否动过日期：没动就不改，避免把历史文本截止时间清掉 */
  deadlineTouched: false,
  /** 验收要点，每行一条 */
  checklistText: '',
  /** 待验收期间不允许改清单，避免移动球门 */
  checklistLocked: false
})

const todoForm = ref({
  content: '',
  assigneeUserId: undefined as number | undefined,
  reviewerId: undefined as number | undefined,
  deadlineAt: '',
  checklistText: ''
})

/* ---------- 交付与验收 ---------- */
const submitDialogVisible = ref(false)
const submitSubmitting = ref(false)
const submitTarget = ref<TodoItem | null>(null)
const submitNote = ref('')
/** 交付物：先选文件，提交成功后逐个上传（最多 5 个，单个 ≤20MB） */
const submitFiles = ref<UploadUserFile[]>([])

const timelineVisible = ref(false)
const timelineLoading = ref(false)
const timelineTodo = ref<TodoItem | null>(null)
const submissions = ref<TodoSubmissionRecord[]>([])
/** 待办流转事件：谁撤回了、谁通过了、谁改了状态 */
const todoEvents = ref<TodoEventRecord[]>([])
/** 会议状态的手动变更：谁把会议改成了什么状态 */
const meetingEvents = ref<MeetingEventRecord[]>([])

/** 验收要点弹窗 */
const checklistVisible = ref(false)
const checklistTodo = ref<TodoItem | null>(null)
const checklistSavingId = ref<number | null>(null)

/** 提交详情弹窗：看交付内容，并在同一页完成通过 / 打回 / 撤回 */
const viewVisible = ref(false)
const viewLoading = ref(false)
const viewTodo = ref<TodoItem | null>(null)
const viewSubmission = ref<TodoSubmissionRecord | null>(null)
const loading = ref(false)
const completionStatusUpdating = ref(false)
const regenerating = ref(false)

/* =========================
   预约信息编辑（仅未开始的正式会议）
   ========================= */

/** 是否还没到开会时间 */
const isUpcoming = computed(() => {
  if (!meeting.value?.scheduledAt) return false

  return new Date(meeting.value.scheduledAt).getTime() > Date.now()
})

/** 只有未开始的正式会议才允许改预约信息 */
const canEditSchedule = computed(() => isUpcoming.value && canEdit.value)

const scheduleDialogVisible = ref(false)
const scheduleSubmitting = ref(false)

const scheduleForm = reactive({
  title: '',
  scheduledAt: '' as string | number | Date | '',
  leaderIds: [] as number[],
  memberIds: [] as number[]
})

const openScheduleDialog = async () => {
  if (!meeting.value) return

  scheduleForm.title = meeting.value.title || ''
  scheduleForm.scheduledAt = meeting.value.scheduledAt
    ? new Date(meeting.value.scheduledAt)
    : ''
  scheduleForm.leaderIds = (meeting.value.leaders ?? []).map((l) => l.id)
  scheduleForm.memberIds = (meeting.value.members ?? []).map((m) => m.id)

  scheduleDialogVisible.value = true

  await loadContacts()
}

const submitSchedule = async () => {
  if (!meeting.value) return

  if (!scheduleForm.scheduledAt) {
    ElMessage.warning('请选择开会时间')
    return
  }

  if (!scheduleForm.leaderIds.length) {
    ElMessage.warning('至少需要一位负责人')
    return
  }

  const when = new Date(scheduleForm.scheduledAt)

  if (Number.isNaN(when.getTime())) {
    ElMessage.warning('开会时间格式不正确')
    return
  }

  scheduleSubmitting.value = true

  try {
    const updated = await updateScheduledMeeting(meeting.value.id, {
      title: scheduleForm.title.trim(),
      scheduledAt: when.toISOString(),
      leaderIds: scheduleForm.leaderIds,
      memberIds: scheduleForm.memberIds
    })

    meeting.value = updated
    scheduleDialogVisible.value = false

    ElMessage.success('预约信息已更新，已通知参会人员')
  } catch (error: any) {
    const message = error?.response?.data?.message ?? '修改失败'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  } finally {
    scheduleSubmitting.value = false
  }
}

const formatScheduledAt = (value?: string | null) => {
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

/* =========================
   置顶
   ========================= */

const pinning = ref(false)

/**
 * 切换置顶状态。
 *
 * 置顶是会议级的便捷标记，与完成状态互不影响；
 * 后端 updatePinned 只改 pinnedAt，不碰待办与状态。
 */
const handleTogglePin = async () => {
  if (!meeting.value) return

  const nextPinned = !meeting.value.pinnedAt

  pinning.value = true

  try {
    const result = await updateMeetingPinned(meeting.value.id, nextPinned)

    meeting.value.pinnedAt = result?.pinnedAt ?? null

    ElMessage.success(nextPinned ? '已置顶' : '已取消置顶')
  } catch (error: any) {
    const message = error?.response?.data?.message ?? '置顶操作失败'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  } finally {
    pinning.value = false
  }
}

/* =========================
   负责人 / 成员 / 录音开放
   ========================= */

/** 通讯录（用于选择负责人与成员） */
const contacts = ref<Contact[]>([])
const contactsLoading = ref(false)

const loadContacts = async () => {
  if (contacts.value.length) return

  contactsLoading.value = true

  try {
    contacts.value = await listContacts()
  } catch {
    contacts.value = []
  } finally {
    contactsLoading.value = false
  }
}

/** 参会人员：名单常驻，增删控件按需展开 */
const attendeesOpen = ref(false)

/** 负责人选择：可一次勾选多位，逐个提交（后端接口按单人添加） */
const leaderAdding = ref(false)
const selectedLeaderIds = ref<number[]>([])

const handleAddLeader = async () => {
  if (!meeting.value || !selectedLeaderIds.value.length) return

  leaderAdding.value = true

  const ids = [...selectedLeaderIds.value]
  const added: number[] = []
  let latest = meeting.value.leaders

  try {
    for (const id of ids) {
      latest = await addMeetingLeader(meeting.value.id, id)
      added.push(id)
    }

    meeting.value.leaders = latest
    selectedLeaderIds.value = []

    ElMessage.success(added.length > 1 ? `已添加 ${added.length} 位负责人` : '负责人已添加')
  } catch (error: any) {
    // 部分成功：先把已加上的同步进名单，选区里只留没加上的，便于改后重试
    meeting.value.leaders = latest
    selectedLeaderIds.value = ids.filter((id) => !added.includes(id))

    const message = error?.response?.data?.message ?? '添加负责人失败'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  } finally {
    leaderAdding.value = false
  }
}

const handleRemoveLeader = async (leader: MemberBrief) => {
  if (!meeting.value) return

  try {
    const leaders = await removeMeetingLeader(meeting.value.id, leader.id)

    meeting.value.leaders = leaders

    ElMessage.success('负责人已移除')
  } catch (error: any) {
    const message = error?.response?.data?.message ?? '移除负责人失败'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  }
}

/** 可添加为负责人的人：排除已是负责人的 */
const leaderCandidates = computed(() => {
  const existing = new Set((meeting.value?.leaders ?? []).map((l) => l.id))

  return contacts.value.filter((c) => !existing.has(c.id))
})

/** 成员选择与增删：同样支持一次勾选多位 */
const memberSelecting = ref(false)
const selectedMemberIds = ref<number[]>([])

const handleAddMember = async () => {
  if (!meeting.value || !selectedMemberIds.value.length) return

  memberSelecting.value = true

  const ids = [...selectedMemberIds.value]
  const added: number[] = []
  let latest = meeting.value.members

  try {
    for (const id of ids) {
      latest = await addMeetingMember(meeting.value.id, id)
      added.push(id)
    }

    meeting.value.members = latest
    selectedMemberIds.value = []

    ElMessage.success(added.length > 1 ? `已添加 ${added.length} 位成员` : '成员已添加')
  } catch (error: any) {
    meeting.value.members = latest
    selectedMemberIds.value = ids.filter((id) => !added.includes(id))

    const message = error?.response?.data?.message ?? '添加成员失败'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  } finally {
    memberSelecting.value = false
  }
}

const handleRemoveMember = async (member: MemberBrief) => {
  if (!meeting.value) return

  try {
    const members = await removeMeetingMember(meeting.value.id, member.id)

    meeting.value.members = members

    ElMessage.success('成员已移除')
  } catch (error: any) {
    const message = error?.response?.data?.message ?? '移除成员失败'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  }
}

/** 可添加为成员的人：排除已在成员里的 */
const memberCandidates = computed(() => {
  const existing = new Set((meeting.value?.members ?? []).map((m) => m.id))

  return contacts.value.filter((c) => !existing.has(c.id))
})

/** 录音开放开关 */
const audioOpenUpdating = ref(false)

const handleAudioOpenChange = async (value: boolean) => {
  if (!meeting.value) return

  audioOpenUpdating.value = true

  try {
    const result = await updateMeetingAudioOpen(meeting.value.id, value)

    /**
     * 开关变化会直接影响当前用户能否收听：
     * 非负责人关闭后自己也将听不到，需要用最新权限刷新页面数据。
     */
    const refreshed = await getMeeting(meeting.value.id)

    meeting.value = refreshed

    ElMessage.success(
      result.audioOpen ? '录音已对成员开放' : '录音已设为不开放'
    )
  } catch (error: any) {
    const message = error?.response?.data?.message ?? '录音开关更新失败'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  } finally {
    audioOpenUpdating.value = false
  }
}

// 打开编辑标题弹窗
const openEditTitle = () => {
  editTitle.value = meeting.value?.title || ''
  editTitleDialogVisible.value = true
}

// 保存会议标题
const handleUpdateTitle = async () => {
  const title = editTitle.value.trim()

  if (!title) {
    ElMessage.warning('会议标题不能为空')
    return
  }

  editTitleSubmitting.value = true

  try {
    await updateMeeting(Number(route.params.id), { title })

    ElMessage.success('会议标题修改成功')
    editTitleDialogVisible.value = false

    await loadMeeting()
  } catch (error) {
    ElMessage.error('修改会议标题失败')
  } finally {
    editTitleSubmitting.value = false
  }
}

const loadMeeting = async () => {
  const id = Number(route.params.id)

  if (!Number.isInteger(id) || id <= 0) {
    ElMessage.error('会议编号无效')
    router.push('/history')
    return
  }

  loading.value = true

  try {
    const detail = await getMeeting(id)

    // 请求期间用户可能又点了另一份纪要：丢弃过期响应，避免旧内容盖住新页面
    if (Number(route.params.id) !== id) {
      return
    }

    meeting.value = detail
  } catch (error) {
    console.error('会议详情加载失败：', error)
    ElMessage.error('会议详情加载失败，请检查后端服务')
  } finally {
    loading.value = false
  }
}

/**
 * 在详情页里点另一份纪要时，路由参数变了但组件会被复用，
 * 不会重新走 onMounted —— 必须显式监听会议编号，否则页面停在上一条。
 */
watch(
  () => route.params.id,
  async (next, previous) => {
    if (!next || next === previous) {
      return
    }

    // 先清空作者上一条记录，避免旧内容与新的编号混在一起
    meeting.value = null
    attendeesOpen.value = false

    await loadMeeting()

    if (canManageMembers.value) {
      await loadContacts()
    }

    // 换了一份纪要，回到纸的顶部
    window.scrollTo({ top: 0, behavior: 'auto' })
  }
)

const formatDate = (date?: string) => {
  if (!date) return '暂无时间'

  const parsed = new Date(date)

  if (Number.isNaN(parsed.getTime())) return '时间格式异常'

  return parsed.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * 待办状态变化后，后端会按“全部完成 → 会议已完成”的规则同步会议状态。
 * 这里把同步结果立即写回本地，避免表头状态与待办列表不一致。
 */
const applyMeetingCompletionStatus = (
  status?: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED'
) => {
  if (!meeting.value || !status) {
    return
  }

  if (meeting.value.completionStatus === status) {
    return
  }

  meeting.value.completionStatus = status

  // 只在“自动变成已完成”时额外提示，避免每次操作都弹消息
  if (status === 'COMPLETED') {
    ElMessage.success('全部待办已完成，会议状态已自动置为「已完成」')
  }
}

/** 更新待办状态并保存到数据库 */
const handleTodoStatusChange = async (
  todo: any,
  status: 'OPEN' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED'
) => {
  if (!todo.id) {
    ElMessage.error('待办 ID 不存在')
    return
  }

  const previousStatus = todo.status

  try {
    const result = await updateTodoStatus(todo.id, status)

    todo.status = status

    applyMeetingCompletionStatus(result?.meetingCompletionStatus)

    ElMessage.success('待办状态更新成功')
  } catch (error: any) {
    todo.status = previousStatus

    console.error(error)

    const message = error?.response?.data?.message ?? '状态更新失败，请重试'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  }
}

/** 验收要点按行拆：空行忽略，最多 20 条（后端也会截断） */
const parseChecklistText = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 20)

const handleCreateTodo = async () => {
  if (!meeting.value) return

  if (!todoForm.value.content.trim()) {
    ElMessage.warning('请输入待办内容')
    return
  }

  todoSubmitting.value = true

  try {
    const created = await createTodo(meeting.value.id, {
      content: todoForm.value.content.trim(),
      assigneeUserId: todoForm.value.assigneeUserId ?? null,
      reviewerId: todoForm.value.reviewerId ?? null,
      deadline: todoForm.value.deadlineAt || undefined,
      deadlineAt: todoForm.value.deadlineAt || undefined
    })

    const items = parseChecklistText(todoForm.value.checklistText)

    if (items.length) {
      await setTodoChecklist(created.id, items)
    }

    ElMessage.success('待办新增成功')

    todoDialogVisible.value = false

    todoForm.value = {
      content: '',
      assigneeUserId: undefined,
      reviewerId: undefined,
      deadlineAt: '',
      checklistText: ''
    }

    await loadMeeting()
  } catch (error) {
    console.error(error)
    ElMessage.error('新增待办失败，请重试')
  } finally {
    todoSubmitting.value = false
  }
}

/** 打开编辑待办弹窗 */
const handleEditTodo = (todo: any) => {
  editTodoForm.value = {
    id: todo.id,
    content: todo.content || '',
    assigneeUserId: todo.assigneeUserId ?? undefined,
    reviewerId: todo.reviewerId ?? undefined,
    deadlineAt: todo.deadlineAt ? todo.deadlineAt.slice(0, 10) : '',
    deadlineTouched: false,
    checklistText: (todo.checklist ?? []).map((item: ChecklistItem) => item.content).join('\n'),
    checklistLocked: todo.status === 'SUBMITTED'
  }

  editTodoDialogVisible.value = true

  void loadContacts()
}

/** 提交待办编辑 */
const handleUpdateTodo = async () => {
  if (!editTodoForm.value.content.trim()) {
    ElMessage.warning('请输入待办内容')
    return
  }

  editTodoSubmitting.value = true

  try {
    // 只有用户真的动过日期才提交截止字段：
    // 老数据可能只有「本周五之前」这种文本、没有 deadline_at，直接回传空值会把它抹掉
    const deadlinePatch = editTodoForm.value.deadlineTouched
      ? {
          deadline: editTodoForm.value.deadlineAt || '',
          deadlineAt: editTodoForm.value.deadlineAt || null
        }
      : {}

    const updated = await updateTodo(editTodoForm.value.id, {
      content: editTodoForm.value.content.trim(),
      assigneeUserId: editTodoForm.value.assigneeUserId ?? null,
      reviewerId: editTodoForm.value.reviewerId ?? null,
      ...deadlinePatch
    })

    if (!editTodoForm.value.checklistLocked) {
      await setTodoChecklist(
        editTodoForm.value.id,
        parseChecklistText(editTodoForm.value.checklistText)
      )
    }

    /**
     * 截止时间是自然语言、又没能解析成具体日期时，必须说清楚。
     * 不说的话，这条待办永远不会触发逾期提醒，
     * 用户只会觉得「到点了怎么没提醒我」。
     */
    if (updated?.deadline && !updated?.deadlineAt) {
      ElMessage.warning(
        `已保存，但「${updated.deadline}」没能解析成具体日期，到期不会提醒`
      )
    } else {
      ElMessage.success('待办修改成功')
    }

    editTodoDialogVisible.value = false

    await loadMeeting()
  } catch (error) {
    console.error(error)
    ElMessage.error('修改失败，请重试')
  } finally {
    editTodoSubmitting.value = false
  }
}

const handleDeleteTodo = async (todo: any) => {
  if (!todo.id) {
    ElMessage.error('待办 ID 不存在')
    return
  }

  try {
    await ElMessageBox.confirm(
      `确定删除待办事项“${todo.content}”吗？`,
      '删除确认',
      {
        confirmButtonText: '确定删除',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )

    await deleteTodo(todo.id)

    ElMessage.success('待办删除成功')

    await loadMeeting()
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') {
      console.error(error)
      ElMessage.error('删除失败，请重试')
    }
  }
}

/* =========================
   交付与验收
   ========================= */

const openSubmitDialog = (todo: TodoItem) => {
  submitTarget.value = todo
  submitNote.value = ''
  submitFiles.value = []
  submitDialogVisible.value = true
}

const handleSubmitTodo = async () => {
  if (!submitTarget.value?.id) return

  submitSubmitting.value = true

  try {
    const result = await submitTodo(
      submitTarget.value.id,
      submitNote.value.trim() || undefined
    )

    applyMeetingCompletionStatus(result?.meetingCompletionStatus)

    // 提交已经成功，附件失败不能把它回滚；失败的文件单独提示，让用户重传
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
        `已提交，${uploaded} 个附件上传成功；${failed.join('、')} 上传失败，可在「记录」里重新提交`
      )
    } else {
      ElMessage.success(
        result?.status === 'ACCEPTED'
          ? '已提交，验收人是你本人，按通过处理'
          : uploaded
            ? `已提交，${uploaded} 个附件已上传，等待验收`
            : '已提交，等待验收'
      )
    }

    submitDialogVisible.value = false
    submitFiles.value = []

    await loadMeeting()
  } catch (error: any) {
    const message = error?.response?.data?.message ?? '提交失败，请重试'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  } finally {
    submitSubmitting.value = false
  }
}

/** 下载交付物：接口要鉴权，走 blob 而不是直接开链接 */
const handleDownloadAttachment = async (url: string, fileName: string) => {
  try {
    await downloadSubmissionAttachment(url, fileName)
  } catch {
    ElMessage.error('附件下载失败，请重试')
  }
}

/* ---------- 提交详情 ---------- */

const openSubmissionView = async (todo: TodoItem) => {
  if (!todo.id) return

  viewTodo.value = todo
  viewSubmission.value = null
  viewVisible.value = true
  viewLoading.value = true

  try {
    const rows = await listTodoSubmissions(todo.id)
    viewSubmission.value = rows[0] ?? null
  } catch (error: any) {
    const message = error?.response?.data?.message ?? '提交详情加载失败'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  } finally {
    viewLoading.value = false
  }
}

const acceptFromView = () => {
  if (viewTodo.value) void handleAcceptSubmission(viewTodo.value)
}

const rejectFromView = () => {
  if (viewTodo.value) void handleRejectSubmission(viewTodo.value)
}

const withdrawFromView = () => {
  if (viewTodo.value) void handleWithdrawSubmission(viewTodo.value)
}

/** 在「查看」弹窗里直接勾验收要点 */
const toggleCheckInView = async (item: ChecklistItem, done: boolean) => {
  const todo = viewTodo.value

  if (!todo?.id) return

  checklistSavingId.value = item.id

  try {
    await toggleTodoCheckItem(todo.id, item.id, done)
    await loadMeeting()

    const fresh = meeting.value?.todos?.find((row) => row.id === todo.id)

    if (fresh) viewTodo.value = fresh
  } catch (error: any) {
    const message = error?.response?.data?.message ?? '更新验收要点失败'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  } finally {
    checklistSavingId.value = null
  }
}

/* ---------- 验收要点 ---------- */

const openChecklist = (todo: TodoItem) => {
  checklistTodo.value = todo
  checklistVisible.value = true
}

const handleToggleCheckItem = async (item: ChecklistItem, done: boolean) => {
  const todo = checklistTodo.value

  if (!todo?.id) return

  checklistSavingId.value = item.id

  try {
    await toggleTodoCheckItem(todo.id, item.id, done)

    // 重新拉一次，保证行上的「3/5」与弹窗里的勾选状态一致
    await loadMeeting()
    checklistTodo.value = meeting.value?.todos?.find((row) => row.id === todo.id) ?? null
  } catch (error: any) {
    const message = error?.response?.data?.message ?? '更新验收要点失败'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  } finally {
    checklistSavingId.value = null
  }
}

/** 验收通过 */
const handleAcceptSubmission = async (todo: TodoItem) => {
  const submissionId = todo.latestSubmission?.id

  if (!submissionId) return

  try {
    await ElMessageBox.confirm(
      `确认「${todo.content}」的交付已符合要求？通过后这条待办将标记为已完成。`,
      '验收通过',
      {
        confirmButtonText: '确认通过',
        cancelButtonText: '再看看',
        type: 'success'
      }
    )

    const result = await acceptSubmission(submissionId)

    applyMeetingCompletionStatus(result?.meetingCompletionStatus)

    ElMessage.success(
      result?.uncheckedChecklist
        ? `已验收通过，另有 ${result.uncheckedChecklist} 条验收要点未勾选`
        : '已验收通过'
    )

    viewVisible.value = false

    await loadMeeting()
  } catch (error: any) {
    if (error === 'cancel' || error === 'close') return

    const message = error?.response?.data?.message ?? '验收失败，请重试'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  }
}

/** 打回：原因必填 */
const handleRejectSubmission = async (todo: TodoItem) => {
  const submissionId = todo.latestSubmission?.id

  if (!submissionId) return

  try {
    const { value } = await ElMessageBox.prompt(
      `打回「${todo.content}」并说明原因（至少 5 个字）。待办会退回「进行中」。`,
      '打回交付',
      {
        confirmButtonText: '确认打回',
        cancelButtonText: '取消',
        inputType: 'textarea',
        inputPlaceholder: '例如：缺少接口联调记录，请补充后重新提交',
        inputValidator: (input: string) =>
          (input ?? '').trim().length >= 5 || '请填写至少 5 个字的原因'
      }
    )

    const result = await rejectSubmission(submissionId, value.trim())

    applyMeetingCompletionStatus(result?.meetingCompletionStatus)
    ElMessage.success('已打回，待办退回进行中')

    viewVisible.value = false

    await loadMeeting()
  } catch (error: any) {
    if (error === 'cancel' || error === 'close') return

    const message = error?.response?.data?.message ?? '打回失败，请重试'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  }
}

/** 撤回提交 */
const handleWithdrawSubmission = async (todo: TodoItem) => {
  const submissionId = todo.latestSubmission?.id

  if (!submissionId) return

  try {
    await ElMessageBox.confirm('撤回后待办回到「进行中」，可以修改后重新提交。', '撤回提交', {
      confirmButtonText: '确认撤回',
      cancelButtonText: '取消',
      type: 'warning'
    })

    const result = await withdrawSubmission(submissionId)

    applyMeetingCompletionStatus(result?.meetingCompletionStatus)
    ElMessage.success('已撤回')

    viewVisible.value = false

    await loadMeeting()
  } catch (error: any) {
    if (error === 'cancel' || error === 'close') return

    const message = error?.response?.data?.message ?? '撤回失败，请重试'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  }
}

/** 打开记录：提交内容 + 待办流转 + 会议状态变更，合成一条时间线 */
const openTimeline = async (todo: TodoItem) => {
  if (!todo.id) return

  timelineTodo.value = todo
  timelineVisible.value = true
  timelineLoading.value = true
  submissions.value = []
  todoEvents.value = []
  meetingEvents.value = []

  try {
    const [submissionRows, eventRows, meetingRows] = await Promise.all([
      listTodoSubmissions(todo.id),
      listTodoEvents(todo.id),
      meeting.value?.id ? listMeetingEvents(meeting.value.id) : Promise.resolve([]),
    ])

    submissions.value = submissionRows
    todoEvents.value = eventRows
    meetingEvents.value = meetingRows
  } catch (error: any) {
    const message = error?.response?.data?.message ?? '记录加载失败'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  } finally {
    timelineLoading.value = false
  }
}

/** 时间线条目：待办事件与会议事件混排，按时间倒序 */
interface TimelineEntry {
  key: string
  /** todo = 待办流转，meeting = 会议状态变更 */
  scope: 'todo' | 'meeting'
  type: string
  actor: { id: number; name: string } | null
  createdAt: string
  fromStatus: string | null
  toStatus: string | null
  /** 关联的提交（带说明、附件、打回原因） */
  submission: TodoSubmissionRecord | null
}

const timelineEntries = computed<TimelineEntry[]>(() => {
  const submissionById = new Map(submissions.value.map((row) => [row.id, row]))

  const entries: TimelineEntry[] = [
    ...todoEvents.value.map((row) => ({
      key: `todo-${row.id}`,
      scope: 'todo' as const,
      type: row.type,
      actor: row.actor,
      createdAt: row.createdAt,
      fromStatus: row.fromStatus,
      toStatus: row.toStatus,
      submission: row.submissionId
        ? submissionById.get(row.submissionId) ?? null
        : null,
    })),
    ...meetingEvents.value.map((row) => ({
      key: `meeting-${row.id}`,
      scope: 'meeting' as const,
      type: row.type,
      actor: row.actor,
      createdAt: row.createdAt,
      fromStatus: row.fromStatus,
      toStatus: row.toStatus,
      submission: null,
    })),
  ]

  return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
})

/** 事件标签：短词，一眼看清发生了什么 */
const eventLabel = (entry: TimelineEntry) => {
  if (entry.scope === 'meeting') return '会议状态'

  switch (entry.type) {
    case 'created':
      return '创建'
    case 'submitted':
      return '提交'
    case 'withdrawn':
      return '撤回'
    case 'rejected':
      return '打回'
    case 'accepted':
      return '通过'
    case 'reopened':
      return '重开'
    case 'assigned':
      return '改派'
    case 'deadline_changed':
      return '改期'
    case 'checklist_updated':
      return '改要点'
    case 'updated':
      return '编辑'
    default:
      return '状态变更'
  }
}

const eventTagType = (entry: TimelineEntry) => {
  if (entry.scope === 'meeting') return 'info'

  switch (entry.type) {
    case 'accepted':
      return 'success'
    case 'rejected':
      return 'danger'
    case 'withdrawn':
      return 'info'
    case 'submitted':
      return 'warning'
    default:
      return 'info'
  }
}

/** 事件说明：把类型翻成一句人话，带上状态变化 */
const eventText = (entry: TimelineEntry) => {
  if (entry.scope === 'meeting') {
    const from = statusText(entry.fromStatus)
    const to = statusText(entry.toStatus)

    return `把会议状态从「${from}」改为「${to}」`
  }

  switch (entry.type) {
    case 'created':
      return '创建了这条待办'
    case 'submitted':
      return entry.submission
        ? `提交了第 ${entry.submission.attemptNo} 次交付`
        : '提交了交付'
    case 'withdrawn':
      return '撤回了提交'
    case 'rejected':
      return '打回了交付'
    case 'accepted':
      return '验收通过'
    case 'reopened':
      return '把待办重新打开'
    case 'assigned':
      return '调整了负责人或验收人'
    case 'deadline_changed':
      return '修改了截止时间'
    case 'checklist_updated':
      return '更新了验收要点'
    case 'updated':
      return '修改了待办内容'
    default:
      return `把状态从「${todoStatusText(entry.fromStatus)}」改为「${todoStatusText(entry.toStatus)}」`
  }
}

const submissionStatusText = (status: string) => {
  switch (status) {
    case 'ACCEPTED':
      return '已通过'
    case 'REJECTED':
      return '已打回'
    case 'WITHDRAWN':
      return '已撤回'
    default:
      return '待验收'
  }
}

const submissionStatusType = (status: string) => {
  switch (status) {
    case 'ACCEPTED':
      return 'success'
    case 'REJECTED':
      return 'danger'
    case 'WITHDRAWN':
      return 'info'
    default:
      return 'warning'
  }
}

/** 重新生成当前会议的 AI 纪要 */
const handleRegenerate = async () => {
  if (!meeting.value) {
    return
  }

  try {
    await ElMessageBox.confirm(
      'AI 纪要生成失败，是否根据原始会议内容重新生成？',
      '重新生成确认',
      {
        confirmButtonText: '重新生成',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )

    regenerating.value = true

    const updatedMeeting = await regenerateMeeting(
      meeting.value.id
    )

    meeting.value = updatedMeeting

    ElMessage.success('会议纪要重新生成成功')
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') {
      console.error('重新生成失败：', error)
      ElMessage.error('重新生成失败，请稍后重试')
    }
  } finally {
    regenerating.value = false
  }
}

/** 手动修改会议完成状态 */
const handleCompletionStatusChange = async (
  status:
    | 'NOT_STARTED'
    | 'IN_PROGRESS'
    | 'COMPLETED'
    | 'CANCELLED'
) => {
  if (!meeting.value) {
    return
  }

  const previousStatus =
    meeting.value.completionStatus

  meeting.value.completionStatus = status
  completionStatusUpdating.value = true

  try {
    await updateMeetingCompletionStatus(
      meeting.value.id,
      status
    )

    ElMessage.success('会议状态更新成功')
  } catch (error) {
    console.error(
      '会议状态更新失败：',
      error
    )

    meeting.value.completionStatus =
      previousStatus

    ElMessage.error(
      '会议状态更新失败，请重试'
    )
  } finally {
    completionStatusUpdating.value = false
  }
}

/**
 * 返回上一级。
 *
 * 从历史会议进来就回历史会议，从收件箱进来就回收件箱 ——
 * 用路由记录的上一页路径，而不是写死 /history。
 * 直接打开详情页（无上一级）时兜底回历史列表。
 */
const goBack = () => {
  const back = (window.history.state as { back?: string } | null)?.back

  if (typeof back === 'string' && back.startsWith('/')) {
    router.back()
    return
  }

  router.push('/history')
}

/* =========================
   纯展示：页眉、待办台账、原文摘要
   ========================= */

/** 文号：MM-年份-三位编号，年份取会议的预约或创建时间 */
const docNo = computed(() => {
  if (!meeting.value) return '—'

  const source = meeting.value.scheduledAt || meeting.value.createdAt
  const parsed = source ? new Date(source) : null

  const year =
    parsed && !Number.isNaN(parsed.getTime())
      ? String(parsed.getFullYear())
      : '—'

  return `MM-${year}-${String(meeting.value.id).padStart(3, '0')}`
})

/** 页眉时间：yyyy-mm-dd hh:mm，取不到时显示 — */
const formatWhen = (value?: string | null) => {
  if (!value) return '—'

  const parsed = new Date(value)

  if (Number.isNaN(parsed.getTime())) return '—'

  const pad = (part: number) => String(part).padStart(2, '0')

  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`
}

/** 参会人数：负责人与成员按账号去重，避免同一个人算两次 */
const attendeeCount = computed(() => {
  const seen = new Set<number>()

  for (const person of [
    ...(meeting.value?.leaders ?? []),
    ...(meeting.value?.members ?? [])
  ]) {
    seen.add(person.id)
  }

  return seen.size
})

/** 负责人一行：多位用顿号连起来，取不到显示 — */
const leadersLine = computed(
  () =>
    (meeting.value?.leaders ?? [])
      .map((leader) => leader.name)
      .join('、') || '—'
)

/** 会议状态文字：未开始 / 进行中 / 已完成 / 已取消 */
const statusText = (status?: string | null) => {
  switch (status) {
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

/** 会议状态 → 视觉修饰词，颜色由 style.css 的 .m-status--* 提供 */
const statusKey = (status?: string | null) => {
  switch (status) {
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

/** 待办状态文字，取法与 MeetingResult 一致 */
const todoStatusText = (status?: string | null) => {
  switch (status) {
    case 'COMPLETED':
      return '已完成'
    case 'IN_PROGRESS':
      return '进行中'
    case 'SUBMITTED':
      return '待验收'
    case 'CANCELLED':
      return '已取消'
    default:
      return '待处理'
  }
}

/**
 * 待办状态色与会议状态共用一套调色板（style.css 的 --status-*）：
 * 待处理=wait、进行中/待验收=live、已完成=done、已取消=cancel。
 */
const todoStatusKey = (status?: string) => {
  switch (status) {
    case 'IN_PROGRESS':
      return 'live'
    case 'SUBMITTED':
      return 'review'
    case 'COMPLETED':
      return 'done'
    case 'CANCELLED':
      return 'cancel'
    default:
      return 'wait'
  }
}

/** 负责人能选的状态：有验收人时不能直接勾完成 */
/**
 * 可切换的待办状态。
 *
 * 「已完成」对所有人放开：有验收人时，验收人勾完成等于给出结论，
 * 会议负责人勾完成则视为代完成（后端会写审计）。
 * 「待验收」永远不在列表里 —— 必须走提交，否则交付记录是空的。
 */
const todoStatusOptions = () => {
  const options: Array<{ value: 'OPEN' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED'; label: string }> = [
    { value: 'OPEN', label: '待处理' },
    { value: 'IN_PROGRESS', label: '进行中' },
    { value: 'COMPLETED', label: '已完成' },
    { value: 'CANCELLED', label: '已取消' },
  ]

  return options
}

/** 待办完成度：已完成 / 总数，另标注待验收 */
const todoSummary = computed(() => {
  const todos = meeting.value?.todos ?? []

  if (!todos.length) return '—'

  const done = todos.filter((todo) => todo.status === 'COMPLETED').length
  const pending = todos.filter(
    (todo) => todo.status === 'SUBMITTED'
  ).length

  return pending
    ? `${done} / ${todos.length} 项已完成 · ${pending} 项待验收`
    : `${done} / ${todos.length} 项已完成`
})

/** 原文篇幅；有录音时补一句可回听 */
const contentSummary = computed(() => {
  const content = meeting.value?.content

  if (!content) return '—'

  return meeting.value?.audioUrl
    ? `${content.length} 字 · 可回听`
    : `${content.length} 字`
})

/** 回听按钮的落点：只是把录音条滚进视野，不触发播放 */
const audioAnchor = ref<HTMLElement | null>(null)

const scrollToAudio = () => {
  audioAnchor.value?.scrollIntoView({ block: 'center' })
}

/** 导出 Markdown 纪要：后端给 filename + content，这里造 Blob 触发下载 */
const exporting = ref(false)

const handleExport = async () => {
  if (!meeting.value) return

  exporting.value = true

  try {
    const { filename, content } = await exportMeetingMarkdown(meeting.value.id)
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')

    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)

    ElMessage.success('已导出 Markdown 纪要')
  } catch (error) {
    console.error('导出失败：', error)
    ElMessage.error('导出失败，请稍后重试')
  } finally {
    exporting.value = false
  }
}

onMounted(async () => {
  await loadMeeting()

  // 只有能管理成员时才需要通讯录，避免无权用户多打一次接口
  if (canManageMembers.value) {
    await loadContacts()
  }
})
</script>

<template>
  <div v-loading="loading" class="page">
    <div class="page-narrow">
      <!-- 回到上一页：一行文字链接，不占一条导航 -->
      <div class="back-row">
        <el-button link @click="goBack">
          ‹ 回到上一页
        </el-button>
      </div>

      <template v-if="meeting">
        <!-- 只读共享者会看到这一条，避免误以为是页面坏了 -->
        <p v-if="isReadOnly" class="note note-top">
          这份纪要由会议拥有者共享给你，只能查看。需要修改，请联系拥有者调整权限。
        </p>

        <!-- 一张纪要纸：页眉五栏、操作栏、标题与印、朱线、摘要与决策、待办、原文、人员 -->
        <article class="sheet minutes">
          <!-- 页眉：五栏字段，只靠竖栏线分栏 -->
          <header class="meta-band">
            <div class="field">
              <span class="field-k">会议时间</span>

              <span class="field-v num" :title="formatWhen(meeting.scheduledAt || meeting.createdAt)">
                {{ formatWhen(meeting.scheduledAt || meeting.createdAt) }}
              </span>
            </div>

            <div class="field">
              <span class="field-k">参会人数</span>

              <span class="field-v num">
                {{ attendeeCount ? attendeeCount + ' 人' : '—' }}
              </span>
            </div>

            <div class="field">
              <span class="field-k">负责人</span>

              <span class="field-v field-name" :title="leadersLine">
                <template v-if="meeting.leaders?.length">
                  <template v-for="(leader, index) in meeting.leaders" :key="`meta-leader-${leader.id}`">
                    <button type="button" class="name-link" @click="openProfile(leader.id)">{{ leader.name }}</button>
                    <span v-if="index < (meeting.leaders?.length ?? 0) - 1">、</span>
                  </template>
                </template>
                <template v-else>—</template>
              </span>
            </div>

            <div class="field">
              <span class="field-k">文号</span>

              <span class="field-v num">{{ docNo }}</span>
            </div>

            <div class="field">
              <span class="field-k">状态</span>

              <div class="field-v field-status">
                <span v-if="!canEdit" class="m-status" :class="`m-status--${statusKey(meeting.completionStatus)}`">
                  <i class="m-status-dot" />

                  {{ statusText(meeting.completionStatus) }}
                </span>

                <!-- 能改状态的人在这里直接改，与历史登记簿同一套标记 -->
                <el-dropdown v-else trigger="click" placement="bottom-end"
                  @command="(status: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED') => handleCompletionStatusChange(status)">
                  <button type="button" class="m-status" :class="`m-status--${statusKey(meeting.completionStatus)}`"
                    :disabled="completionStatusUpdating"
                    :aria-label="`会议状态：${statusText(meeting.completionStatus)}，点击修改`">
                    <i class="m-status-dot" />

                    {{ statusText(meeting.completionStatus) }}

                    <span class="m-status-caret" aria-hidden="true" />
                  </button>

                  <template #dropdown>
                    <el-dropdown-menu>
                      <el-dropdown-item v-for="option in [
                        { label: '未开始', value: 'NOT_STARTED' },
                        { label: '进行中', value: 'IN_PROGRESS' },
                        { label: '已完成', value: 'COMPLETED' },
                        { label: '已取消', value: 'CANCELLED' }
                      ]" :key="option.value" :command="option.value">
                        <span class="m-status" :class="`m-status--${statusKey(option.value)}`">
                          <i class="m-status-dot" />

                          {{ option.label }}
                        </span>
                      </el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
              </div>
            </div>
          </header>

          <!-- 参会人员与录音开放：放在标题上方，先看人，再看事 -->
          <section class="sec sec-attendees">
            <div class="sec-h">
              <span class="sec-t">参会人员</span>

              <span class="sec-x">
                负责人 {{ meeting.leaders?.length ?? 0 }} 位，成员 {{ meeting.members?.length ?? 0 }} 位
              </span>

              <!-- 名单常驻，增删控件收在“管理”里，免得把标题压得太低 -->
              <el-button v-if="canManageMembers" link class="sec-add" @click="attendeesOpen = !attendeesOpen">
                {{ attendeesOpen ? '收起' : '管理' }}
              </el-button>
            </div>

            <!-- 名单：同一身份排一行，人员以可移除的小签铺在同一区域内 -->
            <div class="member-line">
              <span class="member-k">负责人</span>

              <div class="member-chips">
                <!-- × 只在「管理」展开时出现：收起态是只读名单，避免误删 -->
                <el-tag v-for="leader in meeting.leaders ?? []" :key="`leader-${leader.id}`" type="info" effect="plain"
                  class="member-chip"
                  :closable="attendeesOpen && canManageMembers && (meeting.leaders?.length ?? 0) > 1"
                  @close="handleRemoveLeader(leader)">
                  <span class="member-name name-link" role="button" tabindex="0"
                    :title="`查看 ${leader.name} 的个人主页`" @click.stop="openProfile(leader.id)"
                    @keydown.enter.prevent="openProfile(leader.id)">{{ leader.name }}</span>
                  <span class="member-phone num">{{ leader.phone }}</span>
                </el-tag>

                <span v-if="!meeting.leaders?.length" class="chip-empty">
                  还没有指定负责人
                </span>
              </div>
            </div>

            <div class="member-line">
              <span class="member-k">成员</span>

              <div class="member-chips">
                <el-tag v-for="member in meeting.members ?? []" :key="`member-${member.id}`" type="info" effect="plain"
                  class="member-chip" :closable="attendeesOpen && canManageMembers" @close="handleRemoveMember(member)">
                  <span class="member-name name-link" role="button" tabindex="0"
                    :title="`查看 ${member.name} 的个人主页`" @click.stop="openProfile(member.id)"
                    @keydown.enter.prevent="openProfile(member.id)">{{ member.name }}</span>
                  <span class="member-phone num">{{ member.phone }}</span>
                </el-tag>

                <span v-if="!meeting.members?.length" class="chip-empty">
                  还没有添加参会成员
                </span>
              </div>
            </div>

            <template v-if="attendeesOpen">
              <div v-if="canManageMembers" class="member-add">
                <el-select v-model="selectedLeaderIds" multiple collapse-tags collapse-tags-tooltip size="small"
                  placeholder="添加负责人（可多选）" filterable class="member-select" :loading="contactsLoading"
                  @focus="loadContacts">
                  <el-option v-for="c in leaderCandidates" :key="c.id" :label="`${c.name}（${c.phone}）`"
                    :value="c.id" />
                </el-select>

                <el-button type="primary" size="small" :loading="leaderAdding" :disabled="!selectedLeaderIds.length"
                  @click="handleAddLeader">
                  添加负责人
                </el-button>
              </div>

              <div v-if="canManageMembers" class="member-add">
                <el-select v-model="selectedMemberIds" multiple collapse-tags collapse-tags-tooltip size="small"
                  placeholder="选择要添加的成员（可多选）" filterable class="member-select" :loading="contactsLoading"
                  @focus="loadContacts">
                  <el-option v-for="c in memberCandidates" :key="c.id" :label="`${c.name}（${c.phone}）`"
                    :value="c.id" />
                </el-select>

                <el-button type="primary" size="small" :loading="memberSelecting" :disabled="!selectedMemberIds.length"
                  @click="handleAddMember">
                  添加成员
                </el-button>
              </div>
            </template>

            <!-- 录音开放：只有负责人 / 创建者 / 超管能改 -->
            <div v-if="meeting.hasAudio || canToggleAudio" class="audio-open">
              <div class="audio-open-main">
                <span class="audio-open-k">录音开放</span>

                <span class="audio-open-d">
                  关闭后只有负责人、会议创建者与超级管理员可以收听。
                </span>
              </div>

              <el-switch v-if="canToggleAudio" :model-value="meeting.audioOpen" :loading="audioOpenUpdating"
                active-text="开放" inactive-text="不开放" @change="(v: boolean) => handleAudioOpenChange(v)" />

              <el-tag v-else size="small" :type="meeting.audioOpen ? 'success' : 'info'">
                {{ meeting.audioOpen ? '已开放' : '未开放' }}
              </el-tag>
            </div>
          </section>

          <!-- 操作栏：信息在左、操作在右，放在标题上方方便直接够到 -->
          <footer class="foot">
            <div class="foot-meta">
              <span>创建于 {{ formatDate(meeting.createdAt) }}</span>

              <span v-if="meeting.scheduledAt">
                预约 {{ formatScheduledAt(meeting.scheduledAt) }}（{{ isUpcoming ? '未开始' : '已到时间' }}）
              </span>

              <span v-if="!meeting.isOwner">他人共享</span>

              <span v-if="meeting.pinnedAt" class="foot-pin">已置顶</span>

              <span v-if="meeting.externalCode" class="num">会议号 {{ meeting.externalCode }}</span>
            </div>

            <div class="foot-actions">
              <!-- 从平台同步来的会议，入会链接是最常用的入口，放最前 -->
              <el-button v-if="meeting.externalJoinUrl" type="primary" @click="joinPlatformMeeting">
                进入会议
              </el-button>

              <!-- 追问放最前：看完纪要最想做的事是先问一句，而不是导出 -->
              <el-button @click="askDrawerVisible = true">
                问这场会
              </el-button>

              <el-button v-if="canListenAudio && meeting.audioUrl" @click="scrollToAudio">
                回听录音
              </el-button>

              <el-button :loading="exporting" @click="handleExport">
                导出纪要
              </el-button>

              <el-button v-if="canShare" @click="shareDialogVisible = true">
                共享
              </el-button>

              <el-button v-if="canEdit" @click="openEditTitle">
                编辑标题
              </el-button>

              <el-button v-if="canEditSchedule" @click="openScheduleDialog">
                编辑预约信息
              </el-button>

              <el-button v-if="canEdit" :loading="pinning" @click="handleTogglePin">
                {{ meeting.pinnedAt ? '取消置顶' : '置顶' }}
              </el-button>

              <el-button v-if="meeting.isDraft && canEdit" type="warning" :loading="regenerating"
                @click="handleRegenerate">
                重新生成纪要
              </el-button>
            </div>
          </footer>

          <!-- 标题行：宋体大字；只有已完成的会议才盖章 -->
          <div class="title-row">
            <h1 class="doc-title">
              {{ meeting.title || `会议 #${meeting.id}` }}
            </h1>

            <span v-if="meeting.completionStatus === 'COMPLETED'" class="stamp">
              已归档
            </span>
          </div>

          <div class="red-rule" />

          <!-- 摘要与「一 核心决策」复用 MeetingResult 的排法 -->
          <div class="minutes-body">
            <MeetingResultComponent :result="meeting" />
          </div>

          <!-- 二 待办事项：能改的人直接改，按台账行排 -->
          <section class="sec">
            <div class="sec-h">
              <span class="sec-n">二</span>
              <span class="sec-t">待办事项</span>
              <span class="sec-x">{{ todoSummary }}</span>

              <el-button v-if="canEdit" link class="sec-add" @click="todoDialogVisible = true">
                新增待办
              </el-button>
            </div>

            <template v-if="meeting.todos?.length">
              <!-- 列头：每栏是什么只在这里说明一次 -->
              <div class="todo-head">
                <span class="todo-no" />

                <span class="todo-text">任务</span>
                <span class="todo-owner">负责人</span>
                <span class="todo-reviewer">验收人</span>
                <span class="todo-due">截止</span>
                <span class="todo-state">状态</span>
                <span class="todo-ops" />
              </div>

              <ul class="todo-lines">
                <li v-for="(todo, index) in meeting.todos ?? []" :key="todo.id ?? index" class="todo-line">
                  <span class="todo-no num">{{ index + 1 }}</span>

                  <span class="todo-text">
                    <span class="todo-title">
                      {{ todo.content }}
                      <el-tooltip v-if="todo.latestSubmission?.status === 'REJECTED'"
                        :content="todo.latestSubmission.rejectReason || '交付被打回'" placement="top">
                        <el-tag size="small" type="danger" effect="plain" class="todo-flag">
                          被打回
                        </el-tag>
                      </el-tooltip>

                      <el-button v-if="(todo.checklistTotal ?? 0) > 0" link class="checklist-link"
                        @click="openChecklist(todo)">
                        验收要点 {{ todo.checklistDone }}/{{ todo.checklistTotal }}
                      </el-button>
                    </span>

                    <!-- 编辑贴着任务右侧，和任务文字同一行垂直居中 -->
                    <el-button v-if="canEdit" link class="todo-edit" @click="handleEditTodo(todo)">
                      编辑
                    </el-button>
                  </span>

                  <span class="todo-owner">
                    <button v-if="todo.assigneeUserId" type="button" class="name-link"
                      @click="openProfile(todo.assigneeUserId)">
                      {{ todo.assigneeName || todo.assignee || '未指定' }}
                    </button>
                    <template v-else>{{ todo.assigneeName || todo.assignee || '未指定' }}</template>
                  </span>

                  <span class="todo-reviewer">
                    <button v-if="todo.reviewerId" type="button" class="name-link" @click="openProfile(todo.reviewerId)">
                      {{ todo.reviewerName || '未指定' }}
                    </button>
                    <template v-else>{{ todo.reviewerName || '未指定' }}</template>
                  </span>

                  <span class="todo-due num" :class="{ overdue: todo.overdue }">
                    {{ todo.deadline || '未指定' }}

                    <span v-if="todo.overdue" class="due-flag">逾期</span>

                    <!-- 有截止文本却解析不出日期：到期不会提醒，得让用户看见 -->
                    <el-tooltip v-else-if="todo.deadline && !todo.deadlineAt"
                      content="这句截止时间是自然语言，没能解析成具体日期，到期不会提醒。点「编辑」选一个日期。"
                      placement="top">
                      <span class="due-flag due-flag-soft">未确认</span>
                    </el-tooltip>
                  </span>

                  <span class="todo-state">
                    <!-- 待验收：状态由验收动作决定，不允许手动改 -->
                    <el-tooltip v-if="todo.status === 'SUBMITTED'" placement="top"
                      :content="todo.reviewerName ? `等待 ${todo.reviewerName} 验收` : '等待验收'">
                      <span class="m-status" :class="`m-status--${todoStatusKey(todo.status)}`">
                        <i class="m-status-dot" />
                        待验收
                      </span>
                    </el-tooltip>

                    <!-- 能改状态的只有负责人；其他人只看标签 -->
                    <span v-else-if="!todo.canChangeStatus" class="m-status"
                      :class="`m-status--${todoStatusKey(todo.status)}`">
                      <i class="m-status-dot" />
                      {{ todoStatusText(todo.status) }}
                    </span>

                    <!-- 负责人：同一枚标记，点开就是状态菜单 -->
                    <el-dropdown v-else trigger="click" placement="bottom-end"
                      @command="(status: 'OPEN' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED') => handleTodoStatusChange(todo, status)">
                      <button type="button" class="m-status" :class="`m-status--${todoStatusKey(todo.status)}`"
                        :aria-label="`待办状态：${todoStatusText(todo.status)}，点击修改`">
                        <i class="m-status-dot" />
                        {{ todoStatusText(todo.status) }}
                        <span class="m-status-caret" aria-hidden="true" />
                      </button>

                      <template #dropdown>
                        <el-dropdown-menu>
                          <el-dropdown-item v-for="option in todoStatusOptions()" :key="option.value"
                            :command="option.value">
                            <span class="m-status" :class="`m-status--${todoStatusKey(option.value)}`">
                              <i class="m-status-dot" />
                              {{ option.label }}
                            </span>
                          </el-dropdown-item>
                        </el-dropdown-menu>
                      </template>
                    </el-dropdown>
                  </span>

                  <span class="todo-ops">
                    <!-- 通过 / 打回放在「查看」弹窗里；只有相关人才能看提交内容 -->
                    <el-button v-if="todo.latestSubmission && todo.canViewSubmissionContent" link type="primary"
                      @click="openSubmissionView(todo)">
                      查看
                    </el-button>

                    <el-button v-if="todo.canSubmit" link type="primary" @click="openSubmitDialog(todo)">
                      提交
                    </el-button>

                    <!-- 撤回移入「提交详情」弹窗，行内不再单独展示；记录对每条待办都可见 -->
                    <el-button link @click="openTimeline(todo)">
                      记录
                    </el-button>

                    <!-- 删除收成一个 ×，放在最末，避免和常用操作抢注意力 -->
                    <el-button v-if="canEdit" link class="todo-remove" title="删除待办" aria-label="删除待办"
                      @click="handleDeleteTodo(todo)">
                      ×
                    </el-button>
                  </span>
                </li>
              </ul>
            </template>

            <p v-else class="empty-line">
              {{ canEdit
                ? '这场会议还没有待办。要做的事，点「新增待办」记一条。'
                : '这场会议没有留下待办。' }}
            </p>
          </section>

          <!-- 三 会议原文 -->
          <section class="sec">
            <div class="sec-h">
              <span class="sec-n">三</span>
              <span class="sec-t">会议原文</span>
              <span class="sec-x">{{ contentSummary }}</span>
            </div>

            <p class="prose raw-text">
              {{ meeting.content || '这场会议没有留下原文。' }}
            </p>

            <p v-if="audioBlocked" class="note">
              录音没有对成员开放，你现在听不到。需要回听，请联系会议负责人或创建者开启录音开放。
            </p>

            <div v-else-if="canListenAudio" ref="audioAnchor" class="audio-strip">
              <MeetingAudioPlayer :audio-url="meeting.audioUrl" :duration-sec="meeting.audioDurationSec" />
            </div>
          </section>

        </article>
      </template>

      <div v-else-if="!loading" class="blank">
        <!-- 会议不存在或无权查看：说明发生了什么，并给出下一步 -->
        <p class="blank-title">
          没有找到这份纪要
        </p>

        <p class="blank-desc">
          它可能已被删除，或你对这场会议没有查看权限。回到历史会议再试一次。
        </p>

        <el-button class="blank-action" type="primary" @click="goBack">
          回到历史会议
        </el-button>
      </div>
    </div>
  </div>

  <!-- 共享：弹窗外壳由全局样式统一，内容由 MeetingShareDialog 承担 -->
  <MeetingShareDialog v-if="meeting" v-model="shareDialogVisible" :meeting-id="meeting.id"
    :meeting-title="meeting.title || `会议 #${meeting.id}`" />

  <!-- 追问：只读问答，回答不回写会议数据 -->
  <MeetingAskDrawer v-if="meeting" v-model="askDrawerVisible" :meeting-id="meeting.id"
    :meeting-title="meeting.title || `会议 #${meeting.id}`" />

  <!-- 个人主页：点任何一个人名都能打开 -->
  <UserProfileDialog v-model="profileVisible" :user-id="profileUserId" />

  <el-dialog v-model="scheduleDialogVisible" title="编辑预约信息" width="520px">
    <p class="note note-flat">
      保存后会立即通知全部参会人员。会议一旦到达开会时间，就不能再改时间与人员。
    </p>

    <el-form label-width="96px">
      <el-form-item label="会议标题">
        <el-input v-model="scheduleForm.title" maxlength="200" placeholder="会议标题" />
      </el-form-item>

      <el-form-item label="开会时间">
        <el-date-picker v-model="scheduleForm.scheduledAt" type="datetime" placeholder="选择开会时间"
          format="YYYY-MM-DD HH:mm" style="width: 100%" />
      </el-form-item>

      <el-form-item label="负责人">
        <el-select v-model="scheduleForm.leaderIds" multiple filterable placeholder="选择负责人"
          :loading="contactsLoading" style="width: 100%">
          <el-option v-for="c in contacts" :key="c.id" :label="`${c.name}（${c.phone}）`" :value="c.id" />
        </el-select>
      </el-form-item>

      <el-form-item label="参会成员">
        <el-select v-model="scheduleForm.memberIds" multiple filterable placeholder="选择参会成员"
          :loading="contactsLoading" style="width: 100%">
          <el-option v-for="c in contacts" :key="c.id" :label="`${c.name}（${c.phone}）`" :value="c.id" />
        </el-select>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="scheduleDialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="scheduleSubmitting" @click="submitSchedule">
        保存并通知
      </el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="todoDialogVisible" title="新增待办事项" width="500px">
    <el-form :model="todoForm" label-width="80px">
      <el-form-item label="待办内容">
        <el-input v-model="todoForm.content" type="textarea" :rows="3" placeholder="请输入待办内容" />
      </el-form-item>

      <el-form-item label="负责人">
        <el-select v-model="todoForm.assigneeUserId" placeholder="选择负责人（可不填）" clearable filterable
          :loading="contactsLoading" style="width: 100%" @focus="loadContacts">
          <el-option v-for="c in contacts" :key="c.id" :label="`${c.name}（${c.phone}）`" :value="c.id" />
        </el-select>
      </el-form-item>

      <el-form-item label="验收人">
        <el-select v-model="todoForm.reviewerId" placeholder="不填则默认会议负责人（多个时默认创建者）" clearable filterable
          :loading="contactsLoading" style="width: 100%" @focus="loadContacts">
          <el-option v-for="c in contacts" :key="c.id" :label="`${c.name}（${c.phone}）`" :value="c.id" />
        </el-select>
      </el-form-item>

      <el-form-item label="截止日期">
        <el-date-picker v-model="todoForm.deadlineAt" type="date" value-format="YYYY-MM-DD"
          placeholder="选择截止日期" style="width: 100%" />
      </el-form-item>

      <el-form-item label="验收要点">
        <el-input v-model="todoForm.checklistText" type="textarea" :rows="3"
          placeholder="每行一条，验收时逐条勾选（可不填）&#10;例如：接口返回结构与文档一致" />
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="todoDialogVisible = false">
        取消
      </el-button>

      <el-button type="primary" :loading="todoSubmitting" @click="handleCreateTodo">
        确认新增
      </el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="editTodoDialogVisible" title="编辑待办事项" width="500px">
    <el-form :model="editTodoForm" label-width="80px">
      <el-form-item label="任务内容" required>
        <el-input v-model="editTodoForm.content" type="textarea" :rows="3" placeholder="请输入待办事项" />
      </el-form-item>

      <el-form-item label="负责人">
        <el-select v-model="editTodoForm.assigneeUserId" placeholder="选择负责人（可不填）" clearable filterable
          :loading="contactsLoading" style="width: 100%" @focus="loadContacts">
          <el-option v-for="c in contacts" :key="c.id" :label="`${c.name}（${c.phone}）`" :value="c.id" />
        </el-select>
      </el-form-item>

      <el-form-item label="验收人">
        <el-select v-model="editTodoForm.reviewerId" placeholder="不填则默认会议负责人（多个时默认创建者）" clearable filterable
          :loading="contactsLoading" style="width: 100%" @focus="loadContacts">
          <el-option v-for="c in contacts" :key="c.id" :label="`${c.name}（${c.phone}）`" :value="c.id" />
        </el-select>
      </el-form-item>

      <el-form-item label="截止日期">
        <el-date-picker v-model="editTodoForm.deadlineAt" type="date" value-format="YYYY-MM-DD"
          placeholder="选择截止日期" style="width: 100%" @change="editTodoForm.deadlineTouched = true" />
      </el-form-item>

      <el-form-item label="验收要点">
        <el-input v-model="editTodoForm.checklistText" type="textarea" :rows="3"
          :disabled="editTodoForm.checklistLocked"
          placeholder="每行一条，验收时逐条勾选（可不填）" />

        <p v-if="editTodoForm.checklistLocked" class="field-hint">
          待验收期间不能修改验收要点，验收或撤回后再改。
        </p>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="editTodoDialogVisible = false">
        取消
      </el-button>

      <el-button type="primary" :loading="editTodoSubmitting" @click="handleUpdateTodo">
        保存修改
      </el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="editTitleDialogVisible" title="编辑会议标题" width="450px">
    <el-form label-width="90px">
      <el-form-item label="会议标题" required>
        <el-input v-model="editTitle" maxlength="200" show-word-limit placeholder="请输入会议标题"
          @keyup.enter="handleUpdateTitle" />
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="editTitleDialogVisible = false">
        取消
      </el-button>

      <el-button type="primary" :loading="editTitleSubmitting" @click="handleUpdateTitle">
        保存修改
      </el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="viewVisible" title="提交详情" width="600px">
    <div v-loading="viewLoading" class="view-wrap">
      <p class="view-todo">{{ viewTodo?.content }}</p>

      <template v-if="viewSubmission">
        <div class="view-head">
          <el-tag size="small" :type="submissionStatusType(viewSubmission.status)">
            {{ submissionStatusText(viewSubmission.status) }}
          </el-tag>

          <span class="view-meta">
            <button v-if="viewSubmission.submitter?.id" type="button" class="name-link"
              @click="openProfile(viewSubmission.submitter?.id)">
              {{ viewSubmission.submitter?.name ?? '提交人' }}
            </button>
            <template v-else>{{ viewSubmission.submitter?.name ?? '提交人' }}</template>
            · 第 {{ viewSubmission.attemptNo }} 次提交 · {{ formatDate(viewSubmission.createdAt) }}
          </span>
        </div>

        <section class="view-block">
          <h4 class="view-label">交付说明</h4>
          <p v-if="viewSubmission.note" class="view-note">{{ viewSubmission.note }}</p>
          <p v-else class="view-empty">没有填写说明</p>
        </section>

        <section class="view-block">
          <h4 class="view-label">交付物</h4>
          <div v-if="viewSubmission.attachments.length" class="view-files">
            <el-button v-for="file in viewSubmission.attachments" :key="file.id" link type="primary"
              @click="handleDownloadAttachment(file.url, file.fileName)">
              {{ file.fileName }}
            </el-button>
          </div>
          <p v-else class="view-empty">没有上传附件</p>
        </section>

        <section v-if="(viewTodo?.checklistTotal ?? 0) > 0" class="view-block">
          <h4 class="view-label">
            验收要点 {{ viewTodo?.checklistDone }} / {{ viewTodo?.checklistTotal }}
          </h4>

          <ul class="view-checks">
            <li v-for="item in viewTodo?.checklist ?? []" :key="item.id">
              <el-checkbox :model-value="item.done"
                :disabled="!canEditTodos || checklistSavingId === item.id"
                @change="(value: any) => toggleCheckInView(item, Boolean(value))">
                {{ item.content }}
              </el-checkbox>
            </li>
          </ul>
        </section>

        <p v-if="viewSubmission.rejectReason" class="view-reject">
          打回原因：{{ viewSubmission.rejectReason }}
        </p>
      </template>

      <el-empty v-else-if="!viewLoading" description="暂无提交" :image-size="72" />
    </div>

    <template #footer>
      <el-button @click="viewVisible = false">关闭</el-button>

      <el-button v-if="viewTodo?.canWithdraw" @click="withdrawFromView">撤回</el-button>

      <el-button v-if="viewTodo?.canReview" type="danger" @click="rejectFromView">打回</el-button>

      <el-button v-if="viewTodo?.canReview" type="success" @click="acceptFromView">通过</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="checklistVisible" width="520px"
    :title="`验收要点 · ${checklistTodo?.content ?? ''}`">
    <p class="checklist-summary">
      已勾选 {{ checklistTodo?.checklistDone ?? 0 }} / {{ checklistTodo?.checklistTotal ?? 0 }}
    </p>

    <ul class="checklist">
      <li v-for="item in checklistTodo?.checklist ?? []" :key="item.id" class="checklist-item">
        <el-checkbox :model-value="item.done" :disabled="!canEditTodos || checklistSavingId === item.id"
          @change="(value: any) => handleToggleCheckItem(item, Boolean(value))">
          {{ item.content }}
        </el-checkbox>

        <span v-if="item.done && item.doneByName" class="checklist-meta">
          {{ item.doneByName }}<template v-if="item.doneAt"> · {{ formatDate(item.doneAt) }}</template>
        </span>
      </li>
    </ul>

    <template #footer>
      <el-button @click="checklistVisible = false">关闭</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="submitDialogVisible" title="提交交付" width="520px">
    <p class="submit-hint">
      提交后待办进入「待验收」，验收人确认通过才算完成；被打回会退回「进行中」。
    </p>

    <el-form label-width="80px">
      <el-form-item label="交付说明">
        <el-input v-model="submitNote" type="textarea" :rows="4" maxlength="1000" show-word-limit
          placeholder="做了什么、怎么验证、有什么需要对方注意的（可不填）" />
      </el-form-item>

      <el-form-item label="交付物">
        <el-upload v-model:file-list="submitFiles" :auto-upload="false" :limit="5" multiple class="submit-upload">
          <el-button>选择文件</el-button>

          <template #tip>
            <div class="el-upload__tip">
              最多 5 个，单个不超过 20MB（PDF / 文档 / 表格 / 压缩包 / 图片）
            </div>
          </template>
        </el-upload>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="submitDialogVisible = false">取消</el-button>

      <el-button type="primary" :loading="submitSubmitting" @click="handleSubmitTodo">
        确认提交
      </el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="timelineVisible" width="580px"
    :title="`记录 · ${timelineTodo?.content ?? ''}`">
    <div v-loading="timelineLoading" class="timeline-wrap">
      <el-empty v-if="!timelineLoading && !timelineEntries.length" description="还没有记录" :image-size="72" />

      <ul v-else class="timeline">
        <li v-for="entry in timelineEntries" :key="entry.key" class="timeline-item">
          <div class="timeline-head">
            <el-tag size="small" :type="eventTagType(entry)">
              {{ eventLabel(entry) }}
            </el-tag>

            <span class="timeline-meta">
              <template v-if="entry.actor">
                <button type="button" class="name-link" @click="openProfile(entry.actor.id)">
                  {{ entry.actor.name }}
                </button>
              </template>
              <template v-else>系统</template>

              <span class="timeline-action">{{ eventText(entry) }}</span>

              <span class="timeline-time num">{{ formatDate(entry.createdAt) }}</span>
            </span>
          </div>

          <template v-if="entry.submission">
            <p v-if="entry.submission.canViewContent === false" class="timeline-muted">
              仅相关人员可查看提交内容
            </p>

            <p v-if="entry.submission.note" class="timeline-note">{{ entry.submission.note }}</p>

            <p v-if="entry.submission.rejectReason" class="timeline-reject">
              打回原因：{{ entry.submission.rejectReason }}
            </p>

            <div v-if="entry.submission.attachments?.length" class="timeline-files">
              <span>附件：</span>

              <el-button v-for="file in entry.submission.attachments" :key="file.id" link type="primary"
                @click="handleDownloadAttachment(file.url, file.fileName)">
                {{ file.fileName }}
              </el-button>
            </div>
          </template>
        </li>
      </ul>
    </div>
  </el-dialog>
</template>

<style scoped>
/* ---------- 回到上一页 ---------- */
.back-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}

.back-row .el-button {
  font-size: 12.5px;
}

/* ---------- 批注条：纸上的旁批，不用弹窗色 ---------- */
.note {
  margin: 14px 0 0;
  padding: 10px 14px;
  border-left: 2px solid var(--rule);
  background: var(--paper-2);

  font-size: 12.5px;
  line-height: 1.85;
  color: var(--ink-2);
}

.note-top {
  margin: 0 0 14px;
}

.note-flat {
  margin: 0 0 6px;
}

/* ---------- 一张纪要纸 ---------- */
.minutes {
  padding: 30px 40px 24px;
}

/* 页眉：五栏字段，只靠竖栏线分栏 */
.meta-band {
  display: flex;
  border-top: 1px solid var(--rule);
  border-bottom: 1px solid var(--rule);
}

.field {
  flex: 1 1 0;
  min-width: 0;
  padding: 9px 14px 10px;
  border-left: 1px solid var(--rule);
}

.field:first-child {
  border-left: none;
  padding-left: 0;
}

.field-k {
  display: block;
  font-size: 10.5px;
  line-height: 1.4;
  color: var(--ink-3);
  letter-spacing: 0.06em;
}

.field-v {
  display: block;
  margin-top: 4px;
  min-height: 18px;

  font-size: 12.5px;
  line-height: 1.5;
  color: var(--ink);
  letter-spacing: 0.01em;

  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.field-name {
  font-family: var(--song);
  font-size: 13px;
  letter-spacing: 0.04em;
}

/**
 * 可点击的人名：负责人、成员、待办负责人、验收人、提交人共用。
 * 用虚线下划线示意可点，hover 变品牌色，不改变原有排版尺寸。
 */
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

/* 状态栏：放得下一枚状态标记，不参与省略号截断 */
.field-status {
  display: flex;
  align-items: center;
  min-height: 22px;
  overflow: visible;
}

/* 参会人员：移到标题上方，与页眉贴得比正文近一点 */
.sec-attendees {
  margin-top: 18px;
}

.sec-attendees + .title-row {
  padding-top: 18px;
}

/* 标题行：宋体大字，右侧一枚朱印 */
.title-row {
  display: flex;
  align-items: flex-end;
  gap: 18px;
  padding: 22px 0 0;
}

.doc-title {
  margin: 0;
  font-size: 28px;
  letter-spacing: 0.05em;
  line-height: 1.28;
  word-break: break-word;
}

.title-row .stamp {
  margin-left: auto;
}

/* 朱线：与 MeetingResult 同一手法 */
.red-rule {
  margin-top: 18px;
  height: 3px;
  border-top: 1.5px solid var(--vermilion);
  border-bottom: 1px solid var(--vermilion);
  opacity: 0.7;
}

/*
  纪要正文复用 MeetingResult：摘要与「一 核心决策」由它承担。
  它自带的第二道朱线与只读待办表在这里隐藏 —— 待办要能改，
  由本页的「二 待办事项」接管，避免同一张纸上出现两份待办。
*/
.minutes-body {
  margin-top: 18px;
}

.minutes-body :deep(.result > .red-rule) {
  display: none;
}

.minutes-body :deep(.result > .sec:last-of-type) {
  display: none;
}

/* ---------- 待办：台账行 ---------- */
.sec-add {
  margin-left: 12px;
  font-size: 12px;
}

.todo-head {
  display: flex;
  align-items: baseline;
  gap: 14px;
  padding: 10px 0 8px;
  border-bottom: 1px solid var(--rule);

  font-size: 11px;
  color: var(--ink-3);
  letter-spacing: 0.05em;
}

.todo-lines {
  margin: 0;
  padding: 0;
  list-style: none;
}

.todo-line {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 9px 0;
  border-bottom: 1px solid var(--rule-soft);
}

.todo-line:last-child {
  border-bottom: none;
}

.todo-no {
  flex-shrink: 0;
  width: 16px;
  font-size: 11px;
  color: var(--ink-3);
}

.todo-text {
  flex: 1;
  min-width: 0;

  display: flex;
  align-items: center;
  gap: 10px;

  font-size: 13px;
  line-height: 1.7;
  color: var(--ink);
}

.todo-title {
  flex: 1;
  min-width: 0;
}

.todo-edit {
  flex-shrink: 0;
  margin-left: 0;
  font-size: 11px;
}

.todo-owner,
.todo-reviewer {
  flex-shrink: 0;
  width: 76px;

  font-family: var(--song);
  font-size: 13px;
  letter-spacing: 0.04em;
  color: var(--ink-2);

  /* 居中而不是左对齐：列内两侧留白相等，列与列的间隔看起来才均匀 */
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.todo-due {
  flex-shrink: 0;
  width: 96px;

  font-size: 11px;
  color: var(--ink-3);

  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.todo-due.overdue {
  color: #a33;
}

.due-flag {
  flex-shrink: 0;
  margin-left: 4px;
  padding: 0 3px;
  font-size: 10px;
  line-height: 14px;
  border: 1px solid currentColor;
}

/* 「未确认」不是错误，只是提醒：颜色比逾期淡，别抢注意力 */
.due-flag-soft {
  color: var(--ochre);
  cursor: help;
}

.todo-state {
  flex-shrink: 0;
  width: 80px;
  display: flex;
  justify-content: center;
}

/* 表格里用紧凑版状态标记，和会议列表同一套配色 */
.todo-state .m-status {
  justify-content: center;
  box-sizing: border-box;
  width: 72px;
  height: 22px;
  padding: 0 4px;
  gap: 4px;
  font-size: 11px;
}

.todo-state .m-status-caret {
  margin-left: 0;
}

.todo-ops {
  flex-shrink: 0;
  /* 刚好放下 5 个双字按钮（查看/提交/撤回/记录/删除），不留空白 */
  width: 156px;
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: 4px 8px;
}

.todo-ops .el-button {
  margin-left: 0;
}

/* 删除：一个低调的 ×，悬停才变红 */
.todo-remove {
  margin-left: 2px;
  padding: 0 2px;
  font-size: 15px;
  line-height: 1;
  color: var(--ink-3);
  text-decoration: none;
}

.todo-remove:hover {
  color: var(--status-cancel-dot);
  text-decoration: none;
}

.todo-flag {
  margin-left: 8px;
  vertical-align: 1px;
}

.checklist-link {
  margin-left: 8px;
  font-size: 11px;
  vertical-align: 1px;
}

.field-hint {
  margin: 6px 0 0;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--ink-3);
}

.checklist-summary {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--ink-3);
}

.checklist {
  margin: 0;
  padding: 0;
  list-style: none;
}

.checklist-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid var(--rule-soft);
}

.checklist-item:last-child {
  border-bottom: none;
}

.checklist-meta {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--ink-3);
}

/* ---------- 提交详情 ---------- */
.view-wrap {
  min-height: 120px;
}

.view-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;

  margin-top: 10px;
  padding-bottom: 2px;
}

.view-meta {
  font-size: 11.5px;
  color: var(--ink-3);
}

.view-todo {
  margin: 12px 0 0;
  font-size: 13.5px;
  line-height: 1.8;
  color: var(--ink);
}

.view-block {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--rule-soft);
}

.view-label {
  margin: 0 0 6px;
  font-size: 11px;
  font-weight: 400;
  letter-spacing: 0.06em;
  color: var(--ink-3);
}

.view-note {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.8;
  color: var(--ink-2);
  white-space: pre-wrap;
  word-break: break-word;
}

.view-empty {
  margin: 0;
  font-size: 12px;
  color: var(--ink-3);
}

.view-files {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
}

.view-files .el-button {
  margin-left: 0;
  font-size: 12.5px;
}

.view-checks {
  margin: 0;
  padding: 0;
  list-style: none;
}

.view-checks li {
  padding: 4px 0;
}

.view-reject {
  margin: 14px 0 0;
  font-size: 12.5px;
  line-height: 1.8;
  color: #a33;
}

/* ---------- 交付与验收 ---------- */
.submit-hint {
  margin: 0 0 16px;
  font-size: 12.5px;
  line-height: 1.8;
  color: var(--ink-3);
}

.timeline-wrap {
  min-height: 80px;
}

.timeline {
  margin: 0;
  padding: 0;
  list-style: none;
}

.timeline-item {
  padding: 12px 0;
  border-bottom: 1px solid var(--rule-soft);
}

.timeline-item:last-child {
  border-bottom: none;
}

.timeline-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}

.timeline-meta {
  display: inline-flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 6px;

  font-size: 11.5px;
  color: var(--ink-3);
}

/* 动作描述：比时间稍重，一眼能看出发生了什么 */
.timeline-action {
  color: var(--ink-2);
}

.timeline-time {
  color: var(--ink-3);
}

.timeline-muted {
  margin: 6px 0 0;
  font-size: 11.5px;
  color: var(--ink-3);
}

.timeline-note {
  margin: 8px 0 0;
  font-size: 12.5px;
  line-height: 1.8;
  color: var(--ink-2);
  white-space: pre-wrap;
  word-break: break-word;
}

.timeline-reject {
  margin: 6px 0 0;
  font-size: 12.5px;
  line-height: 1.8;
  color: #a33;
}

.timeline-files {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 6px;

  margin: 6px 0 0;
  font-size: 11.5px;
  color: var(--ink-3);
}

.timeline-files .el-button {
  margin-left: 0;
  font-size: 11.5px;
}

.submit-upload {
  width: 100%;
}

.empty-line {
  padding: 14px 0;
  font-size: 12.5px;
  line-height: 1.8;
  color: var(--ink-3);
}

/* ---------- 原文 ---------- */
.raw-text {
  margin-top: 14px;
  white-space: pre-wrap;
  word-break: break-word;
}

.audio-strip {
  margin-top: 16px;
}

/* ---------- 人员：栏线行 ---------- */
.member-line {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 9px 0;
  border-bottom: 1px solid var(--rule-soft);
}

.member-k {
  flex-shrink: 0;
  width: 46px;
  font-size: 11px;
  color: var(--ink-3);
  letter-spacing: 0.04em;
}

.member-name {
  flex-shrink: 0;
  font-family: var(--song);
  font-size: 14px;
  letter-spacing: 0.04em;
  color: var(--ink);
}

.member-phone {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--ink-3);

  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 名单小签：同一身份的所有人铺在一个可换行的区域里 */
.member-chips {
  flex: 1;
  min-width: 0;

  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

/* 签内要放姓名和手机号，默认 24px 高偏挤，放宽一点 */
.member-chip {
  max-width: 100%;
  height: auto;
  padding: 4px 9px;
}

.member-chip .member-phone {
  flex: none;
  margin-left: 6px;
  font-size: 10.5px;
}

.chip-empty {
  font-size: 12px;
  color: var(--ink-3);
}

.member-add {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 0 0;
}

.member-select {
  /* 多选后要放得下一个折叠标签 + “+N”，比单选时略宽 */
  width: 260px;
}

/* ---------- 录音开放 ---------- */
.audio-open {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 6px;
  padding-top: 0;
}

/* 一行放下：标签 + 一句说明 + 开关 */
.audio-open-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 9px;
}

.audio-open-k {
  flex-shrink: 0;
  font-size: 11px;
  letter-spacing: 0.04em;
  color: var(--ink-3);
}

.audio-open-d {
  min-width: 0;
  font-size: 11px;
  color: var(--ink-3);

  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---------- 页脚 ---------- */
.foot {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px 18px;

  /* 移到标题上方后：分隔线压在操作栏底下，而不是顶在上面 */
  margin-bottom: 22px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--rule);
}

.foot-meta {
  flex: 1;
  min-width: 0;

  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;

  font-size: 11px;
  color: var(--ink-3);
}

/* 与历史会议列表的「置顶」徽标同一套：琥珀字、纸底、琥珀描边 */
.foot-pin {
  padding: 1px 6px;

  font-weight: 600;
  color: var(--ochre-deep);
  background: var(--ochre-wash);
  border: 1px solid var(--ochre-line);
}

.foot-actions {
  flex-shrink: 0;

  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;

  margin-left: auto;
}

.foot-actions .el-button {
  margin-left: 0;
}

/* ---------- 未找到这份纪要 ---------- */
.blank-action {
  margin-top: 18px;
}

/* ---------- 中等宽度：台账先折行，任务栏不被挤成一条缝 ---------- */
@media (max-width: 760px) {
  .todo-head {
    display: none;
  }

  .todo-line {
    flex-wrap: wrap;
    gap: 4px 12px;
    padding: 11px 0;
  }

  .todo-no {
    display: none;
  }

  .todo-text {
    flex: 1 1 100%;
  }

  .todo-owner,
  .todo-reviewer,
  .todo-due {
    width: auto;
  }

  .todo-state {
    width: auto;
    margin-left: auto;
  }

  .todo-ops {
    width: 100%;
    justify-content: flex-end;
  }
}

/* ---------- 窄屏 ---------- */
@media (max-width: 640px) {
  .page {
    padding: 22px 14px 48px;
  }

  .minutes {
    padding: 20px 16px 18px;
  }

  /* 页眉五栏折成两栏 */
  .meta-band {
    display: grid;
    grid-template-columns: 1fr 1fr;
  }

  .field {
    padding: 8px 10px 9px;
    border-left: 1px solid var(--rule);
  }

  .field:nth-child(2n + 1) {
    border-left: none;
    padding-left: 0;
  }

  .field:nth-child(n + 3) {
    border-top: 1px solid var(--rule-soft);
  }

  /* 第五栏独占一行，页眉不至于出现半截栏线 */
  .field:last-child {
    grid-column: 1 / -1;
    border-left: none;
    padding-left: 0;
  }

  .title-row {
    flex-wrap: wrap;
    gap: 12px;
    padding-top: 18px;
  }

  .doc-title {
    font-size: 22px;
  }

  .sec-h {
    flex-wrap: wrap;
    row-gap: 4px;
  }

  .sec-add {
    margin-left: 0;
  }

  .member-line {
    flex-wrap: wrap;
  }

  .member-add {
    flex-direction: column;
    align-items: stretch;
  }

  .member-select {
    width: 100%;
  }

  .member-add .el-button {
    width: 100%;
  }

  .audio-open {
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
  }

  /* 窄屏把说明放成两行，不截断 */
  .audio-open-main {
    flex-direction: column;
    gap: 3px;
  }

  .audio-open-d {
    white-space: normal;
    line-height: 1.7;
  }

  /* 操作条纵向排列 */
  .foot {
    flex-direction: column;
    align-items: stretch;
    gap: 14px;
  }

  .foot-actions {
    flex-direction: column;
    align-items: stretch;

    width: 100%;
    margin-left: 0;
  }

  .foot-actions .el-button {
    width: 100%;
  }
}
</style>
