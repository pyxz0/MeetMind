<script setup lang="ts">
import { onBeforeUnmount, ref, watchEffect } from 'vue'
import { syncRecordingStatus } from '../composables/recordingStatus'
import { ElMessage } from 'element-plus'
import {
  generateMeeting,
  createDraftMeeting,
  uploadMeetingAudio,
  type MeetingResult,
} from '../api/meeting'

import { useDraftStore } from '../composables/draftStore'
import MeetingResultComponent from '../components/MeetingResult.vue'

defineOptions({ name: 'MinutesInstant' })

const draftStore = useDraftStore()

/**
 * 把录音状态同步到全局，供其他页面的「后台录音中」提示使用。
 * 每秒随会议计时刷新一次。
 */
watchEffect(() => {
  syncRecordingStatus({
    recording: isRecording.value,
    paused: isPaused.value,
    seconds: meetingDuration.value,
  })
})

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

type SpeechRecognitionConstructor =
  new () => SpeechRecognitionLike

interface SpeechRecognitionWindow {
  SpeechRecognition?: SpeechRecognitionConstructor
  webkitSpeechRecognition?: SpeechRecognitionConstructor
}

/* =========================
   会议内容 / AI 结果
   ========================= */

const meetingContent = ref('')

const result = ref<MeetingResult | null>(null)

const loading = ref(false)

const draftSaving = ref(false)

/* =========================
   语音识别状态
   ========================= */

const isRecording = ref(false)

/**
 * 会议是否处于暂停状态。
 *
 * 只有 isRecording 为 true 时才可能为 true。
 * 暂停期间不转写、不计时，但会议内容保持不变。
 */
const isPaused = ref(false)

/**
 * 浏览器没有提供 SpeechRecognition.pause()，
 * 因此暂停只能通过 stop() 实现，并靠该标志区分
 * “用户主动暂停”和“浏览器自动断开”，避免 onend 把识别重新拉起。
 */
let recognitionStoppedByUser = false

const interimTranscript = ref('')

/** 已累计的会议时长（秒），不含暂停期间 */
const meetingElapsedSeconds = ref(0)

/** 本段计时的起点；暂停时置为 null，表示计时已冻结 */
let meetingSegmentStartedAt: number | null = null

/** 当前会议持续秒数 */
const meetingDuration = ref(0)

/** 将秒数格式化为 HH:MM:SS */
const formatMeetingDuration = (seconds: number) => {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainingSeconds = seconds % 60

  return [
    hours,
    minutes,
    remainingSeconds,
  ]
    .map(value => String(value).padStart(2, '0'))
    .join(':')
}

/** 会议计时器 */
let meetingTimer: number | null = null

const speechSupported = ref(true)

/* =========================
   会议录音（MediaRecorder）
   ========================= */

/** 当前浏览器是否具备音频录制能力 */
const audioSupported =
  typeof window !== 'undefined' &&
  typeof MediaRecorder !== 'undefined' &&
  !!navigator.mediaDevices?.getUserMedia

/** 本次会议是否真的在录音；麦克风不可用时为 false，但仍可继续转写 */
const isAudioRecording = ref(false)

/** 麦克风授权失败时置位，用于提示用户只有文字没有录音 */
const audioBlocked = ref(false)

let mediaRecorder: MediaRecorder | null = null

/** 麦克风音轨，停止后必须显式关闭，否则浏览器会一直显示录音中 */
let microphoneStream: MediaStream | null = null

let recordedChunks: Blob[] = []

/** 实际使用的录音容器类型，如 audio/webm;codecs=opus */
let recordedMimeType = ''

/** 会议结束时暂存录音，等待拿到会议 ID 后上传 */
let pendingAudioBlob: Blob | null = null

/** 与暂存录音对应的时长（秒），上传时一并写入数据库 */
let pendingAudioDuration = 0

/**
 * 依次尝试的录音容器。
 *
 * 各浏览器支持情况不同：Chrome/Edge 用 webm(opus)，
 * Safari 用 mp4，Firefox 用 ogg。isTypeSupported 返回 false
 * 时继续尝试下一个。
 */
const AUDIO_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
]

const pickAudioMimeType = () => {
  if (typeof MediaRecorder?.isTypeSupported !== 'function') {
    return ''
  }

  return (
    AUDIO_MIME_CANDIDATES.find((type) =>
      MediaRecorder.isTypeSupported(type)
    ) || ''
  )
}

const recognition = ref<SpeechRecognitionLike | null>(null)

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
 * 按录音时长给会议原文打分钟标记。
 *
 * 时间源是 meetingDuration —— 它只累计「未暂停」的时长，
 * 因此标记与录音文件的时间轴对齐（暂停期间不计入）。
 *
 * 第 0 分钟不加标记；跨到下一分钟时先插入 [MM:SS] 再追加文本，
 * 于是每段文字都归属它前面那个时间点。
 */
const appendTranscript = (text: string) => {
  const chunk = text.trim()

  if (!chunk) {
    return
  }

  let prefix = ''

  if (isAudioRecording.value) {
    const currentMinute = Math.floor(meetingDuration.value / 60)

    if (currentMinute > lastMarkedMinute) {
      // 跨分钟时只补一个标记；一次跳过多分钟（例如长时间停顿）
      // 也按当前分钟打点，避免插入一串空段落
      prefix = `[${formatMinuteMark(currentMinute * 60)}]`
      lastMarkedMinute = currentMinute
    }
  }

  const body = meetingContent.value.trim()
    ? `${meetingContent.value}${prefix ? ` ${prefix}` : ''} ${chunk}`
    : `${prefix ? `${prefix} ` : ''}${chunk}`

  meetingContent.value = body
}

/**
 * 把正在识别中的中间结果落定为最终文本。
 *
 * 停止识别前必须先调用：interimTranscript 里可能已经有内容，
 * 若不落定，暂停瞬间的这句话会直接丢失。
 */
const flushInterimTranscript = () => {
  appendTranscript(interimTranscript.value)

  interimTranscript.value = ''
}

/**
 * 启动计时器。
 *
 * 每 tick 用「已累计秒数 + 本段已走秒数」计算总时长，
 * 这样暂停期间时间不会被计入。
 */
const startMeetingTimer = () => {
  stopMeetingTimer()

  meetingTimer = window.setInterval(() => {
    if (meetingSegmentStartedAt === null) {
      return
    }

    meetingDuration.value =
      meetingElapsedSeconds.value +
      Math.floor(
        (Date.now() - meetingSegmentStartedAt) / 1000
      )
  }, 1000)
}

/** 停止计时器；不清空已累计的时长。 */
const stopMeetingTimer = () => {
  if (meetingTimer !== null) {
    window.clearInterval(meetingTimer)
    meetingTimer = null
  }
}

/**
 * 获取浏览器语音识别构造函数。
 */
const getSpeechRecognitionConstructor = () => {
  const speechWindow =
    window as unknown as SpeechRecognitionWindow

  return (
    speechWindow.SpeechRecognition ||
    speechWindow.webkitSpeechRecognition ||
    null
  )
}

/**
 * 初始化语音识别。
 */
const initSpeechRecognition = () => {
  if (recognition.value) {
    return
  }

  const SpeechRecognitionClass =
    getSpeechRecognitionConstructor()

  if (!SpeechRecognitionClass) {
    speechSupported.value = false
    return
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

  /**
   * 开始监听
   */
  instance.onstart = () => {
    isRecording.value = true
  }

  /**
   * 收到识别结果
   */
  instance.onresult = (event) => {
    let interim = ''
    let finalText = ''

    for (
      let i = event.resultIndex;
      i < event.results.length;
      i++
    ) {
      const currentResult = event.results[i]

      const transcript =
        currentResult[0]?.transcript || ''

      if (currentResult.isFinal) {
        finalText += transcript
      } else {
        interim += transcript
      }
    }

    // 实时显示正在识别中的文字
    interimTranscript.value = interim

    // 最终识别结果写入会议内容，必要时先打上分钟标记
    if (finalText.trim()) {
      appendTranscript(finalText)

      // 最终结果已落盘，清掉可能并存的中间结果
      interimTranscript.value = ''
    }
  }

  /**
   * 识别错误
   */
  instance.onerror = (event) => {
    console.error(
      '语音识别错误：',
      event.error,
      event.message
    )

    if (
      event.error === 'not-allowed' ||
      event.error === 'service-not-allowed'
    ) {
      isRecording.value = false
      isPaused.value = false

      stopMeetingTimer()
      meetingSegmentStartedAt = null

      ElMessage.error(
        '无法使用麦克风，请允许浏览器访问麦克风'
      )
    }
  }

  /**
   * 识别服务结束。
   *
   * 某些浏览器会在持续识别过程中自动断开，
   * 如果用户仍在录音则自动重新启动。
   *
   * 注意：暂停和停止都是通过 stop() 实现的，所以必须同时判断
   * recognitionStoppedByUser，否则暂停后识别会被这里立刻拉起来。
   * 该标志在 onend 触发时才读取，因此 stop() 与 onend 之间的
   * 异步间隙不会造成误判。
   */
  instance.onend = () => {
    if (!isRecording.value || recognitionStoppedByUser) {
      return
    }

    window.setTimeout(() => {
      if (!isRecording.value || recognitionStoppedByUser) {
        return
      }

      try {
        instance.start()
      } catch {
        // 浏览器正在重启识别时可能抛出异常，这里忽略即可。
      }
    }, 300)
  }

  recognition.value = instance
}

/**
 * 开始录音。
 *
 * 返回是否成功进入录音状态；失败不阻断转写，只是这场会议没有音频。
 */
const startAudioRecording = async () => {
  if (!audioSupported) {
    return false
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // 会议场景下抑制回声与环境噪声，人声更清楚。
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })

    microphoneStream = stream
    recordedChunks = []
    recordedMimeType = pickAudioMimeType()

    mediaRecorder = recordedMimeType
      ? new MediaRecorder(stream, { mimeType: recordedMimeType })
      : new MediaRecorder(stream)

    // 用 recorder 实际生效的类型，它可能与我们请求的不同。
    recordedMimeType =
      mediaRecorder.mimeType || recordedMimeType || 'audio/webm'

    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        recordedChunks.push(event.data)
      }
    }

    /**
     * 每秒切一个分片。
     *
     * 默认是停止时才吐一次数据，长时间会议会把整段音频
     * 攒在内存里；分片后即使中断也只损失最后一秒。
     */
    mediaRecorder.start(1000)

    isAudioRecording.value = true
    audioBlocked.value = false

    return true
  } catch (error) {
    console.error('麦克风录音启动失败：', error)

    isAudioRecording.value = false
    audioBlocked.value = true

    return false
  }
}

/** 暂停录音，与转写暂停保持同一时刻，保证音频与文字对得上。 */
const pauseAudioRecording = () => {
  if (mediaRecorder?.state === 'recording') {
    try {
      mediaRecorder.pause()
    } catch (error) {
      console.error('暂停录音失败：', error)
    }
  }
}

/** 恢复录音，同样与转写恢复同一时刻。 */
const resumeAudioRecording = () => {
  if (mediaRecorder?.state === 'paused') {
    try {
      mediaRecorder.resume()
    } catch (error) {
      console.error('恢复录音失败：', error)
    }
  }
}

/**
 * 结束录音并收拢成可上传的音频。
 *
 * 暂停状态下调 stop() 可能在部分浏览器抛异常，
 * 因此先 resume 让 recorder 回到 recording 态。
 */const stopAudioRecording = async (): Promise<Blob | null> => {
  const recorder = mediaRecorder

  if (!recorder || recorder.state === 'inactive') {
    isAudioRecording.value = false
    return null
  }

  const result = await new Promise<Blob | null>((resolve) => {
    let settled = false

    const finish = () => {
      if (settled) {
        return
      }

      settled = true

      // 停止后仍挂在 ondataavailable 上的分片要一并收进来。
      if (recorder.state === 'inactive') {
        try {
          const tail = (recorder as unknown as {
            requestData?: () => void
          }).requestData

          if (typeof tail === 'function') {
            tail.call(recorder)
          }
        } catch {
          // requestData 在 inactive 状态下可能不被允许，忽略即可。
        }
      }

      resolve(
        recordedChunks.length
          ? new Blob(recordedChunks, {
            type: recordedMimeType || 'audio/webm',
          })
          : null
      )
    }

    recorder.onstop = finish

    // 兜底：某些浏览器不触发 onstop，避免整个上传流程卡死。
    window.setTimeout(finish, 3000)

    try {
      if (recorder.state === 'paused') {
        recorder.resume()
      }

      recorder.stop()
    } catch (error) {
      console.error('结束录音失败：', error)
      finish()
    }
  })

  // 关掉麦克风，否则标签页会一直显示正在录音。
  releaseMicrophone()

  isAudioRecording.value = false
  mediaRecorder = null

  if (!result || result.size === 0) {
    return null
  }

  return result
}

/** 释放麦克风、丢弃已录内容。 */
const releaseMicrophone = () => {
  microphoneStream?.getTracks().forEach((track) => track.stop())
  microphoneStream = null

  mediaRecorder = null
  recordedChunks = []
  isAudioRecording.value = false
}

/**
 * 结束录音并等待音频就绪。
 *
 * handleStopRecording 为了不阻塞调用方，是用 void 触发 stopAudioRecording 的；
 * 上传前必须在这里等它真正收拢完成，否则会拿到 null。
 */
const finalizeAudioRecording = async () => {
  // 已经收拢过就不重复处理（例如结束后又点了保存草稿）。
  if (pendingAudioBlob) {
    return pendingAudioBlob
  }

  if (!mediaRecorder) {
    return null
  }

  const blob = await stopAudioRecording()

  if (blob) {
    pendingAudioBlob = blob
  }

  return pendingAudioBlob
}

/** 清空暂存录音，避免串到下一场会议。 */
const resetPendingAudio = () => {
  pendingAudioBlob = null
  pendingAudioDuration = 0
  recordedChunks = []
  isAudioRecording.value = false
  releaseMicrophone()
}

/**
 * 会议结束后上传录音。
 *
 * 上传失败只提示，不影响已经生成的纪要。
 */
const uploadRecordedAudio = async (
  meetingId: number,
  durationSec: number,
  successText: string
) => {
  const blob = pendingAudioBlob

  if (!blob) {
    return
  }

  try {
    await uploadMeetingAudio(meetingId, blob, durationSec)

    pendingAudioBlob = null

    ElMessage.success(successText)
  } catch (error) {
    console.error('录音上传失败：', error)

    ElMessage.warning('录音上传失败，本次会议未保存音频')
  }
}

/**
 * 开始会议语音识别。
 */
const handleStartRecording = async () => {
  initSpeechRecognition()

  if (!speechSupported.value) {
    ElMessage.warning(
      '当前浏览器暂不支持语音识别，请更换支持 SpeechRecognition 的浏览器'
    )

    return
  }

  if (!recognition.value || isRecording.value) {
    return
  }

  interimTranscript.value = ''
  isRecording.value = true
  isPaused.value = false
  recognitionStoppedByUser = false

  // 累计时长清零，并记录本段计时起点
  meetingElapsedSeconds.value = 0
  meetingDuration.value = 0
  meetingSegmentStartedAt = Date.now()

  // 新一场会议从第 0 分钟重新开始打标记
  lastMarkedMinute = 0

  // 先起录音：麦克风授权是异步的，若拒绝也只降级为“无音频”，不影响转写
  pendingAudioBlob = null
  const audioStarted = await startAudioRecording()

  startMeetingTimer()

  try {
    recognition.value.start()

    if (audioStarted) {
      ElMessage.success('已开始实时语音转文字，并同步录制会议音频')
    } else if (!audioSupported) {
      ElMessage.success('已开始实时语音转文字（当前浏览器不支持录音）')
    } else {
      ElMessage.warning('已开始转写，但麦克风不可用，本次会议不会保存音频')
    }
  } catch (error) {
    console.error(
      '启动语音识别失败：',
      error
    )

    isRecording.value = false
    stopMeetingTimer()

    // 转写没起来就不该继续占用麦克风
    releaseMicrophone()

    ElMessage.error(
      '语音识别启动失败，请重试'
    )
  }
}

/**
 * 暂停会议语音识别。
 *
 * 暂停期间不转写、计时冻结，已识别的内容全部保留。
 */
const handlePauseRecording = () => {
  if (
    !recognition.value ||
    !isRecording.value ||
    isPaused.value
  ) {
    return
  }

  // 先标记为“用户主动停止”，避免 onend 把识别自动拉起
  recognitionStoppedByUser = true

  // 冻结计时：把本段已走过的秒数累加进总时长。
  // 放在 stop() 之前计算，避免 stop 到 onend 之间的时间被算进去。
  if (meetingSegmentStartedAt !== null) {
    meetingElapsedSeconds.value += Math.floor(
      (Date.now() - meetingSegmentStartedAt) / 1000
    )
    meetingSegmentStartedAt = null
  }

  meetingDuration.value = meetingElapsedSeconds.value

  stopMeetingTimer()

  // 暂停瞬间的中间结果必须落定，否则这句话会丢
  flushInterimTranscript()

  try {
    recognition.value.stop()
  } catch (error) {
    console.error('暂停语音识别失败：', error)
  }

  // 录音与转写同一时刻暂停，音频时间轴才能和文字对得上
  pauseAudioRecording()

  isPaused.value = true

  ElMessage.info('已暂停转写与录音，计时同步暂停')
}

/**
 * 恢复会议语音识别，继续追加到同一篇会议原文。
 */
const handleResumeRecording = () => {
  if (
    !recognition.value ||
    !isRecording.value ||
    !isPaused.value
  ) {
    return
  }

  isPaused.value = false
  recognitionStoppedByUser = false

  // 重新开始累计计时
  meetingSegmentStartedAt = Date.now()

  startMeetingTimer()

  // 录音与转写同时恢复
  resumeAudioRecording()

  try {
    recognition.value.start()

    ElMessage.success('已恢复转写与录音')
  } catch (error) {
    console.error('恢复语音识别失败：', error)

    // 恢复失败则回退到暂停态，保证界面与服务状态一致
    isPaused.value = true
    meetingSegmentStartedAt = null
    stopMeetingTimer()

    ElMessage.error('恢复转写失败，请重试')
  }
}

/**
 * 结束会议并自动生成 AI 会议纪要。
 */
const handleFinishMeeting = async () => {
  handleStopRecording()

  // 等录音收拢完成，拿到本次会议的音频
  await finalizeAudioRecording()

  if (!meetingContent.value.trim()) {
    ElMessage.warning('暂未识别到会议内容')

    resetPendingAudio()

    return
  }

  loading.value = true

  try {
    const meeting = await generateMeeting({
      content: meetingContent.value,
    })

    if (!meeting || !meeting.id) {
      throw new Error('后端未返回会议 ID，无法关联录音')
    }

    result.value = meeting

    ElMessage.success('会议结束，AI 纪要已生成')

    // 纪要已生成，再把录音挂到这条会议记录上
    await uploadRecordedAudio(
      meeting.id,
      pendingAudioDuration,
      '会议录音已保存'
    )
  } catch (error) {
    console.error(error)

    ElMessage.error(
      'AI 纪要生成失败，请检查后端服务是否正常'
    )
  } finally {
    loading.value = false
    resetPendingAudio()
  }
}

/**
 * 停止会议语音识别。
 */
const handleStopRecording = () => {
  if (!recognition.value) {
    return
  }

  // 主动停止，禁止 onend 自动重启；同时也解除暂停态
  recognitionStoppedByUser = true

  isRecording.value = false
  isPaused.value = false

  stopMeetingTimer()

  // 结束前的中间结果同样要落定
  flushInterimTranscript()

  // 收拢录音：必须在重置时长之前取 duration，
  // 上传时要用它作为音频时长写进数据库。
  const audioDuration = meetingDuration.value

  // 不 await：调用方需要立刻拿到控制权去发起纪要生成。
  void stopAudioRecording().then((blob) => {
    if (blob) {
      pendingAudioBlob = blob
      pendingAudioDuration = audioDuration
    }
  })

  meetingSegmentStartedAt = null
  meetingElapsedSeconds.value = 0
  meetingDuration.value = 0

  try {
    recognition.value.stop()
  } catch (error) {
    console.error(
      '停止语音识别失败：',
      error
    )
  }

  ElMessage.info(
    '已停止实时语音转文字'
  )
}

/** 将当前会议原文手动保存到草稿箱 */
const handleSaveDraft = async () => {
  if (isRecording.value) {
    handleStopRecording()

    // 草稿同样保留录音，便于之后回听补齐纪要
    await finalizeAudioRecording()
  }

  if (!meetingContent.value.trim()) {
    ElMessage.warning('请先输入或录入会议内容')
    return
  }

  draftSaving.value = true

  try {
    const draft = await createDraftMeeting({
      title: '会议草稿',
      content: meetingContent.value.trim(),
    })

    // 数据库保存成功后立即更新顶部徽标
    draftStore.increment()

    ElMessage.success('会议已加入草稿箱')

    if (draft?.id && pendingAudioBlob) {
      await uploadRecordedAudio(
        draft.id,
        pendingAudioDuration,
        '草稿录音已保存'
      )
    }
  } catch (error) {
    console.error('保存草稿失败：', error)

    ElMessage.error('加入草稿箱失败，请重试')
  } finally {
    draftSaving.value = false
    resetPendingAudio()
  }
}

/**
 * 校验文本后调用生成接口，
 * 并将请求状态和结果反馈到页面。
 */
const handleGenerate = async () => {
  if (isRecording.value) {
    handleStopRecording()

    await finalizeAudioRecording()
  }

  if (!meetingContent.value.trim()) {
    ElMessage.warning('请输入会议内容')

    return
  }

  loading.value = true

  try {
    const meeting = await generateMeeting({
      content: meetingContent.value,
    })

    result.value = meeting

    ElMessage.success('会议纪要生成成功')

    // 边录边生成时同样把录音挂到这条记录上
    if (meeting?.id && pendingAudioBlob) {
      await uploadRecordedAudio(
        meeting.id,
        pendingAudioDuration,
        '会议录音已保存'
      )
    }
  } catch (error) {
    console.error(error)

    ElMessage.error(
      '会议纪要生成失败，请检查后端服务是否启动'
    )
  } finally {
    loading.value = false
    resetPendingAudio()
  }
}

/**
 * 清空输入和当前结果，
 * 同时停止语音识别。
 */
const handleClear = async () => {
  if (isRecording.value) {
    handleStopRecording()

    // 丢掉这段录音，不让它跟着下一场会议一起上传
    await finalizeAudioRecording()
  }

  resetPendingAudio()

  meetingContent.value = ''
  interimTranscript.value = ''
  result.value = null

  // 清空后重新计数，避免下一场会议的标记从上一次的分钟数续上
  lastMarkedMinute = 0
}

/**
 * 页面卸载时释放语音识别资源。
 */
onBeforeUnmount(() => {
  isRecording.value = false
  isPaused.value = false
  recognitionStoppedByUser = true
  interimTranscript.value = ''

  try {
    recognition.value?.abort()
  } catch {
    // 忽略卸载阶段的异常
  }

  // 离开页面必须关掉麦克风，否则浏览器会一直显示录音中
  releaseMicrophone()

  stopMeetingTimer()
  meetingSegmentStartedAt = null
})
</script>

<template>
  <div class="home-page">
    <div class="page-container">

      <!-- 页面标题 -->
      <div class="page-header">
        <div>
          <h1>智能会议纪要</h1>

          <p>
            输入会议内容，让 AI 自动提取摘要、决策和待办事项
          </p>
        </div>
      </div>

      <!-- 输入区域 -->
      <el-card class="input-card" shadow="never">
        <template #header>
          <div class="card-header">
            <span>会议内容</span>

            <el-button text :disabled="loading" @click="handleClear">
              清空
            </el-button>
          </div>
        </template>

        <el-input v-model="meetingContent" type="textarea" :rows="12" resize="none" placeholder="请输入会议内容，例如：

今天下午召开产品需求讨论会。

张三负责完成首页 UI 设计，本周五之前提交。
李四负责开发用户登录接口，下周一完成。
大家决定第一版产品先支持邮箱登录。
产品经理要求下周三进行第一次内部测试。" maxlength="10000" show-word-limit />

        <!-- 实时语音转文字 -->
        <div class="speech-panel">
          <div class="speech-header">
            <span class="speech-title">
              会议实时转写
            </span>

            <div class="speech-meta">
              <span v-if="isPaused" class="recording-status paused">
                ⏸ 已暂停
              </span>

              <span v-else-if="isRecording" class="recording-status">
                ● 正在会议
              </span>

              <span v-else class="recording-status stopped">
                ● 未开始
              </span>

              <span class="meeting-timer">
                {{ formatMeetingDuration(meetingDuration) }}
              </span>

              <span v-if="isRecording && isAudioRecording" class="audio-status">
                🎧 录音中
              </span>

              <span v-else-if="isRecording && audioBlocked" class="audio-status blocked">
                🎧 未录音
              </span>
            </div>
          </div>

          <div v-if="interimTranscript" class="interim-text">
            {{ interimTranscript }}
          </div>

          <div class="speech-actions">
            <el-button v-if="!isRecording" type="success" @click="handleStartRecording">
              🎙 开始会议
            </el-button>

            <template v-else>
              <el-button v-if="!isPaused" type="warning" @click="handlePauseRecording">
                ⏸ 暂停转写
              </el-button>

              <el-button v-else type="success" @click="handleResumeRecording">
                ▶ 继续转写
              </el-button>
            </template>

            <el-button v-if="isRecording" type="danger" :loading="loading" @click="handleFinishMeeting">
              <span v-if="!loading">
                ⏹ 结束会议并生成纪要
              </span>

              <span v-else>
                AI 正在生成纪要...
              </span>
            </el-button>

            <span class="speech-tip">
              <template v-if="isPaused">
                已暂停转写与计时，点击“继续转写”恢复
              </template>

              <template v-else>
                点击开始后，请允许浏览器访问麦克风；录音期间每分钟会自动在原文插入时间标记
              </template>
            </span>
          </div>
        </div>

        <div class="input-footer">
          <span class="tip">
            AI 将自动分析会议内容并生成结构化纪要
          </span>

          <div class="generate-actions">
            <el-button size="large" :loading="draftSaving" :disabled="loading" @click="handleSaveDraft">
              加入草稿箱
            </el-button>

            <el-button type="primary" size="large" :loading="loading" :disabled="draftSaving" @click="handleGenerate">
              <span v-if="!loading">
                生成会议纪要
              </span>

              <span v-else>
                AI 正在分析...
              </span>
            </el-button>
          </div>
        </div>
      </el-card>

      <!-- AI 结果 -->
      <div v-if="result" class="result-wrapper">
        <div class="result-header">
          <div>
            <h2>AI 分析结果</h2>

            <p>
              以下内容由 AI 根据会议记录自动整理
            </p>
          </div>
        </div>

        <MeetingResultComponent :result="result" />
      </div>

      <!-- 空状态 -->
      <div v-else-if="!loading" class="empty-state">
        <div class="empty-icon">
          AI
        </div>

        <h3>
          等待生成会议纪要
        </h3>

        <p>
          在上方输入会议内容，然后点击生成按钮
        </p>
      </div>

    </div>
  </div>
</template>

<style scoped>
.home-page {
  min-height: 100%;
  background: #f5f7fa;
  padding: 40px 20px 60px;
}

.page-container {
  max-width: 1000px;
  margin: 0 auto;
}

.page-header {
  margin-bottom: 24px;
}

.page-header h1 {
  margin: 0 0 8px;
  font-size: 30px;
  font-weight: 600;
  color: #303133;
}

.page-header p {
  margin: 0;
  color: #909399;
  font-size: 14px;
}

.input-card {
  border-radius: 12px;
  border: 1px solid #ebeef5;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 600;
}

.input-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 18px;
}

.generate-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.tip {
  color: #909399;
  font-size: 13px;
}

.result-wrapper {
  margin-top: 32px;
}

.result-header {
  margin-bottom: 18px;
}

.result-header h2 {
  margin: 0 0 6px;
  font-size: 22px;
  color: #303133;
}

.result-header p {
  margin: 0;
  color: #909399;
  font-size: 14px;
}

.empty-state {
  margin-top: 30px;
  padding: 60px 20px;
  background: #ffffff;
  border-radius: 12px;
  text-align: center;
  border: 1px solid #ebeef5;
}

.empty-icon {
  font-size: 48px;
  margin-bottom: 16px;
  font-weight: 700;
}

.empty-state h3 {
  margin: 0 0 8px;
  color: #606266;
}

.empty-state p {
  margin: 0;
  color: #909399;
}

.speech-panel {
  margin-top: 16px;
  padding: 16px;
  background: #f8fafc;
  border: 1px solid #ebeef5;
  border-radius: 10px;
}

.speech-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.speech-title {
  font-size: 14px;
  font-weight: 600;
  color: #303133;
}

.recording-status {
  font-size: 13px;
  color: #f56c6c;
}

.recording-status.stopped {
  color: #909399;
}

.recording-status.paused {
  color: #e6a23c;
}

.interim-text {
  margin-bottom: 12px;
  padding: 10px 12px;
  background: #ffffff;
  border-radius: 8px;
  color: #909399;
  font-size: 14px;
  line-height: 1.6;
}

.speech-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.speech-tip {
  font-size: 12px;
  color: #909399;
}

.speech-meta {
  display: flex;
  align-items: center;
  gap: 14px;
}

.meeting-timer {
  font-family: monospace;
  font-size: 14px;
  font-weight: 600;
  color: #303133;
}

.audio-status {
  font-size: 12px;
  color: #67c23a;
}

.audio-status.blocked {
  color: #e6a23c;
}

@media (max-width: 768px) {
  .home-page {
    padding: 24px 12px 40px;
  }

  .page-header h1 {
    font-size: 24px;
  }

  .input-footer {
    flex-direction: column;
    align-items: stretch;
    gap: 14px;
  }

  .generate-actions {
    flex-direction: column;
    width: 100%;
  }

  .generate-actions .el-button {
    width: 100%;
    margin-left: 0;
  }

  .input-footer .el-button {
    width: 100%;
  }

  /* 三个按钮纵向堆叠会过高，改为换行布局 */
  .speech-actions {
    display: flex;
    flex-direction: row;
    flex-wrap: wrap;
  }

  .speech-actions .el-button {
    flex: 1 1 100%;
    width: 100%;
    margin-left: 0;
  }

  .speech-actions .speech-tip {
    flex: 1 1 100%;
  }
}
</style>
