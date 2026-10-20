import { ref } from 'vue'

/**
 * 会议计时器。
 *
 * 时间只在「未暂停」时累计：暂停时把本段已走过的秒数固化进
 * elapsedSeconds，并把本段起点置空；恢复时重新取一个起点。
 * 这样 duration 与录音文件的时间轴始终一致（暂停期间不计入）。
 */
export const useMeetingTimer = () => {
  /** 已累计的会议时长（秒），不含暂停期间 */
  const elapsedSeconds = ref(0)

  /** 本段计时的起点；暂停时置为 null，表示计时已冻结 */
  let segmentStartedAt: number | null = null

  /** 当前会议持续秒数，供界面展示与分钟标记使用 */
  const duration = ref(0)

  let timer: number | null = null

  /** 将秒数格式化为 HH:MM:SS */
  const format = (seconds: number) => {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    const remainingSeconds = seconds % 60

    return [hours, minutes, remainingSeconds]
      .map((value) => String(value).padStart(2, '0'))
      .join(':')
  }

  /** 停止计时器；不清空已累计的时长。 */
  const stop = () => {
    if (timer !== null) {
      window.clearInterval(timer)
      timer = null
    }
  }

  /**
   * 启动计时器。
   *
   * 每 tick 用「已累计秒数 + 本段已走秒数」计算总时长，
   * 这样暂停期间时间不会被计入。
   */
  const start = () => {
    stop()

    timer = window.setInterval(() => {
      if (segmentStartedAt === null) {
        return
      }

      duration.value =
        elapsedSeconds.value +
        Math.floor((Date.now() - segmentStartedAt) / 1000)
    }, 1000)
  }

  /**
   * 冻结计时：把本段已走过的秒数累加进总时长。
   *
   * 调用方要在停止语音识别之前调用，避免 stop 到 onend
   * 之间的时间被算进去。
   */
  const freeze = () => {
    if (segmentStartedAt !== null) {
      elapsedSeconds.value += Math.floor(
        (Date.now() - segmentStartedAt) / 1000
      )
      segmentStartedAt = null
    }

    duration.value = elapsedSeconds.value

    stop()
  }

  /** 从暂停中恢复：重新取本段起点（不自动起表，由调用方决定）。 */
  const resume = () => {
    segmentStartedAt = Date.now()
  }

  /** 归零并停表。 */
  const reset = () => {
    stop()

    elapsedSeconds.value = 0
    duration.value = 0
    segmentStartedAt = null
  }

  /** 一场新会议：清零后立刻记录本段起点。 */
  const begin = () => {
    reset()

    segmentStartedAt = Date.now()
  }

  return {
    duration,
    format,
    start,
    stop,
    begin,
    resume,
    freeze,
    reset,
  }
}
