import api from './http'

export type MessageKind = 'TEXT' | 'IMAGE' | 'FILE'

export interface ConversationSummary {
  id: number
  peerId: number
  peerName: string
  peerPhone: string
  peerAvatar: string | null
  lastMessage: string
  lastMessageAt: string
  unreadCount: number
}

export interface MessageAttachment {
  id: number
  fileName: string
  sizeBytes: number
  mimeType: string
  isImage: boolean
  url: string
}

export interface MessageView {
  id: number
  conversationId: number
  senderId: number
  senderName: string
  kind: MessageKind
  content: string | null
  createdAt: string
  mine: boolean
  attachments: MessageAttachment[]
}

/** 我的会话列表 */
export const listConversations = async (): Promise<ConversationSummary[]> => {
  const response = await api.get<ConversationSummary[]>('/messages/conversations')
  return response.data
}

/** 未读总数（导航角标） */
export const unreadTotal = async (): Promise<{ unreadTotal: number }> => {
  const response = await api.get<{ unreadTotal: number }>('/messages/unread-total')
  return response.data
}

/** 发起或进入与某人的会话 */
export const openConversation = async (
  peerId: number,
): Promise<{ conversationId: number }> => {
  const response = await api.post<{ conversationId: number }>(
    '/messages/conversations',
    { peerId },
  )
  return response.data
}

/** 某会话的消息列表（拉取即已读） */
export const listMessages = async (
  conversationId: number,
): Promise<MessageView[]> => {
  const response = await api.get<MessageView[]>(
    `/messages/conversations/${conversationId}/messages`,
  )
  return response.data
}

/**
 * 发消息。
 *
 * 纯文字：kind=TEXT，无 file。
 * 图片/文件：用 FormData 带 file，kind 可选 IMAGE/FILE（不传时按文件处理）。
 */
export const sendMessage = async (
  conversationId: number,
  payload: {
    content?: string
    kind?: MessageKind
    file?: File
  },
): Promise<MessageView> => {
  const form = new FormData()

  if (payload.content) form.append('content', payload.content)
  if (payload.kind) form.append('kind', payload.kind)
  if (payload.file) form.append('file', payload.file)

  const response = await api.post<MessageView>(
    `/messages/conversations/${conversationId}/messages`,
    form,
  )

  return response.data
}
