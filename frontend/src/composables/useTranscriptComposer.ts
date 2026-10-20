import { ref, type Ref } from 'vue'

interface TranscriptComposerOptions {
  /** 会议时长（秒），来源是只累计非暂停时间的计时器 */
  duration: Ref<number>
  /** 是否在录音；只有真的在录音时才打分钟标记 */
  isAudioRecording: Ref<boolean>
}

/**
 * 会议原文合成器。
 *
 * 负责把零散的识别结果拼成一篇可读的会议原文，并按录音时长
 * 打上 [MM:SS] 分钟标记，让每段文字都能对应到音频上的位置。
 */
export const useTranscriptComposer = ({
  duration,
  isAudioRecording,
}: TranscriptComposerOptions) => {
  const content = ref('')

  /**
   * 已经打过分钟标记的分钟数。
   *
   * 初始为 0：第 0 分钟不打标记，这样「用户先手打一段文字，再开始录音」
   * 时不会在已有文字中间硬插一个标记。从第 1 分钟起每分钟打一个。
   */
  let lastMarkedMinute = 0

  /** 把秒数格式化为 MM:SS（超过一小时为 H:MM:SS），与录音时间轴一致。 */
  const formatMinuteMark = (seconds: number) => {
    const total = Math.max(0, Math.floor(seconds))
    const hours = Math.floor(total / 3600)
    const minutes = Math.floor((total % 3600) / 60)
    const secs = total % 60

    const mm = String(minutes).padStart(2, '0')
    const ss = String(secs).padStart(2, '0')

    return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`
  }

  /**
   * 追加一段文字。
   *
   * 时间源是 duration —— 它只累计「未暂停」的时长，
   * 因此标记与录音文件的时间轴对齐（暂停期间不计入）。
   *
   * 第 0 分钟不加标记；跨到下一分钟时先插入 [MM:SS] 再追加文本，
   * 于是每段文字都归属它前面那个时间点。
   */
  const append = (text: string) => {
    const chunk = text.trim()

    if (!chunk) {
      return
    }

    let prefix = ''

    if (isAudioRecording.value) {
      const currentMinute = Math.floor(duration.value / 60)

      if (currentMinute > lastMarkedMinute) {
        // 跨分钟时只补一个标记；一次跳过多分钟（例如长时间停顿）
        // 也按当前分钟打点，避免插入一串空段落
        prefix = `[${formatMinuteMark(currentMinute * 60)}]`
        lastMarkedMinute = currentMinute
      }
    }

    const body = content.value.trim()
      ? `${content.value}${prefix ? ` ${prefix}` : ''} ${chunk}`
      : `${prefix ? `${prefix} ` : ''}${chunk}`

    content.value = body
  }

  /** 新一场会议从第 0 分钟重新开始打标记。 */
  const resetMinuteMark = () => {
    lastMarkedMinute = 0
  }

  /** 清空原文并重置标记（换一场会议时使用）。 */
  const clear = () => {
    content.value = ''
    resetMinuteMark()
  }

  return {
    content,
    append,
    resetMinuteMark,
    clear,
  }
}
