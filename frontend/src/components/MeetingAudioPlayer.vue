<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { resolveAudioUrl } from '../api/meeting'

const props = defineProps<{
  /** 录音的站内相对路径，例如 uploads/xxx.webm */
  audioUrl?: string | null
  /** 录音时长（秒），来自数据库记录，可能与实际文件略有出入 */
  durationSec?: number | null
}>()

const audioElement = ref<HTMLAudioElement | null>(null)
const isPlaying = ref(false)
const currentTime = ref(0)
const totalSeconds = ref(0)
const hasError = ref(false)
const isLoading = ref(false)

/** 后端相对路径转成可直接播放的完整地址。 */
const src = computed(() => resolveAudioUrl(props.audioUrl))

const hasAudio = computed(
  () => !!props.audioUrl && !hasError.value
)

/** 时长优先取音频元数据，未加载完成时退回数据库记录值。 */
const displayDuration = computed(() => {
  if (totalSeconds.value > 0) {
    return totalSeconds.value
  }

  return props.durationSec && props.durationSec > 0
    ? props.durationSec
    : 0
})

/** 进度百分比，驱动进度条宽度。 */
const progressPercent = computed(() => {
  if (!displayDuration.value) {
    return 0
  }

  return Math.min(
    100,
    (currentTime.value / displayDuration.value) * 100
  )
})

/** 秒数格式化为 mm:ss，超过一小时显示 h:mm:ss。 */
const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '00:00'
  }

  const total = Math.floor(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60

  const parts = [
    hours > 0 ? String(hours) : '',
    String(minutes).padStart(2, '0'),
    String(secs).padStart(2, '0'),
  ].filter(Boolean)

  return parts.join(':')
}

const togglePlay = async () => {
  const audio = audioElement.value

  if (!audio) {
    return
  }

  if (audio.paused) {
    try {
      await audio.play()
    } catch (error) {
      // 浏览器可能因自动播放策略拒绝，此时给出可见反馈而不是静默失败
      console.error('录音播放失败：', error)
      hasError.value = true
    }
  } else {
    audio.pause()
  }
}

/** 点击进度条跳转到对应位置。 */
const seekTo = (event: MouseEvent) => {
  const audio = audioElement.value

  if (!audio || !displayDuration.value) {
    return
  }

  const track = event.currentTarget as HTMLElement
  const rect = track.getBoundingClientRect()

  if (!rect.width) {
    return
  }

  const ratio = Math.min(
    1,
    Math.max(0, (event.clientX - rect.left) / rect.width)
  )

  audio.currentTime = ratio * displayDuration.value
  currentTime.value = audio.currentTime
}

const handleLoadedMetadata = () => {
  const audio = audioElement.value

  if (audio && Number.isFinite(audio.duration)) {
    totalSeconds.value = audio.duration
  }

  isLoading.value = false
}

const handleTimeUpdate = () => {
  currentTime.value = audioElement.value?.currentTime ?? 0
}

const handlePlay = () => {
  isPlaying.value = true
}

const handlePause = () => {
  isPlaying.value = false
}

const handleEnded = () => {
  isPlaying.value = false
  currentTime.value = 0
}

const handleError = () => {
  console.error('录音加载失败：', src.value)
  hasError.value = true
  isLoading.value = false
}

/** 切换会议时重置播放状态，避免残留上一条录音的进度。 */
watch(src, () => {
  isPlaying.value = false
  currentTime.value = 0
  totalSeconds.value = 0
  hasError.value = false
  isLoading.value = !!src.value
})

onBeforeUnmount(() => {
  // 离开页面时停止播放，避免音频在后台继续响
  audioElement.value?.pause()
})
</script>

<template>
  <el-card v-if="hasAudio" class="audio-card" shadow="never">
    <template #header>
      <div class="audio-header">
        <b>🎧 会议录音</b>

        <span class="audio-meta">
          {{ formatTime(displayDuration) }}
        </span>
      </div>
    </template>

    <div class="audio-body">
      <el-button
        class="play-button"
        type="primary"
        circle
        :loading="isLoading"
        @click="togglePlay"
      >
        {{ isPlaying ? '⏸' : '▶' }}
      </el-button>

      <div class="progress-area">
        <div
          class="progress-track"
          role="slider"
          :aria-valuenow="Math.round(progressPercent)"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-label="'录音播放进度'"
          @click="seekTo"
        >
          <div
            class="progress-fill"
            :style="{ width: `${progressPercent}%` }"
          />
        </div>

        <div class="time-row">
          <span>{{ formatTime(currentTime) }}</span>
          <span>{{ formatTime(displayDuration) }}</span>
        </div>
      </div>
    </div>

    <!--
      原生 audio 只作为播放引擎使用，界面由上面的自定义控件承担，
      因为原生控件样式无法与 Element Plus 统一。
    -->
    <audio
      ref="audioElement"
      class="audio-engine"
      :src="src"
      preload="metadata"
      @loadedmetadata="handleLoadedMetadata"
      @timeupdate="handleTimeUpdate"
      @play="handlePlay"
      @pause="handlePause"
      @ended="handleEnded"
      @error="handleError"
    />
  </el-card>

  <el-card v-else-if="audioUrl" class="audio-card" shadow="never">
    <template #header>
      <b>🎧 会议录音</b>
    </template>

    <el-alert
      type="warning"
      :closable="false"
      show-icon
      title="录音无法播放"
      description="录音文件可能已被删除或服务不可用。"
    />
  </el-card>
</template>

<style scoped>
.audio-card {
  border-radius: 12px;
}

.audio-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.audio-meta {
  color: #909399;
  font-size: 13px;
  font-family: monospace;
}

.audio-body {
  display: flex;
  align-items: center;
  gap: 16px;
}

.play-button {
  flex: 0 0 auto;
  font-size: 16px;
}

.progress-area {
  flex: 1;
  min-width: 0;
}

.progress-track {
  height: 8px;
  background: #ebeef5;
  border-radius: 4px;
  cursor: pointer;
  overflow: hidden;
}

.progress-track:hover .progress-fill {
  background: #66b1ff;
}

.progress-fill {
  height: 100%;
  background: #409eff;
  border-radius: 4px;
  transition: width 0.1s linear;
}

.time-row {
  display: flex;
  justify-content: space-between;
  margin-top: 6px;
  color: #909399;
  font-size: 12px;
  font-family: monospace;
}

/* 播放引擎不需要可见，界面由自定义控件承担 */
.audio-engine {
  display: none;
}
</style>
