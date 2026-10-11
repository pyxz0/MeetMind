<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  generateMeeting,
  createDraftMeeting,
  type MeetingResult,
} from '../api/meeting'

import { useDraftStore } from '../composables/draftStore'
import MeetingResultComponent from '../components/MeetingResult.vue'

const draftStore = useDraftStore()

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

const interimTranscript = ref('')

/** 会议开始时间 */
const meetingStartTime = ref<number | null>(null)

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

const recognition = ref<SpeechRecognitionLike | null>(null)

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

    // 最终识别结果写入会议内容
    if (finalText.trim()) {
      if (meetingContent.value.trim()) {
        meetingContent.value +=
          ` ${finalText.trim()}`
      } else {
        meetingContent.value =
          finalText.trim()
      }
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

      ElMessage.error(
        '无法使用麦克风，请允许浏览器访问麦克风'
      )
    }
  }

  /**
   * 识别服务结束。
   *
   * 某些浏览器会在持续识别过程中自动断开，
   * 如果用户仍处于录音状态，则自动重新启动。
   */
  instance.onend = () => {
    if (!isRecording.value) {
      return
    }

    window.setTimeout(() => {
      if (!isRecording.value) {
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
 * 开始会议语音识别。
 */
const handleStartRecording = () => {
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

  meetingStartTime.value = Date.now()
  meetingDuration.value = 0

  meetingTimer = window.setInterval(() => {
    if (meetingStartTime.value === null) {
      return
    }

    meetingDuration.value = Math.floor(
      (Date.now() - meetingStartTime.value) / 1000
    )
  }, 1000)

  try {
    recognition.value.start()

    ElMessage.success(
      '已开始实时语音转文字'
    )
  } catch (error) {
    console.error(
      '启动语音识别失败：',
      error
    )

    isRecording.value = false

    ElMessage.error(
      '语音识别启动失败，请重试'
    )
  }
}

/**
 * 结束会议并自动生成 AI 会议纪要。
 */
const handleFinishMeeting = async () => {
  handleStopRecording()

  if (!meetingContent.value.trim()) {
    ElMessage.warning('暂未识别到会议内容')

    return
  }

  loading.value = true

  try {
    result.value = await generateMeeting({
      content: meetingContent.value,
    })

    ElMessage.success('会议结束，AI 纪要已生成')
  } catch (error) {
    console.error(error)

    ElMessage.error(
      'AI 纪要生成失败，请检查后端服务是否正常'
    )
  } finally {
    loading.value = false
  }
}

/**
 * 停止会议语音识别。
 */
const handleStopRecording = () => {
  if (!recognition.value) {
    return
  }

  isRecording.value = false
  interimTranscript.value = ''

  if (meetingTimer !== null) {
    window.clearInterval(meetingTimer)
    meetingTimer = null
  }

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
  }

  if (!meetingContent.value.trim()) {
    ElMessage.warning('请先输入或录入会议内容')
    return
  }

  draftSaving.value = true

  try {
    await createDraftMeeting({
      title: '会议草稿',
      content: meetingContent.value.trim(),
    })

    // 数据库保存成功后立即更新顶部徽标
    draftStore.increment()

    ElMessage.success('会议已加入草稿箱')
  } catch (error) {
    console.error('保存草稿失败：', error)

    ElMessage.error('加入草稿箱失败，请重试')
  } finally {
    draftSaving.value = false
  }
}

/**
 * 校验文本后调用生成接口，
 * 并将请求状态和结果反馈到页面。
 */
const handleGenerate = async () => {
  if (isRecording.value) {
    handleStopRecording()
  }

  if (!meetingContent.value.trim()) {
    ElMessage.warning('请输入会议内容')

    return
  }

  loading.value = true

  try {
    result.value = await generateMeeting({
      content: meetingContent.value,
    })

    ElMessage.success('会议纪要生成成功')
  } catch (error) {
    console.error(error)

    ElMessage.error(
      '会议纪要生成失败，请检查后端服务是否启动'
    )
  } finally {
    loading.value = false
  }
}

/**
 * 清空输入和当前结果，
 * 同时停止语音识别。
 */
const handleClear = () => {
  if (isRecording.value) {
    handleStopRecording()
  }

  meetingContent.value = ''
  interimTranscript.value = ''
  result.value = null
}

/**
 * 页面卸载时释放语音识别资源。
 */
onBeforeUnmount(() => {
  isRecording.value = false
  interimTranscript.value = ''

  try {
    recognition.value?.abort()
  } catch {
    // 忽略卸载阶段的异常
  }
  if (meetingTimer !== null) {
    window.clearInterval(meetingTimer)
    meetingTimer = null
  }
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
              <span v-if="isRecording" class="recording-status">
                ● 正在会议
              </span>

              <span v-else class="recording-status stopped">
                ● 未开始
              </span>

              <span class="meeting-timer">
                {{ formatMeetingDuration(meetingDuration) }}
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

            <el-button v-else type="danger" :loading="loading" @click="handleFinishMeeting">
              <span v-if="!loading">
                ⏹ 结束会议并生成纪要
              </span>

              <span v-else>
                AI 正在生成纪要...
              </span>
            </el-button>

            <span class="speech-tip">
              点击开始后，请允许浏览器访问麦克风
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
  min-height: calc(100vh - 64px);
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

  .speech-actions {
    flex-direction: column;
    align-items: stretch;
  }

  .speech-actions .el-button {
    width: 100%;
  }
}
</style>
