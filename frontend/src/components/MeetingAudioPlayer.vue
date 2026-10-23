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
  <!-- 走带条：上下各一道 1px 栏线，没有底色、没有阴影 -->
  <div v-if="hasAudio" class="tape">
    <el-button class="tape-btn" :loading="isLoading" :title="isPlaying ? '暂停' : '播放'"
      :aria-label="isPlaying ? '暂停录音' : '播放录音'" @click="togglePlay">
      <span v-if="!isLoading" class="tape-glyph" :class="isPlaying ? 'tape-glyph-pause' : 'tape-glyph-play'" />
    </el-button>

    <div class="tape-track" role="slider" :aria-valuenow="Math.round(progressPercent)" aria-valuemin="0"
      aria-valuemax="100" aria-label="录音播放进度" @click="seekTo">
      <div class="tape-rail">
        <div class="tape-fill" :style="{ width: `${progressPercent}%` }" />

        <span class="tape-head" :style="{ left: `${progressPercent}%` }" />
      </div>
    </div>

    <span class="tape-clock num">
      {{ formatTime(currentTime) }} / {{ formatTime(displayDuration) }}
    </span>

    <!--
      原生 audio 只作播放引擎，界面由上面的走带条承担，
      因为原生控件样式无法与纸面统一。
    -->
    <audio ref="audioElement" class="tape-engine" :src="src" preload="metadata" @loadedmetadata="handleLoadedMetadata"
      @timeupdate="handleTimeUpdate" @play="handlePlay" @pause="handlePause" @ended="handleEnded" @error="handleError" />
  </div>

  <!-- 有地址却打不开：说明发生了什么，并给出下一步 -->
  <p v-else-if="audioUrl" class="tape-error">
    这段录音打不开。文件可能已被删除，或服务暂时不可用。可以稍后再试，或请会议负责人重新上传。
  </p>
</template>

<style scoped>
.tape {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 0;
  border-top: 1px solid var(--rule);
  border-bottom: 1px solid var(--rule);
}

/* 播放键：2px 直角方块，只靠一道栏线立住 */
.tape-btn {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  padding: 0;
}

.tape-glyph {
  display: block;
}

.tape-glyph-play {
  width: 0;
  height: 0;
  margin-left: 2px;
  border-top: 5px solid transparent;
  border-bottom: 5px solid transparent;
  border-left: 7px solid var(--ink);
}

.tape-glyph-pause {
  width: 8px;
  height: 10px;
  border-left: 2px solid var(--ink);
  border-right: 2px solid var(--ink);
}

/* 进度：2px 轨道，没有圆角 */
.tape-track {
  flex: 1;
  min-width: 0;
  padding: 9px 0;
  cursor: pointer;
}

.tape-rail {
  position: relative;
  height: 2px;
  background: var(--rule-soft);
}

.tape-fill {
  height: 100%;
  background: var(--ink);
  transition: width 0.1s linear;
}

.tape-head {
  position: absolute;
  top: -4px;
  width: 1px;
  height: 10px;
  margin-left: -0.5px;
  background: var(--ink);
}

/* 时间码：唯一用等宽字的地方 */
.tape-clock {
  flex-shrink: 0;
  font-size: 11.5px;
  letter-spacing: 0.02em;
  color: var(--ink-2);
  white-space: nowrap;
}

.tape-error {
  padding: 12px 0;
  border-top: 1px solid var(--rule);
  border-bottom: 1px solid var(--rule);

  font-size: 12.5px;
  line-height: 1.8;
  color: var(--ink-2);
}

/* 播放引擎不需要可见，界面由走带条承担 */
.tape-engine {
  display: none;
}

@media (max-width: 640px) {
  .tape {
    gap: 12px;
  }

  .tape-clock {
    font-size: 11px;
  }
}
</style>
