import api from './http'

export type InboxNotificationType = 'leader' | 'member' | 'share'

export interface InboxNotification {
  key: string
  type: InboxNotificationType
  meetingId: number
  meetingTitle: string
  actorName: string | null
  permission: 'READ' | 'EDIT' | null
  createdAt: string
  read: boolean
}

export interface InboxTodo {
  id: number
  meetingId: number
  meetingTitle: string
  content: string
  assignee: string | null
  deadline: string | null
  status: 'OPEN' | 'IN_PROGRESS'
  mine: boolean
  leaderOwned: boolean
}

export interface InboxData {
  notifications: InboxNotification[]
  todos: InboxTodo[]
  unreadCount: number
  seenAt: string | null
}

/** 拉取收件箱（通知 + 待办提醒 + 未读数） */
export const getInbox = async (): Promise<InboxData> => {
  const response = await api.get<InboxData>('/inbox')

  return response.data
}

/** 只取未读数，供侧边栏角标使用 */
export const getInboxUnreadCount = async (): Promise<{
  unreadCount: number
}> => {
  const response = await api.get<{ unreadCount: number }>(
    '/inbox/unread-count'
  )

  return response.data
}

/** 标记通知全部已读 */
export const markInboxRead = async (): Promise<{
  seenAt: string
  unreadCount: number
}> => {
  const response = await api.post('/inbox/read')

  return response.data
}
