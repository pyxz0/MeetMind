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
  /** 结构化截止时间 */
  deadlineAt?: string | null
  /** 已过截止时间且未完成 */
  overdue?: boolean
  status: 'OPEN' | 'IN_PROGRESS'
  mine: boolean
  leaderOwned: boolean
}

export interface InboxReview {
  submissionId: number
  todoId: number
  meetingId: number
  meetingTitle: string
  todoContent: string
  assignee: string | null
  /** 提交人 id：用于打开个人主页 */
  submitterId: number
  submitterName: string
  attemptNo: number
  submittedAt: string
  rejectReason: string | null
  /** 过了截止时间还在等验收 */
  deadlineAt?: string | null
  overdue?: boolean
}

export interface InboxData {
  notifications: InboxNotification[]
  todos: InboxTodo[]
  /** 待我验收的提交 */
  reviews?: InboxReview[]
  /** 被我打回、需要重新提交的 */
  rejected?: InboxReview[]
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
