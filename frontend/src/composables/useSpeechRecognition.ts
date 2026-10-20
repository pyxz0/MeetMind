import { ref } from 'vue'

/**
 * 浏览器 SpeechRecognition 最小类型定义。
 * 部分 Chromium 浏览器使用 webkitSpeechRecognition 前缀，
 * 因此这里同时兼容两种写法。
 */
interface SpeechRecognitionAlternativeLike {
  transcript: string
  confidence: number
}

interface SpeechRecognitionResultLike {
  isFinal: boolean
  length: number

  [index: number]: SpeechRecognitionAlternativeLike
}

interface SpeechRecognitionResultListLike {
  length: number

  [index: number]: SpeechRecognitionResultLike
}

interface SpeechRecognitionEventLike extends Event {
  resultIndex: number
  results: SpeechRecognitionResultListLike
}

interface SpeechRecognitionErrorEventLike extends Event {
  error: string
  message?: string
}

interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number

  start: () => void
  stop: () => void
  abort: () => void

  onstart: (() => void) | null
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null
  onend: (() => void) | null
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike

interface SpeechRecognitionWindow {
  SpeechRecognition?: SpeechRecognitionConstructor
  webkitSpeechRecognition?: SpeechRecognitionConstructor
}

interface SpeechRecognitionOptions {
  /** 识别到最终文本时回调，由调用方决定写到哪里、是否打分钟标记 */
  onFinalText: (text: string) => void
  /** 麦克风被拒绝 / 识别服务不可用时回调，由调用方收尾（停表、提示） */
  onBlocked?: () => void
}

/**
 * 浏览器语音识别（SpeechRecognition）。
 *
 * 只负责识别服务的生命周期：中间结果、错误、自动重连，以及
 * 「用户主动停止」与「浏览器自动断开」的区分。文本落到哪里、
 * 计时和录音怎么配合，都交给调用方，因此这里不碰计时器。
 */
export const useSpeechRecognition = ({
  onFinalText,
  onBlocked,
}: SpeechRecognitionOptions) => {
  const speechSupported = ref(true)

  const isRecording = ref(false)

  /**
   * 会议是否处于暂停状态。
   *
   * 只有 isRecording 为 true 时才可能为 true。
   * 暂停期间不转写，但会议内容保持不变。
   */
  const isPaused = ref(false)

  /** 正在识别中的中间结果，仅用于实时展示 */
  const interimTranscript = ref('')

  const recognition = ref<SpeechRecognitionLike | null>(null)

  /**
   * 浏览器没有提供 SpeechRecognition.pause()，
   * 因此暂停只能通过 stop() 实现，并靠该标志区分
   * “用户主动暂停”和“浏览器自动断开”，避免 onend 把识别重新拉起。
   */
  let stoppedByUser = false

  const getConstructor = () => {
    const speechWindow = window as unknown as SpeechRecognitionWindow

    return (
      speechWindow.SpeechRecognition ||
      speechWindow.webkitSpeechRecognition ||
      null
    )
  }

  /** 识别服务结束。 */
  const handleEnd = (instance: SpeechRecognitionLike) => {
    if (!isRecording.value || stoppedByUser) {
      return
    }

    // 某些浏览器会在持续识别过程中自动断开，用户仍在录音则自动重新启动。
    window.setTimeout(() => {
      if (!isRecording.value || stoppedByUser) {
        return
      }

      try {
        instance.start()
      } catch {
        // 浏览器正在重启识别时可能抛出异常，这里忽略即可。
      }
    }, 300)
  }

  /**
   * 初始化语音识别。
   *
   * 返回当前浏览器是否可用；不可用时 speechSupported 会置为 false。
   */
  const ensure = () => {
    if (recognition.value) {
      return true
    }

    const SpeechRecognitionClass = getConstructor()

    if (!SpeechRecognitionClass) {
      speechSupported.value = false
      return false
    }

    const instance = new SpeechRecognitionClass()

    // 中文普通话
    instance.lang = 'zh-CN'

    // 持续识别
    instance.continuous = true

    // 实时返回中间结果
    instance.interimResults = true

    // 只取最优结果
    instance.maxAlternatives = 1

    instance.onstart = () => {
      isRecording.value = true
    }

    instance.onresult = (event) => {
      let interim = ''
      let finalText = ''

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const currentResult = event.results[i]

        const transcript = currentResult[0]?.transcript || ''

        if (currentResult.isFinal) {
          finalText += transcript
        } else {
          interim += transcript
        }
      }

      // 实时显示正在识别中的文字
      interimTranscript.value = interim

      // 最终识别结果写入会议原文，必要时先打上分钟标记
      if (finalText.trim()) {
        onFinalText(finalText)

        // 最终结果已落盘，清掉可能并存的中间结果
        interimTranscript.value = ''
      }
    }

    instance.onerror = (event) => {
      console.error('语音识别错误：', event.error, event.message)

      if (
        event.error === 'not-allowed' ||
        event.error === 'service-not-allowed'
      ) {
        isRecording.value = false
        isPaused.value = false

        onBlocked?.()
      }
    }

    instance.onend = () => handleEnd(instance)

    recognition.value = instance

    return true
  }

  /**
   * 把正在识别中的中间结果落定为最终文本。
   *
   * 停止识别前必须先调用：interimTranscript 里可能已经有内容，
   * 若不落定，暂停瞬间的这句话会直接丢失。
   */
  const flush = () => {
    const text = interimTranscript.value

    interimTranscript.value = ''

    if (text.trim()) {
      onFinalText(text)
    }
  }

  /**
   * 开始识别；失败时抛给调用方决定怎么提示。
   *
   * 调用方需先 ensure() 成功，并自行把 isRecording 置为 true。
   */
  const start = () => {
    stoppedByUser = false

    recognition.value?.start()
  }

  /**
   * 暂停识别。
   *
   * 先标记为“用户主动停止”，避免 onend 把识别自动拉起。
   */
  const pause = () => {
    stoppedByUser = true

    try {
      recognition.value?.stop()
    } catch (error) {
      console.error('暂停语音识别失败：', error)
    }
  }

  /** 结束识别。 */
  const stop = () => {
    stoppedByUser = true

    isRecording.value = false
    isPaused.value = false

    try {
      recognition.value?.stop()
    } catch (error) {
      console.error('停止语音识别失败：', error)
    }
  }

  /** 从暂停中恢复识别；失败时抛给调用方决定怎么回退。 */
  const resume = () => {
    stoppedByUser = false

    isPaused.value = false

    recognition.value?.start()
  }

  /** 页面卸载时释放识别资源。 */
  const dispose = () => {
    isRecording.value = false
    isPaused.value = false
    stoppedByUser = true
    interimTranscript.value = ''

    try {
      recognition.value?.abort()
    } catch {
      // 忽略卸载阶段的异常
    }
  }

  return {
    speechSupported,
    isRecording,
    isPaused,
    interimTranscript,
    ensure,
    start,
    pause,
    stop,
    resume,
    flush,
    dispose,
  }
}
