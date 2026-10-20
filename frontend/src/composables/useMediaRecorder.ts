import { ElMessage } from 'element-plus'
import { ref, shallowRef } from 'vue'
import { uploadMeetingAudio } from '../api/meeting'

/**
 * 会议音频录制（MediaRecorder）。
 *
 * 与语音转写相互独立：麦克风不可用时只降级为「没有音频」，
 * 转写照常进行，因此所有失败路径都返回 null 而不抛错。
 */
export const useMediaRecorder = () => {
  /** 当前浏览器是否具备音频录制能力 */
  const audioSupported =
    typeof window !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia

  /** 本次会议是否真的在录音；麦克风不可用时为 false，但仍可继续转写 */
  const isAudioRecording = ref(false)

  /** 麦克风授权失败时置位，用于提示用户只有文字没有录音 */
  const audioBlocked = ref(false)

  /** 会议结束后暂存录音，等待拿到会议 ID 后上传 */
  const pendingAudioBlob = shallowRef<Blob | null>(null)

  /** 与暂存录音对应的时长（秒），上传时一并写入数据库 */
  let pendingAudioDuration = 0

  let mediaRecorder: MediaRecorder | null = null

  /** 麦克风音轨，停止后必须显式关闭，否则浏览器会一直显示录音中 */
  let microphoneStream: MediaStream | null = null

  let recordedChunks: Blob[] = []

  /** 实际使用的录音容器类型，如 audio/webm;codecs=opus */
  let recordedMimeType = ''

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

  /** 释放麦克风、丢弃已录内容。 */
  const release = () => {
    microphoneStream?.getTracks().forEach((track) => track.stop())
    microphoneStream = null

    mediaRecorder = null
    recordedChunks = []
    isAudioRecording.value = false
  }

  /**
   * 开始录音。
   *
   * 返回是否成功进入录音状态；失败不阻断转写，只是这场会议没有音频。
   */
  const start = async () => {
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
  const pause = () => {
    if (mediaRecorder?.state === 'recording') {
      try {
        mediaRecorder.pause()
      } catch (error) {
        console.error('暂停录音失败：', error)
      }
    }
  }

  /** 恢复录音，同样与转写恢复同一时刻。 */
  const resume = () => {
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
   */
  const stop = async (): Promise<Blob | null> => {
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
            const tail = (
              recorder as unknown as { requestData?: () => void }
            ).requestData

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
    release()

    mediaRecorder = null

    if (!result || result.size === 0) {
      return null
    }

    return result
  }

  /**
   * 停止录音并在后台把音频暂存起来。
   *
   * 调用方（结束会议 / 生成纪要）需要立刻拿到控制权去发起请求，
   * 因此这里不阻塞，只把结果挂到 pendingAudioBlob 上。
   *
   * durationSec 必须在重置计时器之前取好，上传时要用它作为音频时长。
   */
  const stopInBackground = (durationSec: number) => {
    void stop().then((blob) => {
      if (blob) {
        pendingAudioBlob.value = blob
        pendingAudioDuration = durationSec
      }
    })
  }

  /**
   * 结束录音并等待音频就绪。
   *
   * stop() 是用 void 触发的；上传前必须在这里等它真正收拢完成，
   * 否则会拿到 null。
   */
  const finalize = async () => {
    // 已经收拢过就不重复处理（例如结束后又点了保存草稿）。
    if (pendingAudioBlob.value) {
      return pendingAudioBlob.value
    }

    if (!mediaRecorder) {
      return null
    }

    const blob = await stop()

    if (blob) {
      pendingAudioBlob.value = blob
    }

    return pendingAudioBlob.value
  }

  /** 丢掉暂存录音，避免串到下一场会议。 */
  const clearPending = () => {
    pendingAudioBlob.value = null
    pendingAudioDuration = 0
  }

  /** 清空暂存录音并释放麦克风。 */
  const reset = () => {
    clearPending()
    release()
  }

  /** 是否还有待上传的录音 */
  const hasPendingAudio = () => pendingAudioBlob.value !== null

  /**
   * 把暂存录音上传到指定会议。
   *
   * 上传失败只提示，不影响已经生成的纪要 / 草稿。
   */
  const upload = async (meetingId: number, successText: string) => {
    const blob = pendingAudioBlob.value

    if (!blob) {
      return
    }

    try {
      await uploadMeetingAudio(meetingId, blob, pendingAudioDuration)

      pendingAudioBlob.value = null

      ElMessage.success(successText)
    } catch (error) {
      console.error('录音上传失败：', error)

      ElMessage.warning('录音上传失败，本次会议未保存音频')
    }
  }

  return {
    audioSupported,
    isAudioRecording,
    audioBlocked,
    start,
    pause,
    resume,
    stop,
    stopInBackground,
    finalize,
    clearPending,
    reset,
    release,
    hasPendingAudio,
    upload,
  }
}
