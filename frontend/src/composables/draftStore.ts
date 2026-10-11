import { reactive } from 'vue'
import { getDraftMeetings } from '../api/meeting'

export interface DraftStore {
  count: number
  refresh: () => Promise<void>
  increment: () => void
  decrement: () => void
}

/**
 * MeetMind 全局草稿箱状态
 *
 * 整个应用只使用这一份响应式对象。
 */
const draftStore = reactive<DraftStore>({
  count: 0,

  /**
   * 从后端重新获取草稿数量
   */
  async refresh() {
    try {
      const drafts = await getDraftMeetings()

      draftStore.count = drafts.length
    } catch (error) {
      console.error(
        '草稿箱数量刷新失败：',
        error
      )
    }
  },

  /**
   * 新增草稿后立即 +1
   */
  increment() {
    draftStore.count += 1
  },

  /**
   * 删除/重新生成成功后立即 -1
   */
  decrement() {
    draftStore.count = Math.max(
      draftStore.count - 1,
      0
    )
  }
})

/**
 * App.vue 获取全局 Store
 */
export const provideDraftStore = () => {
  return draftStore
}

/**
 * HomeView / DraftsView 获取同一个全局 Store
 */
export const useDraftStore = () => {
  return draftStore
}