import api from './http'

export interface Friend {
  id: number
  name: string
  phone: string
  avatar: string | null
  isActive: boolean
  /** 加好友的时间 */
  since: string
}

/** 我的好友列表 */
export const listFriends = async (): Promise<Friend[]> => {
  const response = await api.get<Friend[]>('/friends')

  return response.data
}

/**
 * 按手机号加好友（幂等）。
 *
 * 只能精确匹配，没有模糊搜索 —— 否则等于开放全平台用户枚举。
 */
export const addFriend = async (phone: string): Promise<Friend> => {
  const response = await api.post<Friend>('/friends', { phone })

  return response.data
}

/** 删好友（双向一起删，幂等） */
export const removeFriend = async (userId: number) => {
  const response = await api.delete(`/friends/${userId}`)

  return response.data
}
