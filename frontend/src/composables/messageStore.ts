import { ref } from 'vue'
import { unreadTotal } from '../api/message'

/**
 * 私信未读数。
 *
 * 模块级单例：导航角标与聊天页共享同一份状态，
 * 打开会话（拉取消息即已读）后角标能立刻清零。
 */
const unreadCount = ref(0)

const refresh = async () => {
  try {
    const result = await unreadTotal()
    unreadCount.value = result.unreadTotal
  } catch {
    // 角标属于辅助信息，失败时静默保持原值
  }
}

const setUnreadCount = (value: number) => {
  unreadCount.value = value
}

export const useMessageStore = () => ({
  unreadCount,
  refresh,
  setUnreadCount,
})
