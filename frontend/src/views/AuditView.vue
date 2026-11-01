<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  listAuditLogs,
  type AuditLogItem,
  type AuditLogQuery
} from '../api/audit'
import { getSystemJobs, type JobOverview } from '../api/system'

const router = useRouter()

const logs = ref<AuditLogItem[]>([])
const loading = ref(false)
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const hasMore = ref(false)

/** 筛选条件 */
const filterAction = ref('')
const filterResourceType = ref('')

/** 动作 → 中文说明 */
const ACTION_LABELS: Record<string, string> = {
  'auth.login': '登录',
  'user.create': '新建账号',
  'user.update': '修改账号',
  'user.self_update': '修改本账号',
  'user.delete': '删除账号',
  'user.impersonate': '切换身份',
  'user.password_reset_issue': '生成重置链接',
  'user.password_reset': '重置密码',
  'meeting.delete': '删除会议',
  'meeting.share': '共享会议',
  'meeting.share_revoke': '撤销共享',
  'todo.accept_forced': '代验收待办',
  'todo.complete_forced': '代完成待办'
}

const actionLabel = (action: string) =>
  ACTION_LABELS[action] ?? action

/** 动作标签颜色：破坏性操作标红 */
const actionTagType = (action: string) => {
  if (action.endsWith('.delete') || action.endsWith('.revoke')) return 'danger'
  if (action === 'user.impersonate') return 'warning'
  if (action === 'user.password_reset_issue') return 'warning'
  if (action === 'todo.accept_forced') return 'warning'
  if (action === 'todo.complete_forced') return 'warning'
  if (action.startsWith('meeting.share')) return 'warning'
  return 'info'
}

const RESOURCE_LABELS: Record<string, string> = {
  meeting: '会议',
  user: '账号',
  share: '共享'
}

const resourceLabel = (type: string) =>
  RESOURCE_LABELS[type] ?? type

/** 元数据压缩成一行说明，避免表格过长 */
const formatMetadata = (metadata: Record<string, unknown> | null) => {
  if (!metadata) return '—'

  return Object.entries(metadata)
    .filter(([, value]) => value !== null && value !== undefined && value !== false)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('，') || '—'
}

const formatTime = (value: string) => {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) return value

  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

const buildQuery = (): AuditLogQuery => ({
  page: page.value,
  pageSize: pageSize.value,
  action: filterAction.value || undefined,
  resourceType: filterResourceType.value || undefined
})

const load = async () => {
  loading.value = true

  try {
    const result = await listAuditLogs(buildQuery())

    logs.value = result.items
    total.value = result.total
    hasMore.value = result.hasMore
  } catch (error: any) {
    const message = error?.response?.data?.message ?? '审计日志加载失败'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  } finally {
    loading.value = false
  }
}

const goPage = async (next: number) => {
  page.value = next
  await load()
}

watch([filterAction, filterResourceType], () => {
  page.value = 1
  void load()
})

const rangeText = computed(() => {
  if (!total.value) return '暂无记录'

  const from = (page.value - 1) * pageSize.value + 1
  const to = Math.min(page.value * pageSize.value, total.value)

  return `第 ${from}-${to} 条 / 共 ${total.value} 条`
})

onMounted(load)

/* ---------- 后台任务 ---------- */

const jobs = ref<JobOverview[]>([])
const jobsLoading = ref(false)

const loadJobs = async () => {
  jobsLoading.value = true

  try {
    jobs.value = await getSystemJobs()
  } catch {
    // 拿不到就显示空，不影响下面的审计列表
    jobs.value = []
  } finally {
    jobsLoading.value = false
  }
}

/** 相对时间：3 分钟前 / 2 小时前 */
const relativeTime = (iso: string | null): string => {
  if (!iso) return '本次启动后还没执行'

  const diff = Date.now() - new Date(iso).getTime()

  if (diff < 60_000) return '刚刚'

  const minutes = Math.floor(diff / 60_000)

  if (minutes < 60) return `${minutes} 分钟前`

  const hours = Math.floor(minutes / 60)

  if (hours < 24) return `${hours} 小时前`

  return `${Math.floor(hours / 24)} 天前`
}

/**
 * 任务状态：
 * skip = 主动跳过（未配置），warn = 超过预期周期没动静，
 * bad = 上次失败，ok = 正常，idle = 还没跑过
 */
const jobTone = (job: JobOverview): 'ok' | 'warn' | 'bad' | 'idle' | 'skip' => {
  if (job.skipped) return 'skip'
  if (job.stale) return 'warn'
  if (job.lastStatus === 'FAILED') return 'bad'
  if (!job.lastStatus) return 'idle'

  return 'ok'
}

const failedJob = computed(() => jobs.value.find((job) => job.lastError) ?? null)

onMounted(loadJobs)
</script>

<template>
  <div class="page">
    <div class="page-inner">
      <header class="page-head">
        <div>
          <h1>审计日志</h1>

          <p class="page-desc">
            登录、账号变更、会议删除、共享与切换身份的操作留痕。
          </p>
        </div>

        <div class="page-head-actions">
          <el-button @click="router.push('/profile')">
            返回个人中心
          </el-button>

          <el-button :loading="loading" @click="load">
            刷新
          </el-button>
        </div>
      </header>

      <!-- 后台任务：这些是「发出去才有价值」的活儿，静默失败最难发现 -->
      <section class="job-band">
        <div class="job-band-head">
          <h2>后台任务</h2>

          <button type="button" class="job-refresh" :disabled="jobsLoading" @click="loadJobs">
            {{ jobsLoading ? '检查中…' : '重新检查' }}
          </button>
        </div>

        <p class="job-band-desc">
          会议提醒、邮件投递、逾期提醒都跑在后台定时器里。
          超过预期周期没有动静会标成「可能已停」。
        </p>

        <ul v-if="jobs.length" class="job-list">
          <li v-for="job in jobs" :key="job.key" class="job-row" :class="`job-${jobTone(job)}`">
            <span class="job-dot" />

            <div class="job-main">
              <span class="job-label">{{ job.label }}</span>
              <span class="job-meta">
                {{ job.interval }} ·
                {{ job.skipped ? '未配置，已跳过' : relativeTime(job.lastRunAt) }}
              </span>
            </div>

            <div class="job-stats">
              <span v-if="job.skipped" class="job-flag job-flag-skip">未启用</span>
              <span v-else-if="job.stale" class="job-flag">可能已停</span>
              <span v-else-if="job.lastStatus === 'FAILED'" class="job-flag">上次失败</span>

              <span class="job-count">
                24h 内 {{ job.runs24h }} 次<template v-if="job.failures24h">，失败 {{ job.failures24h }} 次</template>
              </span>
            </div>
          </li>
        </ul>

        <p v-else class="job-empty">
          {{ jobsLoading ? '正在读取…' : '暂无任务信息' }}
        </p>

        <p v-if="failedJob" class="job-error">
          {{ failedJob.label }}：{{ failedJob.lastError }}
        </p>
      </section>

      <!-- 筛选带 -->
      <div class="filter-bar">
        <el-select v-model="filterAction" class="f-action" placeholder="全部操作" clearable>
          <el-option v-for="(label, action) in ACTION_LABELS" :key="action" :label="label" :value="action" />
        </el-select>

        <el-select v-model="filterResourceType" class="f-resource" placeholder="全部资源" clearable>
          <el-option label="会议" value="meeting" />
          <el-option label="账号" value="user" />
        </el-select>

        <span class="filter-count">{{ rangeText }}</span>
      </div>

      <!-- 操作台账 -->
      <div class="sheet">
        <div class="table-scroll">
          <el-table v-if="loading || logs.length" v-loading="loading" :data="logs" class="audit-table"
            style="width: 100%">
            <el-table-column label="时间" width="190">
              <template #default="{ row }">
                <span class="num">{{ formatTime(row.createdAt) }}</span>
              </template>
            </el-table-column>

            <el-table-column label="操作者" width="170">
              <template #default="{ row }">
                <span class="actor">
                  <span v-if="row.actor">{{ row.actor.name }}</span>
                  <span v-else class="muted">账号已删除</span>

                  <el-tag v-if="row.impersonatedBy" type="warning" size="small" effect="plain">
                    代登
                  </el-tag>
                </span>
              </template>
            </el-table-column>

            <el-table-column label="动作" width="140">
              <template #default="{ row }">
                <el-tag :type="actionTagType(row.action)" size="small">
                  {{ actionLabel(row.action) }}
                </el-tag>
              </template>
            </el-table-column>

            <el-table-column label="目标" width="140">
              <template #default="{ row }">
                {{ resourceLabel(row.resourceType) }}
                <span v-if="row.resourceId" class="muted num">#{{ row.resourceId }}</span>
              </template>
            </el-table-column>

            <el-table-column label="详情" min-width="220">
              <template #default="{ row }">
                <span class="num meta">{{ formatMetadata(row.metadata) }}</span>
              </template>
            </el-table-column>
          </el-table>

          <el-empty v-else description="暂无审计记录" />
        </div>
      </div>

      <div class="pager">
        <el-button :disabled="page <= 1" @click="goPage(page - 1)">
          上一页
        </el-button>

        <span class="pager-x">第 {{ page }} 页</span>

        <el-button :disabled="!hasMore" @click="goPage(page + 1)">
          下一页
        </el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ---------- 后台任务 ---------- */
.job-band {
  border: 1px solid var(--rule);
  background: var(--paper);
  padding: 16px 18px;
  margin-bottom: 20px;
}

.job-band-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.job-band-head h2 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.job-refresh {
  border: 0;
  background: none;
  padding: 0;
  font-size: 11.5px;
  color: var(--ink-3);
  cursor: pointer;
}

.job-refresh:hover {
  color: var(--ink);
}

.job-refresh:disabled {
  cursor: default;
  opacity: 0.5;
}

.job-band-desc {
  margin: 6px 0 12px;
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--ink-3);
}

.job-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.job-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-top: 1px solid var(--rule);
}

/* 四种状态只用一个圆点区分，颜色克制：正常是灰绿，异常才明显 */
.job-dot {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ink-3);
}

.job-ok .job-dot {
  background: #4a8a63;
}

.job-warn .job-dot {
  background: var(--ochre);
}

.job-bad .job-dot {
  background: #b4453c;
}

.job-idle .job-dot {
  background: var(--ink-3);
  opacity: 0.5;
}

/* 未启用：比「没跑过」更淡，不制造焦虑 */
.job-skip .job-dot {
  background: var(--ink-3);
  opacity: 0.3;
}

.job-flag-skip {
  color: var(--ink-3);
}

.job-main {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.job-label {
  font-size: 12.5px;
}

.job-meta {
  font-size: 11px;
  color: var(--ink-3);
}

.job-stats {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-left: auto;
  white-space: nowrap;
}

.job-flag {
  padding: 0 4px;
  font-size: 10px;
  line-height: 15px;
  border: 1px solid currentColor;
}

.job-warn .job-flag {
  color: var(--ochre);
}

.job-bad .job-flag {
  color: #b4453c;
}

.job-count {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--ink-3);
}

.job-empty {
  margin: 0;
  font-size: 11.5px;
  color: var(--ink-3);
}

.job-error {
  margin: 10px 0 0;
  padding-top: 10px;
  border-top: 1px solid var(--rule);
  font-size: 11.5px;
  line-height: 1.7;
  color: #b4453c;
  word-break: break-all;
}

/* ---------- 筛选带 ---------- */
.filter-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 18px;
}

.f-action {
  width: 170px;
}

.f-resource {
  width: 140px;
}

.filter-count {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--ink-3);
  white-space: nowrap;
}

/* ---------- 操作台账 ---------- */
.table-scroll {
  overflow-x: auto;
}

.actor {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

/* 元数据按等宽排，键值对一眼能对齐 */
.meta {
  font-size: 11.5px;
  color: var(--ink-2);
  word-break: break-all;
}

/* ---------- 翻页 ---------- */
.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-top: 20px;
}

.pager-x {
  font-size: 12px;
  color: var(--ink-3);
}

@media (max-width: 640px) {
  .page {
    padding: 22px 14px 48px;
  }

  .f-action,
  .f-resource {
    width: 100%;
  }

  .filter-count {
    margin-left: 0;
    width: 100%;
  }

  .table-scroll {
    overflow-x: auto;
  }

  .audit-table {
    min-width: 820px;
  }

  .pager {
    flex-wrap: wrap;
  }
}
</style>
