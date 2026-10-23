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
  <div class="page">
    <div class="page-inner">
      <header class="page-head">
        <div>
          <h1>智能会议纪要</h1>

          <p class="page-desc">
            把会议原文写进纸里，或直接开始转写；散会后生成摘要、决策与待办
          </p>
        </div>

        <div class="page-head-actions">
          <el-button :disabled="loading" @click="handleClear">
            清空
          </el-button>
        </div>
      </header>

      <div class="record-grid">
        <!-- 左：会议原文 -->
        <section class="sheet record-main">
          <div class="record-head">
            <span class="sec-t">会议内容</span>

            <span class="sec-x num">
              {{ meetingContent.length }} / 10000
            </span>
          </div>

          <el-input v-model="meetingContent" class="record-input" type="textarea" :rows="15" resize="none" placeholder="请输入会议内容，例如：

今天下午召开产品需求讨论会。

张三负责完成首页 UI 设计，本周五之前提交。
李四负责开发用户登录接口，下周一完成。
大家决定第一版产品先支持邮箱登录。
产品经理要求下周三进行第一次内部测试。" maxlength="10000" />

          <div v-if="interimTranscript" class="interim">
            <span class="interim-k">正在识别</span>

            <p class="interim-text">
              {{ interimTranscript }}
            </p>
          </div>

          <div class="record-foot">
            <span class="record-tip">
              AI 将自动分析会议内容并生成结构化纪要
            </span>

            <div class="record-buttons">
              <el-button :loading="draftSaving" :disabled="loading" @click="handleSaveDraft">
                加入草稿箱
              </el-button>

              <el-button type="primary" :loading="loading" :disabled="draftSaving" @click="handleGenerate">
                生成会议纪要
              </el-button>
            </div>
          </div>
        </section>

        <!-- 右：转写台。全站唯一一个会自己动的方块 -->
        <aside class="sheet recorder">
          <div class="recorder-state">
            <span class="state-dot" :class="{
              'state-live': isRecording && !isPaused,
              'state-paused': isRecording && isPaused,
            }" />

            <span class="state-text">
              {{ !isRecording ? '未开始' : isPaused ? '已暂停' : '转写中' }}
            </span>

            <span class="state-audio">
              {{ isRecording ? (isAudioRecording ? '录音中' : audioBlocked ? '未录音' : '准备中') : '麦克风关闭' }}
            </span>
          </div>

          <div class="recorder-clock num">
            {{ formatMeetingDuration(meetingDuration) }}
          </div>

          <p class="recorder-hint">
            {{
              !isRecording
                ? '点击开始后，请允许浏览器访问麦克风'
                : isPaused
                  ? '转写与计时都已暂停，点「继续转写」恢复'
                  : '每分钟自动在原文插入一次时间标记'
            }}
          </p>

          <div class="recorder-actions">
            <el-button v-if="!isRecording" type="primary" size="large" @click="handleStartRecording">
              开始会议
            </el-button>

            <template v-else>
              <el-button v-if="!isPaused" size="large" class="act" @click="handlePauseRecording">
                暂停转写
              </el-button>

              <el-button v-else type="primary" size="large" class="act" @click="handleResumeRecording">
                继续转写
              </el-button>

              <el-button type="danger" size="large" class="act" :loading="loading" @click="handleFinishMeeting">
                结束并生成纪要
              </el-button>
            </template>
          </div>

          <div class="recorder-foot">
            <span>转写在本机浏览器完成</span>
            <span>录音随纪要一起保存</span>
          </div>
        </aside>
      </div>

      <!-- 结果：一张纪要纸 -->
      <section v-if="result" class="sheet result-sheet">
        <div class="result-head">
          <span class="sec-t">会议纪要</span>

          <span class="sec-x num">
            {{ result.title || '未命名会议' }}
          </span>
        </div>

        <MeetingResultComponent :result="result" />
      </section>

      <div v-else-if="loading" class="blank">
        <p class="blank-title">
          AI 正在整理
        </p>

        <p class="blank-desc">
          散会后十几秒出稿，请稍等
        </p>
      </div>

      <div v-else class="blank">
        <p class="blank-title">
          还没有纪要
        </p>

        <p class="blank-desc">
          把会议原文写进上面的纸里，或者直接开始转写
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ---------- 版面：左纸右台 ---------- */
.record-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
  gap: 18px;
  align-items: start;
}

.record-main {
  padding: 20px 26px 0;
}

.record-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--rule);
}

.record-head .sec-x {
  margin-left: auto;
}

/* 原文用仿宋，读起来像稿纸；行高按稿纸排 */
.record-input {
  display: block;
  margin-top: 14px;
}

.record-input :deep(.el-textarea__inner) {
  font-family: var(--fang);
  font-size: 15.5px;
  line-height: 1.95;
  color: var(--ink-body);
  padding: 14px 16px;

  background: var(--field);
  box-shadow: 0 0 0 1px var(--rule) inset;
}

.record-input :deep(.el-textarea__inner::placeholder) {
  font-family: var(--fang);
  color: var(--ink-3);
}

.interim {
  display: flex;
  gap: 12px;
  margin-top: 12px;
  padding: 10px 14px;

  background: var(--paper-2);
  border-left: 2px solid var(--rule);
}

.interim-k {
  flex-shrink: 0;
  padding-top: 2px;
  font-size: 10.5px;
  letter-spacing: 0.06em;
  color: var(--ink-3);
}

.interim-text {
  margin: 0;
  font-size: 13px;
  line-height: 1.75;
  color: var(--ink-2);
}

.record-foot {
  display: flex;
  align-items: center;
  gap: 16px;

  margin-top: 18px;
  padding: 14px 0 18px;
  border-top: 1px solid var(--rule);
}

.record-tip {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  color: var(--ink-3);
}

.record-buttons {
  display: flex;
  gap: 10px;
  flex-shrink: 0;
}

/* ---------- 右：转写台 ---------- */
.recorder {
  padding: 18px 20px 16px;
  position: sticky;
  top: 18px;
}

.recorder-state {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--rule);

  font-size: 11.5px;
  color: var(--ink-2);
}

.state-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--rule);
}

.state-live {
  background: var(--vermilion);
  animation: rec-pulse 1.6s ease-in-out infinite;
}

.state-paused {
  background: var(--ochre);
}

.state-text {
  letter-spacing: 0.04em;
}

.state-audio {
  margin-left: auto;
  font-size: 11px;
  color: var(--ink-3);
}

@keyframes rec-pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }

  50% {
    opacity: 0.4;
    transform: scale(0.82);
  }
}

/* 计时是这个方块的唯一主角 */
.recorder-clock {
  margin: 20px 0 6px;
  font-size: 40px;
  line-height: 1;
  color: var(--ink);
  letter-spacing: 0.01em;
}

.recorder-hint {
  min-height: 34px;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--ink-3);
}

.recorder-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 16px;
}

.recorder-actions .el-button {
  width: 100%;
  height: 38px;
  margin-left: 0;
}

.recorder-foot {
  display: flex;
  flex-direction: column;
  gap: 5px;

  margin-top: 18px;
  padding-top: 12px;
  border-top: 1px solid var(--rule-soft);

  font-size: 10.5px;
  color: var(--ink-3);
}

/* ---------- 结果纸 ---------- */
.result-sheet {
  margin-top: 18px;
  padding: 22px 30px 26px;
}

.result-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding-bottom: 10px;
  margin-bottom: 20px;
  border-bottom: 1px solid var(--rule);
}

.result-head .sec-x {
  margin-left: auto;
}

@media (max-width: 1080px) {
  .record-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  /* 窄屏把转写台提到原文之前：开始会议是这一页的主操作 */
  .recorder {
    position: static;
    order: -1;
  }
}

@media (max-width: 640px) {
  .page {
    padding: 22px 14px 48px;
  }

  .record-main {
    padding: 16px 16px 0;
  }

  .record-foot {
    flex-direction: column;
    align-items: stretch;
    gap: 12px;
  }

  .record-buttons {
    flex-direction: column-reverse;
  }

  .record-buttons .el-button {
    width: 100%;
    margin-left: 0;
  }

  .recorder {
    padding: 16px;
  }

  .recorder-clock {
    font-size: 34px;
  }
}
</style>
