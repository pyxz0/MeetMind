import axios from 'axios'

const api = axios.create({
  baseURL:
    import.meta.env.VITE_API_BASE_URL ||
    'http://127.0.0.1:3000/api',
  timeout: 60000,
  headers: {
    'Content-Type': 'application/json'
  }
})

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
}

export interface MeetingRecord extends MeetingResult {
  id: number
  createdAt: string
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

/** 更新待办事项状态 */
export const updateTodoStatus = async (
  id: number,
  status: 'OPEN' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED'
) => {
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
) => {
  const response = await api.post(
    `/meetings/${meetingId}/todos`,
    data
  )

  return response.data
}
/** 删除单条待办 */
export const deleteTodo = async (id: number) => {
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
/** 手动修改会议完成状态 */
export const updateMeetingCompletionStatus = async (
  id: number,
  completionStatus:
    | 'NOT_STARTED'
    | 'IN_PROGRESS'
    | 'COMPLETED'
    | 'CANCELLED'
) => {
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