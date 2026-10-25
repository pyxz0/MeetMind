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
