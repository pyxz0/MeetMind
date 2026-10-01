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
  createdAt?: string
}

export interface MeetingRecord extends MeetingResult {
  id: number
  createdAt: string
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
  const response = await api.get<MeetingRecord[]>('/meetings')

  return response.data
}

/**
 * 获取会议详情
 */
export const getMeeting = async (
  id: number
): Promise<MeetingRecord> => {
  const response = await api.get<MeetingRecord>(
    `/meetings/${id}`
  )

  return response.data
}

/**
 * 删除会议
 */
export const deleteMeeting = async (
  id: number
): Promise<void> => {
  await api.delete(`/meetings/${id}`)
}

export default api