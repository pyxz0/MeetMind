<script setup lang="ts">
import { onBeforeUnmount, ref, watchEffect } from 'vue'
import { ElMessage } from 'element-plus'
import {
  generateMeeting,
  createDraftMeeting,
  type MeetingResult,
} from '../api/meeting'

import { useDraftStore } from '../composables/draftStore'
import { syncRecordingStatus } from '../composables/recordingStatus'
import { useMeetingTimer } from '../composables/useMeetingTimer'
import { useMediaRecorder } from '../composables/useMediaRecorder'
import { useSpeechRecognition } from '../composables/useSpeechRecognition'
import { useTranscriptComposer } from '../composables/useTranscriptComposer'
import MeetingResultComponent from '../components/MeetingResult.vue'

defineOptions({ name: 'MinutesInstant' })

const draftStore = useDraftStore()

/* =========================
   会议计时
   ========================= */

const {
  duration: meetingDuration,
  format: formatMeetingDuration,
  start: startMeetingTimer,
  stop: stopMeetingTimer,
  begin: beginMeetingClock,
  resume: resumeMeetingClock,
  freeze: freezeMeetingClock,
  reset: resetMeetingClock,
} = useMeetingTimer()

/* =========================
   会议录音（MediaRecorder）
   ========================= */

const {
  audioSupported,
  isAudioRecording,
  audioBlocked,
  start: startAudioRecording,
  pause: pauseAudioRecording,
  resume: resumeAudioRecording,
  finalize: finalizeAudioRecording,
  stopInBackground: stopAudioRecordingInBackground,
  clearPending: clearPendingAudio,
  reset: resetPendingAudio,
  release: releaseMicrophone,
  hasPendingAudio,
  upload: uploadRecordedAudio,
} = useMediaRecorder()

/* =========================
   会议原文
   ========================= */

const {
  content: meetingContent,
  append: appendTranscript,
  resetMinuteMark,
  clear: clearTranscript,
} = useTranscriptComposer({ duration: meetingDuration, isAudioRecording })

/* =========================
   语音识别
   ========================= */

/** 麦克风被拒绝时的收尾：停表并提示，避免界面显示还在计时。 */
const handleSpeechBlocked = () => {
  freezeMeetingClock()

  ElMessage.error('无法使用麦克风，请允许浏览器访问麦克风')
}

const {
  speechSupported,
  isRecording,
  isPaused,
  interimTranscript,
  ensure: ensureSpeechRecognition,
  start: startRecognition,
  pause: pauseRecognition,
  resume: resumeRecognition,
  stop: stopRecognition,
  flush: flushInterimTranscript,
  dispose: disposeSpeechRecognition,
} = useSpeechRecognition({
  onFinalText: appendTranscript,
  onBlocked: handleSpeechBlocked,
})

/* =========================
   AI 结果 / 请求状态
   ========================= */

const result = ref<MeetingResult | null>(null)

const loading = ref(false)

const draftSaving = ref(false)

/**
 * 开始会议语音识别与录音。
 */
const handleStartRecording = async () => {
  ensureSpeechRecognition()

  if (!speechSupported.value) {
    ElMessage.warning(
      '当前浏览器暂不支持语音识别，请更换支持 SpeechRecognition 的浏览器'
    )

    return
  }

  if (isRecording.value) {
    return
  }

  interimTranscript.value = ''
  isRecording.value = true
  isPaused.value = false

  // 累计时长清零并记录本段计时起点；新一场会议从第 0 分钟重新打标记
  beginMeetingClock()
  resetMinuteMark()

  // 先起录音：麦克风授权是异步的，若拒绝也只降级为“无音频”，不影响转写
  clearPendingAudio()
  const audioStarted = await startAudioRecording()

  startMeetingTimer()

  try {
    startRecognition()

    if (audioStarted) {
      ElMessage.success('已开始实时语音转文字，并同步录制会议音频')
    } else if (!audioSupported) {
      ElMessage.success('已开始实时语音转文字（当前浏览器不支持录音）')
    } else {
      ElMessage.warning('已开始转写，但麦克风不可用，本次会议不会保存音频')
    }
  } catch (error) {
    console.error('启动语音识别失败：', error)

    isRecording.value = false
    stopMeetingTimer()

    // 转写没起来就不该继续占用麦克风
    releaseMicrophone()

    ElMessage.error('语音识别启动失败，请重试')
  }
}

/**
 * 暂停会议语音识别。
 *
 * 暂停期间不转写、计时冻结、录音暂停，已识别的内容全部保留。
 */
const handlePauseRecording = () => {
  if (!isRecording.value || isPaused.value) {
    return
  }

  // 冻结计时：把本段已走过的秒数累加进总时长
  freezeMeetingClock()

  // 暂停瞬间的中间结果必须落定，否则这句话会丢
  flushInterimTranscript()

  pauseRecognition()

  // 录音与转写同一时刻暂停，音频时间轴才能和文字对得上
  pauseAudioRecording()

  isPaused.value = true

  ElMessage.info('已暂停转写与录音，计时同步暂停')
}

/**
 * 恢复会议语音识别，继续追加到同一篇会议原文。
 */
const handleResumeRecording = () => {
  if (!isRecording.value || !isPaused.value) {
    return
  }

  // 重新开始累计计时
  resumeMeetingClock()

  startMeetingTimer()

  // 录音与转写同时恢复
  resumeAudioRecording()

  try {
    resumeRecognition()

    ElMessage.success('已恢复转写与录音')
  } catch (error) {
    console.error('恢复语音识别失败：', error)

    // 恢复失败则回退到暂停态，保证界面与服务状态一致
    isPaused.value = true
    freezeMeetingClock()

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
    await uploadRecordedAudio(meeting.id, '会议录音已保存')
  } catch (error) {
    console.error(error)

    ElMessage.error('AI 纪要生成失败，请检查后端服务是否正常')
  } finally {
    loading.value = false
    resetPendingAudio()
  }
}

/**
 * 停止会议语音识别与录音。
 *
 * 录音是异步收拢的，不能阻塞调用方去发起纪要生成，
 * 因此这里只把音频交给后台暂存，等调用方拿到会议 ID 再上传。
 */
const handleStopRecording = () => {
  if (!isRecording.value) {
    return
  }

  // 结束前的中间结果同样要落定
  flushInterimTranscript()

  // 必须在重置时长之前取 duration，上传时要用它作为音频时长
  const audioDuration = meetingDuration.value

  stopRecognition()

  // 不 await：调用方需要立刻拿到控制权去发起纪要生成
  stopAudioRecordingInBackground(audioDuration)

  resetMeetingClock()

  ElMessage.info('已停止实时语音转文字')
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

    if (draft?.id && hasPendingAudio()) {
      await uploadRecordedAudio(draft.id, '草稿录音已保存')
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
    if (meeting?.id && hasPendingAudio()) {
      await uploadRecordedAudio(meeting.id, '会议录音已保存')
    }
  } catch (error) {
    console.error(error)

    ElMessage.error('会议纪要生成失败，请检查后端服务是否启动')
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

  clearTranscript()
  interimTranscript.value = ''
  result.value = null
}

/**
 * 把录音状态同步到全局，供其他页面的「后台录音中」提示使用。
 *
 * 必须放在 isRecording / isPaused / meetingDuration 就绪之后：
 * watchEffect 会立即执行一次，提前访问这些 ref 会触发 TDZ 报错，
 * 表现为整个页面白屏。
 */
watchEffect(() => {
  syncRecordingStatus({
    recording: isRecording.value,
    paused: isPaused.value,
    seconds: meetingDuration.value,
  })
})

/**
 * 页面卸载时释放语音识别与麦克风资源。
 */
onBeforeUnmount(() => {
  disposeSpeechRecognition()

  // 离开页面必须关掉麦克风，否则浏览器会一直显示录音中
  releaseMicrophone()

  resetMeetingClock()
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
