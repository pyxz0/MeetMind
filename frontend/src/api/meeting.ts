import api from './http'

export interface GenerateMeetingRequest {
  content: string
}

export interface TodoItem {
  id?: number
  content: string
  assignee?: string
  deadline?: string
  status?: string
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
  /** 录音是否对非负责人开放 */
  audioOpen?: boolean
  /** 是否存在录音（与是否有权听无关，用于展示「有录音但未开放」） */
  hasAudio?: boolean
  /** 置顶时间；为空表示未置顶。多条置顶按此时间倒序排列。 */
  pinnedAt?: string | null

  // ---- 负责人与成员 ----
  leaderId?: number
  leader?: MemberBrief | null
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
    hasAudio: data.hasAudio ?? false,
    pinnedAt: data.pinnedAt ?? null,
    leaderId: data.leaderId,
    leader: data.leader ?? null,
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
    createdAt: data.created_at || data.createdAt
  }
}

/**
 * 生成并保存会议纪要
 */
export const generateMeeting = async (
  data: GenerateMeetingRequest
): Promise<MeetingResult> => {
  const response = await api.post<MeetingResult>(
    '/ai/generate',
    data
  )

  return response.data
}

/**
 * 获取历史会议
 */
export const getMeetings = async (): Promise<MeetingRecord[]> => {
  const response = await api.get<any[]>('/meetings')

  return response.data.map(normalizeMeeting)
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
    deadline?: string;
  }
): Promise<TodoMutationResult> => {
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
    deadline?: string
  }
) => {
  const response = await api.patch(`/meetings/todos/${id}`, data)
  return response.data
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

/* ───────────── 负责人 / 成员 / 录音开放 ───────────── */

/** 指定会议负责人，返回更新后的会议 */
export const updateMeetingLeader = async (
  id: number,
  leaderId: number
): Promise<MeetingRecord> => {
  const response = await api.patch(`/meetings/${id}/leader`, { leaderId })

  return normalizeMeeting(response.data)
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