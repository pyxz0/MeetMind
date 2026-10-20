import { reactive } from 'vue'

/**
 * 录音状态（跨页面共享）。
 *
 * 纪要页被 KeepAlive 缓存后会一直运行录音与转写，
 * 用户可能切到别的页面。这里把「是否在录音」同步到全局，
 * 让侧边栏/浮层能提示「后台仍在录音」，避免录了一小时却忘了。
 */
export const recordingStatus = reactive({
  recording: false,
  paused: false,
  /** 已录制秒数，不含暂停期间 */
  seconds: 0,
})

export const syncRecordingStatus = (patch: {
  recording?: boolean
  paused?: boolean
  seconds?: number
}) => {
  if (patch.recording !== undefined) {
    recordingStatus.recording = patch.recording
  }

  if (patch.paused !== undefined) {
    recordingStatus.paused = patch.paused
  }

  if (patch.seconds !== undefined) {
    recordingStatus.seconds = patch.seconds
  }
}

/** 把秒数格式化成 HH:MM:SS，供浮层展示 */
export const formatRecordingTime = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60

  return [h, m, s]
    .map((v) => String(v).padStart(2, '0'))
    .join(':')
}
