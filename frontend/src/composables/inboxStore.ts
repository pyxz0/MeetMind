import { ref } from 'vue'
import { getInboxUnreadCount } from '../api/inbox'

/**
 * 收件箱未读数。
 *
 * 用一个模块级单例保存：侧边栏角标与收件箱页共享同一份状态，
 * 在收件箱里「标记已读」后角标能立刻清零，无需刷新页面。
 */
const unreadCount = ref(0)

const refresh = async () => {
  try {
    const result = await getInboxUnreadCount()
    unreadCount.value = result.unreadCount
  } catch {
    // 角标属于辅助信息，失败时静默保持原值
  }
}

const setUnreadCount = (value: number) => {
  unreadCount.value = value
}

export const useInboxStore = () => ({
  unreadCount,
  refresh,
  setUnreadCount,
})
