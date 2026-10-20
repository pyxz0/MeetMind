<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  listAuditLogs,
  type AuditLogItem,
  type AuditLogQuery
} from '../api/audit'

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
  'user.delete': '删除账号',
  'user.impersonate': '切换身份',
  'meeting.delete': '删除会议',
  'meeting.share': '共享会议',
  'meeting.share_revoke': '撤销共享'
}

const actionLabel = (action: string) =>
  ACTION_LABELS[action] ?? action

/** 动作标签颜色：破坏性操作标红 */
const actionTagType = (action: string) => {
  if (action.endsWith('.delete') || action.endsWith('.revoke')) return 'danger'
  if (action === 'user.impersonate') return 'warning'
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
</script>

<template>
  <div class="audit-page">
    <div class="page-container">
      <div class="page-header">
        <div>
          <h1>审计日志</h1>
          <p>记录登录、账号变更、会议删除、共享与切换身份等敏感操作</p>
        </div>

        <div class="header-actions">
          <el-button @click="router.push('/profile')">
            返回个人中心
          </el-button>

          <el-button :loading="loading" @click="load">
            刷新
          </el-button>
        </div>
      </div>

      <el-card shadow="never" class="table-card">
        <div class="filters">
          <el-select v-model="filterAction" placeholder="全部操作" clearable style="width: 170px">
            <el-option v-for="(label, action) in ACTION_LABELS" :key="action" :label="label" :value="action" />
          </el-select>

          <el-select v-model="filterResourceType" placeholder="全部资源" clearable style="width: 140px">
            <el-option label="会议" value="meeting" />
            <el-option label="账号" value="user" />
          </el-select>

          <span class="range-text">{{ rangeText }}</span>
        </div>

        <el-table v-loading="loading" :data="logs" style="width: 100%">
          <el-table-column label="时间" width="190">
            <template #default="{ row }">
              {{ formatTime(row.createdAt) }}
            </template>
          </el-table-column>

          <el-table-column label="操作" width="140">
            <template #default="{ row }">
              <el-tag :type="actionTagType(row.action)" size="small">
                {{ actionLabel(row.action) }}
              </el-tag>
            </template>
          </el-table-column>

          <el-table-column label="操作者" width="160">
            <template #default="{ row }">
              <span v-if="row.actor">{{ row.actor.name }}</span>
              <span v-else class="muted">账号已删除</span>

              <el-tag v-if="row.impersonatedBy" type="warning" size="small" effect="plain" class="impersonate-tag">
                代登
              </el-tag>
            </template>
          </el-table-column>

          <el-table-column label="资源" width="140">
            <template #default="{ row }">
              {{ resourceLabel(row.resourceType) }}
              <span v-if="row.resourceId" class="muted">#{{ row.resourceId }}</span>
            </template>
          </el-table-column>

          <el-table-column label="详情" min-width="220">
            <template #default="{ row }">
              <span class="meta-text">{{ formatMetadata(row.metadata) }}</span>
            </template>
          </el-table-column>
        </el-table>

        <el-empty v-if="!loading && logs.length === 0" description="暂无审计记录" :image-size="70" />

        <div class="pager">
          <el-button :disabled="page <= 1" @click="goPage(page - 1)">
            上一页
          </el-button>

          <span class="pager-text">第 {{ page }} 页</span>

          <el-button :disabled="!hasMore" @click="goPage(page + 1)">
            下一页
          </el-button>
        </div>
      </el-card>
    </div>
  </div>
</template>

<style scoped>
.audit-page {
  min-height: 100%;
  background: #f5f7fa;
  padding: 40px 20px 60px;
}

.page-container {
  max-width: 1100px;
  margin: 0 auto;
}

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
}

.page-header h1 {
  margin: 0 0 6px;
  font-size: 30px;
  font-weight: 600;
  color: #303133;
}

.page-header p {
  margin: 0;
  color: #909399;
  font-size: 14px;
}

.header-actions {
  display: flex;
  gap: 8px;
}

.table-card {
  border-radius: 12px;
}

.filters {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}

.range-text {
  margin-left: auto;
  color: #909399;
  font-size: 13px;
}

.muted {
  color: #c0c4cc;
  font-size: 12px;
}

.impersonate-tag {
  margin-left: 6px;
}

.meta-text {
  color: #606266;
  font-size: 12px;
  word-break: break-all;
}

.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-top: 16px;
}

.pager-text {
  color: #909399;
  font-size: 13px;
}
</style>
