import api from './http'

export interface GenerateMeetingRequest {
  content: string
}

/** 待办最近一次提交的摘要（详情接口附带，完整时间线走独立接口） */
export interface TodoSubmissionBrief {
  id: number
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'WITHDRAWN'
  note: string | null
  attemptNo: number
  submitterId: number
  submitterName: string | null
  rejectReason: string | null
  reviewedAt: string | null
  createdAt: string
  attachmentCount: number
}

export interface TodoItem {
  id?: number
  content: string
  /** 负责人姓名文本，保留兼容 */
  assignee?: string
  /** 结构化负责人；为空说明只留了姓名（AI 未能唯一匹配到账号） */
  assigneeUserId?: number | null
  assigneeName?: string | null
  /** 验收人；为空表示不需要验收 */
  reviewerId?: number | null
  reviewerName?: string | null
  deadline?: string
  /** ISO 日期；自然语言解析不了时为空 */
  deadlineAt?: string | null
  /** 已过截止时间且未完成 */
  overdue?: boolean
  status?: string
  latestSubmission?: TodoSubmissionBrief | null
  /** 验收要点：勾选进度与明细 */
  checklist?: ChecklistItem[]
  checklistTotal?: number
  checklistDone?: number
  /** 我能否提交这条交付 */
  canSubmit?: boolean
  /** 我能否修改状态（会议负责人、该待办负责人或超管） */
  canChangeStatus?: boolean
  /** 我能否查看提交内容（说明、附件、打回原因） */
  canViewSubmissionContent?: boolean
  /** 我能否验收 */
  canReview?: boolean
  /** 我能否撤回提交 */
  canWithdraw?: boolean
}

export interface ChecklistItem {
  id: number
  content: string
  done: boolean
  doneById: number | null
  doneByName: string | null
  doneAt: string | null
}

export interface MeetingResult {
  id?: number
  title?: string
  content?: string
  summary: string
  decisions: string[]
  todos: TodoItem[]
  status?: string
  completionStatus?:
  | 'NOT_STARTED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CANCELLED'
  isDraft?: boolean
  createdAt?: string
  /**
   * 录音的可播放地址。
   *
   * 现在由后端按权限给出：有权听时是鉴权接口 /api/meetings/:id/audio，
   * 无权听（负责人关闭了录音）时为 null —— 前端拿不到地址就播不了。
   */
  audioUrl?: string | null
  /** 录音时长（秒），与转写计时一致。 */
  audioDurationSec?: number | null
  /** 正式会议的开会时间；为空表示临时会议 */
  scheduledAt?: string | null
  /** 录音是否对非负责人开放 */
  audioOpen?: boolean
  /** 是否存在录音（与是否有权听无关，用于展示「有录音但未开放」） */
  hasAudio?: boolean
  /** 置顶时间；为空表示未置顶。多条置顶按此时间倒序排列。 */
  pinnedAt?: string | null
  /** 待办数量（列表接口只给数量，明细走详情接口） */
  todoCount?: number
  /** 决策数量 */
  decisionCount?: number

  // ---- 负责人（可多位）与成员 ----
  leaders?: MemberBrief[]
  members?: MemberBrief[]

  // ---- 权限相关（由后端按归属、共享、成员关系计算）----
  /** 归属者用户 ID */
  ownerId?: number
  /** 当前用户对该会议的实际访问级别 */
  access?: 'owner' | 'leader' | 'member' | 'edit' | 'read'
  canRead?: boolean
  /** 改标题 / 改完成状态 / 重新生成 */
  canEdit?: boolean
  /** 勾选与增删改待办 */
  canEditTodos?: boolean
  /** 指定负责人与增删成员 */
  canManageMembers?: boolean
  /** 控制录音是否开放 */
  canToggleAudio?: boolean
  /** 能否收听录音 */
  canListenAudio?: boolean
  canDelete?: boolean
  /** 是否能管理共享（Owner 或管理员） */
  canShare?: boolean
  isOwner?: boolean
  isLeader?: boolean
  isMember?: boolean
}

/** 负责人 / 成员的简要信息 */
export interface MemberBrief {
  id: number
  name: string
  phone: string
}

export interface MeetingRecord extends MeetingResult {
  id: number
  createdAt: string
  /** 来源平台：null 表示 MeetMind 自建，tencent 表示同步自腾讯会议 */
  sourcePlatform?: string | null
  /** 入会链接（腾讯会议建会时回写） */
  externalJoinUrl?: string | null
  /** 会议号，给人念的那串数字 */
  externalCode?: string | null
  /**
   * 建会时同步到腾讯会议的失败原因。
   * 这是「提示」不是「错误」—— 会议已经在本地建好了，只是少了入会链接。
   */
  platformSyncError?: string
}

/** 会议平台接入状态：决定界面要不要显示「同步到腾讯会议」 */
export interface PlatformStatus {
  /** tencent / mock / off */
  name: string
  enabled: boolean
  label: string
}

export const getPlatformStatus = async (): Promise<PlatformStatus> => {
  const response = await api.get<PlatformStatus>('/platforms/status')

  return response.data
}

/** 后端返回的相对路径转成可直接给 <audio> 使用的完整地址。 */
/**
 * 把后端给出的录音地址转成 <audio> 可直接使用的完整地址。
 *
 * 关键点：音频流接口需要鉴权，而 <audio> 标签无法自定义请求头，
 * 因此把 token 作为查询参数附在 URL 上（后端只对「GET 会议音频流」接受该方式）。
 */
export const resolveAudioUrl = (
  audioUrl?: string | null
): string => {
  if (!audioUrl) {
    return ''
  }

  // 已经是完整地址时直接返回，避免重复拼接。
  if (/^https?:\/\//i.test(audioUrl)) {
    return appendToken(audioUrl)
  }

  // api 的 baseURL 形如 http://127.0.0.1:3000/api，去掉结尾的 /api 即服务根地址。
  const serverRoot = api.defaults.baseURL?.replace(/\/api\/?$/, '') || ''

  return appendToken(`${serverRoot}/${audioUrl.replace(/^\//, '')}`)
}

/** 给音频地址附上登录 token */
const appendToken = (url: string) => {
  const token = localStorage.getItem('meetmind.token')

  if (!token) {
    return url
  }

  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
}

/**
 * 将后端返回的数据转换成前端统一格式
 */
const normalizeMeeting = (data: any): MeetingRecord => {
  return {
    id: data.id,
    title: data.title,
    content: data.content,
    summary: data.summary || '',
    decisions: Array.isArray(data.decisions)
      ? data.decisions
      : [],
    todos: Array.isArray(data.todos)
      ? data.todos
      : [],
    completionStatus: data.completionStatus,
    isDraft: data.isDraft ?? false,
    audioUrl: data.audioUrl ?? null,
    audioDurationSec: data.audioDurationSec ?? null,
    audioOpen: data.audioOpen ?? true,
    scheduledAt: data.scheduledAt ?? null,
    hasAudio: data.hasAudio ?? false,
    pinnedAt: data.pinnedAt ?? null,
    todoCount: data.todoCount ?? (Array.isArray(data.todos) ? data.todos.length : 0),
    decisionCount: data.decisionCount ?? (Array.isArray(data.decisions) ? data.decisions.length : 0),
    leaders: Array.isArray(data.leaders) ? data.leaders : [],
    members: Array.isArray(data.members) ? data.members : [],
    ownerId: data.ownerId,
    access: data.access ?? 'read',
    canRead: data.canRead ?? false,
    canEdit: data.canEdit ?? false,
    canEditTodos: data.canEditTodos ?? false,
    canManageMembers: data.canManageMembers ?? false,
    canToggleAudio: data.canToggleAudio ?? false,
    canListenAudio: data.canListenAudio ?? false,
    canDelete: data.canDelete ?? false,
    canShare: data.canShare ?? false,
    isOwner: data.isOwner ?? false,
    isLeader: data.isLeader ?? false,
    isMember: data.isMember ?? false,
    // 会议来源与入会入口：显式列出，否则会被这个白名单函数丢掉
    sourcePlatform: data.sourcePlatform ?? null,
    externalJoinUrl: data.externalJoinUrl ?? null,
    externalCode: data.externalCode ?? null,
    createdAt: data.created_at || data.createdAt
  }
}

/**
 * 生成并保存会议纪要。
 *
 * 后端已改为异步任务：这里先启动任务，再轮询状态，
 * 成功后返回会议详情。对外签名保持不变，调用方无需感知异步。
 */
export const generateMeeting = async (
  data: GenerateMeetingRequest
): Promise<MeetingResult> => {
  const start = await api.post<{
    id: number
    meetingId: number | null
    status: string
  }>('/ai/generate', data)

  const generationId = start.data.id
  const deadline = Date.now() + 3 * 60 * 1000

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1500))

    const status = await api.get<{
      status: string
      meetingId: number | null
      error: string | null
    }>(`/ai/generations/${generationId}`)

    if (status.data.status === 'SUCCEEDED' && status.data.meetingId) {
      const meeting = await api.get<MeetingResult>(
        `/meetings/${status.data.meetingId}`
      )

      return meeting.data
    }

    if (status.data.status === 'FAILED') {
      throw new Error(status.data.error || 'AI 生成失败')
    }
  }

  throw new Error('AI 生成超时，请稍后在历史会议中查看结果')
}

/** 列表项：只含摘要与计数，明细需再查详情 */
export interface MeetingPage {
  items: MeetingRecord[]
  total: number
  /** 当前筛选下的置顶总数 */
  pinnedTotal: number
  page: number
  pageSize: number
  hasMore: boolean
}

export interface MeetingQuery {
  page?: number
  pageSize?: number
  keyword?: string
  status?: MeetingCompletionStatusValue
  from?: string
  to?: string
  pinned?: boolean
  upcoming?: boolean
  /** newest 最新创建在前（默认），oldest 最早创建在前 */
  sort?: 'newest' | 'oldest'
}

/**
 * 分页查询会议。
 *
 * 后端默认排除未开始的预约会议；传 upcoming=true 只取未开始的，
 * 传 pinned=true 只取置顶的。
 */
export const getMeetingsPage = async (
  query: MeetingQuery = {}
): Promise<MeetingPage> => {
  const response = await api.get<{
    items: any[]
    total: number
    pinnedTotal: number
    page: number
    pageSize: number
    hasMore: boolean
  }>('/meetings', { params: query })

  return {
    ...response.data,
    items: response.data.items.map(normalizeMeeting)
  }
}

/**
 * 兼容旧用法：拉取一页较大的列表。
 *
 * 保留它是为了让尚未改造的页面无需一次性重写，
 * 新代码请直接用 getMeetingsPage 控制分页。
 */
export const getMeetings = async (): Promise<MeetingRecord[]> => {
  const page = await getMeetingsPage({ pageSize: 100 })

  return page.items
}

/**
 * 获取会议详情
 */
export const getMeeting = async (
  id: number
): Promise<MeetingRecord> => {
  const response = await api.get<any>(
    `/meetings/${id}`
  )

  return normalizeMeeting(response.data)
}

export interface MeetingExport {
  filename: string
  content: string
}

/**
 * 导出会议纪要（Markdown）。
 *
 * 后端返回 JSON，前端自己造 Blob 触发下载：`<a download>` 带不了
 * Authorization 头，而把令牌拼进 URL 又会留在浏览器历史里。
 */
export const exportMeetingMarkdown = async (
  id: number
): Promise<MeetingExport> => {
  const response = await api.get<MeetingExport>(
    `/meetings/${id}/export`
  )

  return response.data
}

/**
 * 获取草稿箱会议
 */
export const getDraftMeetings = async (): Promise<MeetingRecord[]> => {
  const response = await api.get<any[]>(
    '/meetings/drafts'
  )

  return response.data.map(normalizeMeeting)
}

/**
 * 删除会议
 */
export const deleteMeeting = async (
  id: number
): Promise<void> => {
  await api.delete(`/meetings/${id}`)
}

/** 修改会议标题 */
export const updateMeeting = async (
  id: number,
  data: { title: string }
) => {
  const response = await api.patch(`/meetings/${id}`, data)
  return response.data
}

/**
 * 置顶 / 取消置顶会议。
 *
 * 返回后端记录的置顶时间，前端据此排在最前；
 * 取消置顶时返回 null。
 */
export const updateMeetingPinned = async (
  id: number,
  pinned: boolean
): Promise<{ id: number; pinnedAt: string | null }> => {
  const response = await api.patch(`/meetings/${id}/pin`, {
    pinned
  })

  return response.data
}

/** 会议完成状态，与后端枚举保持一致。 */
export type MeetingCompletionStatusValue =
  | 'NOT_STARTED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CANCELLED'

/**
 * 待办变更后后端会顺带同步会议状态。
 * 这里把它返回出来，前端可以立即刷新表头而不必重新拉整条会议。
 */
interface TodoMutationResult {
  meetingCompletionStatus?: MeetingCompletionStatusValue
}

/** 更新待办事项状态 */
export const updateTodoStatus = async (
  id: number,
  status: 'OPEN' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED'
): Promise<TodoMutationResult> => {
  const response = await api.patch(`/meetings/todos/${id}/status`, {
    status
  })

  return response.data
}

export default api
/** 新增会议待办 */
export const createTodo = async (
  meetingId: number,
  data: {
    content: string;
    assignee?: string;
    assigneeUserId?: number | null;
    reviewerId?: number | null;
    deadline?: string;
    deadlineAt?: string | null;
  }
): Promise<TodoMutationResult & { id: number }> => {
  const response = await api.post(
    `/meetings/${meetingId}/todos`,
    data
  )

  return response.data
}
/** 删除单条待办 */
export const deleteTodo = async (
  id: number
): Promise<TodoMutationResult> => {
  const response = await api.delete(`/meetings/todos/${id}`)
  return response.data
}
/** 编辑待办事项 */
export const updateTodo = async (
  id: number,
  data: {
    content?: string
    assignee?: string
    assigneeUserId?: number | null
    reviewerId?: number | null
    deadline?: string
    deadlineAt?: string | null
  }
) => {
  const response = await api.patch(`/meetings/todos/${id}`, data)
  return response.data
}

/* =========================
   验收要点（清单）
   ========================= */

/** 覆盖式设置验收要点；空数组表示清空 */
export const setTodoChecklist = async (
  todoId: number,
  items: string[]
): Promise<{ todoId: number; checklist: ChecklistItem[] }> => {
  const response = await api.put(`/meetings/todos/${todoId}/checklist`, {
    items
  })

  return response.data
}

/** 勾选 / 取消一条验收要点 */
export const toggleTodoCheckItem = async (
  todoId: number,
  itemId: number,
  done: boolean
) => {
  const response = await api.patch(
    `/meetings/todos/${todoId}/checklist/${itemId}`,
    { done }
  )

  return response.data
}

/* =========================
   待办交付与验收
   ========================= */

/** 提交交付：有验收人时进入待验收，否则直接完成 */
export const submitTodo = async (
  todoId: number,
  note?: string
): Promise<
  TodoMutationResult & {
    id: number
    todoId: number
    status: string
    attemptNo: number
  }
> => {
  const response = await api.post(`/meetings/todos/${todoId}/submissions`, {
    note
  })

  return response.data
}

/** 某条待办的提交时间线 */
export interface TodoSubmissionRecord {
  id: number
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'WITHDRAWN'
  note: string | null
  attemptNo: number
  rejectReason: string | null
  reviewedAt: string | null
  createdAt: string
  /** 提交人；无关成员也能看到，但 note/附件/打回原因为空 */
  submitter: { id: number; name: string } | null
  reviewer: { id: number; name: string } | null
  /** 是否有权查看说明 / 附件 / 打回原因 */
  canViewContent?: boolean
  attachments: Array<{
    id: number
    fileName: string
    mimeType: string
    sizeBytes: number
    createdAt: string
    url: string
  }>
}

export const listTodoSubmissions = async (
  todoId: number
): Promise<TodoSubmissionRecord[]> => {
  const response = await api.get(`/meetings/todos/${todoId}/submissions`)

  return response.data
}

/** 待办流转事件：谁在什么时候把状态改成了什么 */
export interface TodoEventRecord {
  id: number
  type: string
  fromStatus: string | null
  toStatus: string | null
  submissionId: number | null
  metadata: Record<string, any> | null
  createdAt: string
  actor: { id: number; name: string } | null
}

export const listTodoEvents = async (
  todoId: number
): Promise<TodoEventRecord[]> => {
  const response = await api.get(`/meetings/todos/${todoId}/events`)

  return response.data
}

/** 会议状态变更记录：谁手动把会议状态改成了什么 */
export interface MeetingEventRecord {
  id: number
  type: string
  fromStatus: string | null
  toStatus: string | null
  createdAt: string
  actor: { id: number; name: string } | null
}

export const listMeetingEvents = async (
  meetingId: number
): Promise<MeetingEventRecord[]> => {
  const response = await api.get(`/meetings/${meetingId}/events`)

  return response.data
}

/** 验收通过 */
export const acceptSubmission = async (
  submissionId: number
): Promise<TodoMutationResult & { uncheckedChecklist?: number }> => {
  const response = await api.post(`/meetings/submissions/${submissionId}/accept`)

  return response.data
}

/** 打回，原因必填 */
export const rejectSubmission = async (
  submissionId: number,
  reason: string
): Promise<TodoMutationResult> => {
  const response = await api.post(`/meetings/submissions/${submissionId}/reject`, {
    reason
  })

  return response.data
}

/** 撤回提交 */
export const withdrawSubmission = async (
  submissionId: number
): Promise<TodoMutationResult> => {
  const response = await api.post(`/meetings/submissions/${submissionId}/withdraw`)

  return response.data
}

/** 给某次提交追加交付物（单文件，最多 5 个） */
export const uploadSubmissionAttachment = async (
  submissionId: number,
  file: File
): Promise<{
  id: number
  fileName: string
  mimeType: string
  sizeBytes: number
  url: string
}> => {
  const form = new FormData()
  form.append('file', file)

  const response = await api.post(
    `/meetings/submissions/${submissionId}/attachments`,
    form,
    { headers: { 'Content-Type': 'multipart/form-data' } }
  )

  return response.data
}

/**
 * 下载交付物。
 *
 * 后端接口需要 Authorization 头，`<a href>` 带不了，
 * 因此走 axios 取 blob 再触发下载 —— 不用 `?token=`，避免令牌留在浏览历史里。
 */
export const downloadSubmissionAttachment = async (
  url: string,
  fileName: string
) => {
  const path = url.replace(/^\/api/, '')
  const response = await api.get(path, { responseType: 'blob' })

  const blobUrl = URL.createObjectURL(response.data)
  const link = document.createElement('a')

  link.href = blobUrl
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()

  URL.revokeObjectURL(blobUrl)
}
/** 重新生成已有会议的 AI 纪要 */
export const regenerateMeeting = async (
  id: number
): Promise<MeetingRecord> => {
  const response = await api.post<any>(
    `/ai/regenerate/${id}`
  )

  return normalizeMeeting(response.data)
}
/** 获取会议数据统计 */
export interface MeetingStats {
  totalMeetings: number
  draftMeetings: number
  notStartedMeetings: number
  inProgressMeetings: number
  completedMeetings: number
  cancelledMeetings: number
  totalTodos: number
  completedTodos: number
  /** 待验收的待办数：不计入完成率，但需要单独露出 */
  pendingReviewTodos: number
  /** 已过截止时间且未完成 */
  overdueTodos: number
  /** 被打回的提交数 */
  reworkCount: number
  /** 平均验收时长（小时）；没有样本时为 null */
  avgReviewHours: number | null
  totalDecisions: number
}

/** 获取会议完成状态统计 */
export const getMeetingStats = async (): Promise<MeetingStats> => {
  const response = await api.get<MeetingStats>(
    '/meetings/stats'
  )

  return response.data
}
/** 手动修改会议完成状态；只改状态，不影响该会议的待办。 */
export const updateMeetingCompletionStatus = async (
  id: number,
  completionStatus: MeetingCompletionStatusValue
): Promise<{
  id: number
  title: string
  completionStatus: MeetingCompletionStatusValue
}> => {
  const response = await api.patch(
    `/meetings/${id}/completion-status`,
    {
      completionStatus
    }
  )

  return response.data
}

/** 手动将会议内容保存到草稿箱 */
export const createDraftMeeting = async (
  data: {
    title?: string
    content: string
  }
): Promise<MeetingRecord> => {
  const response = await api.post<any>(
    '/meetings/drafts',
    data
  )

  return normalizeMeeting(response.data)
}

/** 按录音容器推断文件扩展名；服务端最终会换成 UUID，这里只影响格式识别。 */
const extensionForMimeType = (mimeType: string) => {
  const normalized = (mimeType || '').toLowerCase()

  if (normalized.includes('mp4') || normalized.includes('m4a')) {
    return 'm4a'
  }

  if (normalized.includes('ogg') || normalized.includes('opus')) {
    return 'ogg'
  }

  if (normalized.includes('wav')) {
    return 'wav'
  }

  return 'webm'
}

/**
 * 上传会议录音。
 *
 * 与转写结果绑定到同一条会议记录，便于会后回听核对。
 */
export const uploadMeetingAudio = async (
  meetingId: number,
  audio: Blob,
  durationSec?: number
) => {
  const form = new FormData()

  const extension = extensionForMimeType(audio.type)

  form.append('audio', audio, `meeting-${meetingId}.${extension}`)

  if (durationSec != null && Number.isFinite(durationSec)) {
    form.append('durationSec', String(Math.round(durationSec)))
  }

  const response = await api.post<{
    id: number
    audioUrl: string
    audioDurationSec: number | null
    size: number
  }>(`/meetings/${meetingId}/audio`, form, {
    // 交给浏览器自动带 multipart boundary，手写会把 boundary 写错。
    headers: { 'Content-Type': undefined },
    // 录音体积可能较大，单独放宽超时。
    timeout: 300000
  })

  return response.data
}

/* ───────────── 正式会议（预约） ───────────── */

/**
 * 创建正式会议。
 *
 * 传 scheduledAt 表示预约会议；未传该字段的会议走即时创建流程（临时会议）。
 */
export const createScheduledMeeting = async (data: {
  title?: string
  scheduledAt: string
  leaderIds?: number[]
  memberIds?: number[]
  /** 同时到会议平台建会；不传表示只记在 MeetMind */
  platform?: 'tencent'
}): Promise<MeetingRecord> => {
  const response = await api.post('/meetings/scheduled', data)
  const record = normalizeMeeting(response.data)

  // 同步失败原因只在这一次响应里出现，不会被 normalize 保留
  if (response.data?.platformSyncError) {
    record.platformSyncError = response.data.platformSyncError
  }

  return record
}

/**
 * 修改未开始会议的预约信息（标题 / 开会时间 / 负责人 / 成员）。
 *
 * 后端会校验会议尚未开始，并在成功后给参会人员发送变更消息。
 */
export const updateScheduledMeeting = async (
  id: number,
  data: {
    title?: string
    scheduledAt?: string
    leaderIds?: number[]
    memberIds?: number[]
  }
): Promise<MeetingRecord> => {
  const response = await api.patch(`/meetings/${id}/schedule`, data)

  return normalizeMeeting(response.data)
}

/* ───────────── 负责人 / 成员 / 录音开放 ───────────── */

/** 追加负责人（可多位），返回最新负责人列表 */
export const addMeetingLeader = async (
  id: number,
  userId: number
): Promise<MemberBrief[]> => {
  const response = await api.post<MemberBrief[]>(
    `/meetings/${id}/leaders`,
    { userId }
  )

  return response.data
}

/** 移除负责人；会议至少要保留一位 */
export const removeMeetingLeader = async (
  id: number,
  userId: number
): Promise<MemberBrief[]> => {
  const response = await api.delete<MemberBrief[]>(
    `/meetings/${id}/leaders/${userId}`
  )

  return response.data
}

/** 会议成员列表 */
export const getMeetingMembers = async (
  id: number
): Promise<MemberBrief[]> => {
  const response = await api.get<MemberBrief[]>(
    `/meetings/${id}/members`
  )

  return response.data
}

/** 添加会议成员，返回最新成员列表 */
export const addMeetingMember = async (
  id: number,
  userId: number
): Promise<MemberBrief[]> => {
  const response = await api.post<MemberBrief[]>(
    `/meetings/${id}/members`,
    { userId }
  )

  return response.data
}

/** 移除会议成员，返回最新成员列表 */
export const removeMeetingMember = async (
  id: number,
  userId: number
): Promise<MemberBrief[]> => {
  const response = await api.delete<MemberBrief[]>(
    `/meetings/${id}/members/${userId}`
  )

  return response.data
}

/** 控制录音是否对非负责人开放 */
export const updateMeetingAudioOpen = async (
  id: number,
  audioOpen: boolean
): Promise<{ id: number; audioOpen: boolean }> => {
  const response = await api.patch(`/meetings/${id}/audio-open`, {
    audioOpen
  })

  return response.data
}

/* =========================
   会议追问
   ========================= */

/** 一条追问记录 */
export interface MeetingChatMessageRecord {
  id: number
  role: 'USER' | 'ASSISTANT'
  content: string
  createdAt: string
}

/** 追问历史（最近 30 条），打开面板时回填 */
export const listMeetingChat = async (
  id: number
): Promise<MeetingChatMessageRecord[]> => {
  const response = await api.get<MeetingChatMessageRecord[]>(
    `/meetings/${id}/chat`
  )

  return response.data
}

/**
 * 就某场会议提问。
 *
 * 历史对话由服务端按会议 ID 自行读取，这里只传问题本身 ——
 * 不把上下文放在客户端，避免被伪造。
 */
export const askMeeting = async (
  id: number,
  question: string
): Promise<{ answer: string; createdAt: string }> => {
  const response = await api.post<{ answer: string; createdAt: string }>(
    `/meetings/${id}/ask`,
    { question }
  )

  return response.data
}
