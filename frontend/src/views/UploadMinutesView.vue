<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  deleteAsrJob,
  getAsrJob,
  listAsrJobs,
  uploadAsrJob,
  type AsrJob
} from '../api/asr'
import { generateMeeting } from '../api/meeting'

const router = useRouter()

const current = ref<AsrJob | null>(null)
const recent = ref<AsrJob[]>([])
const uploading = ref(false)
const uploadPercent = ref(0)
const generating = ref(false)
const transcript = ref('')

/** 轮询句柄：任务结束时必须清掉，否则离开页面还在打接口 */
let timer: number | null = null

const stopPolling = () => {
  if (timer !== null) {
    window.clearInterval(timer)
    timer = null
  }
}

const isBusy = computed(
  () => current.value?.status === 'PENDING' || current.value?.status === 'RUNNING'
)

const statusText = (status: AsrJob['status']) => {
  switch (status) {
    case 'PENDING':
      return '排队中'
    case 'RUNNING':
      return '转写中'
    case 'SUCCEEDED':
      return '已转写'
    case 'FAILED':
      return '失败'
    default:
      return status
  }
}

const statusTone = (status: AsrJob['status']) => {
  switch (status) {
    case 'PENDING':
      return 'wait'
    case 'RUNNING':
      return 'live'
    case 'SUCCEEDED':
      return 'done'
    default:
      return 'cancel'
  }
}

const formatSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const formatDuration = (seconds?: number | null) => {
  if (!seconds) return ''

  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60

  return `${minutes} 分 ${String(rest).padStart(2, '0')} 秒`
}

const applyJob = (job: AsrJob) => {
  current.value = job
  transcript.value = job.transcript ?? ''

  if (job.status === 'PENDING' || job.status === 'RUNNING') {
    startPolling(job.id)
  } else {
    stopPolling()
  }
}

const startPolling = (jobId: number) => {
  stopPolling()

  timer = window.setInterval(async () => {
    try {
      const job = await getAsrJob(jobId)

      // 用户可能已经切到别的任务，晚到的旧结果不能覆盖当前页面
      if (current.value?.id !== job.id) {
        stopPolling()
        return
      }

      current.value = job
      transcript.value = job.transcript ?? ''

      if (job.status === 'SUCCEEDED' || job.status === 'FAILED') {
        stopPolling()

        if (job.status === 'SUCCEEDED') {
          ElMessage.success('转写完成，可以生成纪要了')
          await loadRecent()
        } else {
          ElMessage.error(job.error ?? '转写失败')
        }
      }
    } catch {
      stopPolling()
    }
  }, 2500)
}

/** el-upload 的自定义上传：直接走 axios，顺带拿进度 */
const handleUpload = async (options: any) => {
  const file = options.file as File

  uploading.value = true
  uploadPercent.value = 0

  try {
    const job = await uploadAsrJob(file, (percent) => {
      uploadPercent.value = percent
    })

    applyJob(job)
    await loadRecent()

    if (job.status === 'SUCCEEDED') {
      ElMessage.success('文本已读取')
    } else {
      ElMessage.info('文件已上传，正在转写…')
    }

    options.onSuccess?.(job)
  } catch (error: any) {
    const message =
      error?.response?.data?.message ?? '上传失败，请检查文件类型与大小'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
    options.onError?.(error)
  } finally {
    uploading.value = false
  }
}

const loadRecent = async () => {
  try {
    recent.value = await listAsrJobs()
  } catch {
    recent.value = []
  }
}

const openJob = async (job: AsrJob) => {
  try {
    applyJob(await getAsrJob(job.id))
  } catch {
    ElMessage.error('任务已不存在')
  }
}

const removeJob = async (job: AsrJob) => {
  try {
    await ElMessageBox.confirm(
      `删除「${job.filename}」？磁盘上的文件也会一起清理。`,
      '删除上传记录',
      { confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }

  try {
    await deleteAsrJob(job.id)

    if (current.value?.id === job.id) {
      stopPolling()
      current.value = null
      transcript.value = ''
    }

    await loadRecent()
    ElMessage.success('已删除')
  } catch {
    ElMessage.error('删除失败')
  }
}

const generate = async () => {
  const content = transcript.value.trim()

  if (!content) {
    ElMessage.warning('转写内容为空，无法生成纪要')
    return
  }

  generating.value = true

  try {
    const meeting = await generateMeeting({ content })

    ElMessage.success('纪要已生成')
    router.push(`/history/${meeting.id}`)
  } catch (error: any) {
    ElMessage.error(error?.message ?? '生成失败，请稍后重试')
  } finally {
    generating.value = false
  }
}

onMounted(async () => {
  await loadRecent()

  const latest = recent.value[0]

  if (latest) {
    await openJob(latest)
  }
})

onBeforeUnmount(stopPolling)
</script>

<template>
  <div class="page">
    <div class="page-narrow">
      <header class="page-head">
        <div>
          <h1>上传录音</h1>

          <p class="page-desc">
            把手机录音、会议软件的录制文件传上来，由服务端转成文字，再生成纪要
          </p>
        </div>
      </header>

      <!-- 上传区 -->
      <section class="sheet up-sheet">
        <el-upload
          class="up-zone"
          drag
          :show-file-list="false"
          :http-request="handleUpload"
          :disabled="uploading"
          accept=".mp3,.wav,.m4a,.aac,.flac,.ogg,.amr,.mp4,.txt,.md"
        >
          <div class="up-main">
            <span class="up-title">
              {{ uploading ? `上传中 ${uploadPercent}%` : '把文件拖到这里，或点击选择' }}
            </span>

            <span class="up-sub">
              支持 mp3 / wav / m4a / aac / flac / ogg / amr / mp4，单个不超过 300MB；纯文本 txt / md 直接读原文
            </span>
          </div>
        </el-upload>
      </section>

      <!-- 当前任务 -->
      <section v-if="current" class="sheet job-sheet">
        <header class="job-head">
          <div class="job-id">
            <span class="m-status" :class="`m-status--${statusTone(current.status)}`">
              {{ statusText(current.status) }}
            </span>

            <strong class="job-name">{{ current.filename }}</strong>
            <span class="job-meta">{{ formatSize(current.sizeBytes) }}</span>
            <span v-if="current.durationSec" class="job-meta">
              {{ formatDuration(current.durationSec) }}
            </span>
          </div>

          <el-button link class="job-del" @click="removeJob(current)">
            删除
          </el-button>
        </header>

        <p v-if="current.provider === 'mock'" class="job-warn">
          当前使用的是本地占位转写通道（mock），文本是固定示例。配置腾讯云 ASR 凭据后才是真实转写。
        </p>

        <p v-if="isBusy" class="job-busy">
          正在服务端转写，一小时的录音通常需要几分钟；这个页面可以留着，也可以稍后回来查看。
        </p>

        <p v-else-if="current.status === 'FAILED'" class="job-error">
          {{ current.error || '转写失败' }}
        </p>

        <audio v-if="current.fileUrl && current.filename.match(/\.(mp3|wav|m4a|aac|flac|ogg|amr|mp4)$/i)"
          class="job-audio" :src="current.fileUrl" controls preload="metadata" />

        <template v-if="current.status === 'SUCCEEDED'">
          <div class="job-label">
            转写文本（可直接修改，改完再生成纪要）
          </div>

          <el-input v-model="transcript" class="job-text" type="textarea" :rows="12" resize="vertical"
            placeholder="这里是会议原文" />

          <div class="job-actions">
            <el-button type="primary" :loading="generating" @click="generate">
              生成纪要
            </el-button>

            <span class="job-hint">
              将调用 AI 提取摘要、决策与待办，结果会存进历史会议
            </span>
          </div>
        </template>
      </section>

      <!-- 最近上传 -->
      <section v-if="recent.length" class="sheet recent-sheet">
        <div class="recent-head">最近上传</div>

        <ul class="recent-list">
          <li v-for="job in recent" :key="job.id">
            <button class="recent-row" type="button" @click="openJob(job)">
              <span class="m-status" :class="`m-status--${statusTone(job.status)}`">
                {{ statusText(job.status) }}
              </span>

              <span class="recent-name">{{ job.filename }}</span>
              <span class="recent-meta">{{ formatSize(job.sizeBytes) }}</span>
            </button>
          </li>
        </ul>
      </section>

      <p class="page-foot">
        提醒：录音属于敏感信息，转写完成并生成纪要后建议删除原文件；删除上传记录会一起清掉磁盘文件。
      </p>
    </div>
  </div>
</template>

<style scoped>
.up-sheet {
  padding: 0;
  border: 1px dashed var(--rule);
  background: transparent;
}

.up-zone :deep(.el-upload-dragger) {
  padding: 34px 24px;
  background: var(--paper);
  border: none;
}

.up-main {
  display: grid;
  gap: 8px;
  justify-items: center;
}

.up-title {
  font-size: 15px;
  color: var(--ink);
}

.up-sub {
  font-size: 12.5px;
  line-height: 1.8;
  color: var(--ink-3);
  max-width: 520px;
}

.job-sheet {
  margin-top: 18px;
  padding: 20px 22px 22px;
}

.job-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--rule);
}

.job-id {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.job-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--ink);
}

.job-meta {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  color: var(--ink-3);
}

.job-warn {
  margin: 14px 0 0;
  padding: 9px 12px;
  font-size: 12.5px;
  line-height: 1.8;
  color: var(--vermilion);
  background: var(--vermilion-wash);
  border-left: 2px solid var(--vermilion);
}

.job-busy,
.job-error {
  margin: 14px 0 0;
  font-size: 13px;
  line-height: 1.8;
  color: var(--ink-2);
}

.job-error {
  color: var(--vermilion);
}

.job-audio {
  width: 100%;
  margin-top: 14px;
}

.job-label {
  margin: 18px 0 8px;
  font-size: 12.5px;
  color: var(--ink-2);
}

.job-text :deep(textarea) {
  font-family: var(--font-serif, inherit);
  font-size: 14px;
  line-height: 1.9;
}

.job-actions {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 14px;
  flex-wrap: wrap;
}

.job-hint {
  font-size: 12.5px;
  color: var(--ink-3);
}

.recent-sheet {
  margin-top: 18px;
  padding: 16px 22px 10px;
}

.recent-head {
  font-size: 12.5px;
  color: var(--ink-2);
  padding-bottom: 10px;
  border-bottom: 1px solid var(--rule);
}

.recent-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.recent-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--rule-soft);
  cursor: pointer;
  text-align: left;
}

.recent-row:last-child {
  border-bottom: none;
}

.recent-row:hover .recent-name {
  color: var(--brand);
}

.recent-name {
  flex: 1;
  font-size: 13.5px;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recent-meta {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  color: var(--ink-3);
}

.page-foot {
  margin: 18px 0 0;
  font-size: 12px;
  line-height: 1.8;
  color: var(--ink-3);
}
</style>
