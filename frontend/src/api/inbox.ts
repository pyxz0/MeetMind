import api from './http'

export type InboxNotificationType = 'leader' | 'member' | 'share' | 'notice'

export interface InboxNotification {
  key: string
  type: InboxNotificationType
  meetingId: number
  meetingTitle: string
  actorName: string | null
  permission: 'READ' | 'EDIT' | null
  /** 会议开始时间，仅旧版提醒类型使用；现由 content 承载 */
  scheduledAt: string | null
  /** 消息正文，仅 notice 类型有值（时间即真实发送时间） */
  content: string | null
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

/**
 * 标记已读。
 *
 * 传 keys 只标记这几条（点击单条通知时用）；不传则全部标记已读。
 */
export const markInboxRead = async (
  keys?: string[]
): Promise<{ unreadCount: number; seenAt?: string }> => {
  const response = await api.post('/inbox/read', keys?.length ? { keys } : {})

  return response.data
}
