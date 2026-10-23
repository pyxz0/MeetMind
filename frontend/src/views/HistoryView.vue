<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Search, ArrowDown } from '@element-plus/icons-vue'

import {
  getMeetingsPage,
  getMeeting,
  deleteMeeting,
  updateMeetingPinned,
  updateMeetingCompletionStatus,
  type MeetingRecord,
  type MeetingCompletionStatusValue
} from '../api/meeting'

const router = useRouter()

const meetings = ref<MeetingRecord[]>([])
const loading = ref(false)

/** 会议标题搜索关键词 */
const searchKeyword = ref('')

/** 会议开始日期 */
const startDate = ref('')

/** 会议结束日期 */
const endDate = ref('')

/** 会议状态筛选 */
const selectedStatus = ref('')

/** 会议排序方式 */
const sortOrder = ref('newest')

/** 当前筛选结果中的置顶数量，用于列表上方的统计提示 */
const pinnedCount = ref(0)

/**
 * 可直接修改的会议完成状态。
 *
 * 与筛选下拉共用同一套取值，避免两处枚举漂移。
 */
const completionStatusOptions: Array<{
  label: string
  value: MeetingCompletionStatusValue
}> = [
    { label: '未开始', value: 'NOT_STARTED' },
    { label: '进行中', value: 'IN_PROGRESS' },
    { label: '已完成', value: 'COMPLETED' },
    { label: '已取消', value: 'CANCELLED' },
  ]

/**
 * 状态 → 视觉修饰词。
 *
 * 四种状态共用一套「圆点 + 文字 + 底色」的标记（见 style.css 的 .m-status），
 * 这里只负责把业务枚举翻成修饰词，颜色不在页面里写死。
 */
const statusKey = (status?: MeetingCompletionStatusValue | null) => {
  switch (status) {
    case 'IN_PROGRESS':
      return 'live'
    case 'COMPLETED':
      return 'done'
    case 'CANCELLED':
      return 'cancel'
    default:
      return 'wait'
  }
}

/** 状态的中文名：任何地方都从同一份选项取，避免两处枚举漂移 */
const statusLabel = (status?: MeetingCompletionStatusValue | null) =>
  completionStatusOptions.find(option => option.value === status)?.label ?? '未开始'

/** 正在提交状态修改的会议 ID，避免重复提交 */
const completionUpdatingId = ref<number | null>(null)

/** 根据标题和日期筛选会议 */
const filteredMeetings = computed(() => meetings.value)

/**
 * 已展开的会议 ID 集合。
 *
 * 记录「展开项」而不是「折叠项」，因此会议默认折叠（只显示标题），
 * 包括置顶会议在内 —— 置顶不改变展开状态。
 * 需要查看内容时手动展开，或用工具栏的「全部展开」。
 *
 * 放在模块作用域，使其在页面切换后依然保留（单次会话内）。
 */
const expandedIds = ref<Set<number>>(new Set())

/** 列表总条数（服务端分页后的总数） */
const totalMeetings = ref(0)

/** 展开卡片时才按需拉详情：列表接口不返回决策与待办明细 */
const detailCache = ref<Record<number, MeetingRecord>>({})
const detailLoading = ref<Record<number, boolean>>({})

const detailOf = (id: number) => detailCache.value[id]

const ensureDetail = async (id: number) => {
  if (detailCache.value[id] || detailLoading.value[id]) return

  detailLoading.value[id] = true

  try {
    detailCache.value[id] = await getMeeting(id)
  } catch {
    ElMessage.error('会议详情加载失败')
  } finally {
    detailLoading.value[id] = false
  }
}

const isExpanded = (id: number) => expandedIds.value.has(id)

/** 用替换 Set 的方式更新，确保 Vue 能感知变化 */
const toggleExpanded = (id: number) => {
  const next = new Set(expandedIds.value)

  if (next.has(id)) {
    next.delete(id)
  } else {
    next.add(id)

    // 列表只含摘要，展开时才拉取决策与待办明细
    void ensureDetail(id)
  }

  expandedIds.value = next
}

/** 当前筛选结果是否已全部展开，用于决定全局按钮的文案与动作 */
const allExpanded = computed(() => {
  const list = filteredMeetings.value

  return (
    list.length > 0 &&
    list.every(meeting => expandedIds.value.has(meeting.id))
  )
})

/** 一键展开 / 折叠当前列表 */
const toggleAllExpanded = () => {
  if (allExpanded.value) {
    expandedIds.value = new Set()
    return
  }

  expandedIds.value = new Set(
    filteredMeetings.value.map(meeting => meeting.id)
  )

  // 全部展开后逐条补齐明细（列表接口只给摘要）
  filteredMeetings.value.forEach(meeting => {
    void ensureDetail(meeting.id)
  })
}

/** 每页条数 */
const PAGE_SIZE = 20

const currentPage = ref(1)
const hasMore = ref(false)
const loadingMore = ref(false)

/** 组装服务端查询参数：筛选与排序都交给后端，避免只过滤当前页 */
const buildQuery = (page: number) => ({
  page,
  pageSize: PAGE_SIZE,
  keyword: searchKeyword.value.trim() || undefined,
  status: (selectedStatus.value || undefined) as
    | MeetingCompletionStatusValue
    | undefined,
  from: startDate.value || undefined,
  to: endDate.value || undefined,
  sort: sortOrder.value as 'newest' | 'oldest'
})

/** 加载历史会议（reset=true 为重新加载第一页） */
const loadMeetings = async (reset = true) => {
  if (reset) {
    loading.value = true
  } else {
    loadingMore.value = true
  }

  try {
    const page = reset ? 1 : currentPage.value + 1
    const result = await getMeetingsPage(buildQuery(page))

    meetings.value = reset ? result.items : [...meetings.value, ...result.items]

    currentPage.value = result.page
    hasMore.value = result.hasMore
    totalMeetings.value = result.total
    pinnedCount.value = result.pinnedTotal ?? 0
  } catch (error) {
    console.error(error)

    ElMessage.error('历史记录加载失败，请检查后端服务是否启动')
  } finally {
    loading.value = false
    loadingMore.value = false
  }
}

/**
 * 筛选条件变化后重新查询。
 *
 * 关键词做了 300ms 防抖，避免每敲一个字就打一次接口。
 */
let keywordTimer: ReturnType<typeof setTimeout> | null = null

watch(searchKeyword, () => {
  if (keywordTimer) clearTimeout(keywordTimer)

  keywordTimer = setTimeout(() => {
    void loadMeetings()
  }, 300)
})

watch([selectedStatus, startDate, endDate, sortOrder], () => {
  void loadMeetings()
})
/**
 * 在历史列表里直接修改会议完成状态。
 *
 * 只调用会议状态接口，不触碰任何待办记录，
 * 因此修改状态不会影响该会议内部的待办内容与完成情况。
 */
const handleCompletionStatusChange = async (
  meeting: MeetingRecord,
  status: MeetingCompletionStatusValue
) => {
  if (completionUpdatingId.value !== null) {
    return
  }

  const previousStatus = meeting.completionStatus

  if (previousStatus === status) {
    return
  }

  completionUpdatingId.value = meeting.id

  // 乐观更新，接口失败再回滚
  meeting.completionStatus = status

  try {
    const result = await updateMeetingCompletionStatus(
      meeting.id,
      status
    )

    // 以服务端返回值兜底，避免本地与服务端不一致
    if (result?.completionStatus) {
      meeting.completionStatus = result.completionStatus
    }

    ElMessage.success('会议状态已更新')
  } catch (error) {
    meeting.completionStatus = previousStatus

    console.error('会议状态修改失败：', error)
    ElMessage.error('会议状态修改失败，请重试')
  } finally {
    completionUpdatingId.value = null
  }
}

/** 查看会议详情 */
const handleView = (id: number) => {
  router.push(`/history/${id}`)
}

/** 正在切换置顶状态的会议 ID，用于避免重复点击 */
const pinningId = ref<number | null>(null)

/**
 * 置顶 / 取消置顶。
 *
 * 直接用后端返回的置顶时间更新本地记录，
 * 排序是派生的，更新后无需重新拉取整个列表。
 */
const handleTogglePin = async (meeting: MeetingRecord) => {
  if (pinningId.value !== null) {
    return
  }

  const nextPinned = !meeting.pinnedAt
  const previousPinnedAt = meeting.pinnedAt ?? null

  pinningId.value = meeting.id

  // 乐观更新，避免等接口回来才动
  meeting.pinnedAt = nextPinned
    ? new Date().toISOString()
    : null

  try {
    const result = await updateMeetingPinned(meeting.id, nextPinned)

    meeting.pinnedAt = result?.pinnedAt ?? null

    ElMessage.success(nextPinned ? '已置顶' : '已取消置顶')
  } catch (error) {
    // 失败回滚，避免界面显示与服务端不一致
    meeting.pinnedAt = previousPinnedAt

    console.error('置顶操作失败：', error)
    ElMessage.error(nextPinned ? '置顶失败，请重试' : '取消置顶失败，请重试')
  } finally {
    pinningId.value = null
  }
}

/** 删除会议 */
const handleDelete = async (id: number) => {
  try {
    await ElMessageBox.confirm(
      '确定要删除这条会议记录吗？删除后无法恢复。',
      '删除确认',
      {
        confirmButtonText: '确定删除',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )

    await deleteMeeting(id)

    ElMessage.success('删除成功')

    await loadMeetings()
  } catch (error: any) {
    if (error !== 'cancel' && error !== 'close') {
      console.error(error)
      ElMessage.error('删除失败')
    }
  }
}

/** 格式化时间 */
const formatDate = (date?: string) => {
  if (!date) return '时间未知'

  const value = new Date(date)

  if (Number.isNaN(value.getTime())) {
    return date
  }

  return value.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/** 文号：用会议 ID 补足三位，像档案编号 */
const refNo = (id: number) => String(id).padStart(3, '0')

onMounted(() => {
  loadMeetings()
})
</script>

<template>
  <div class="page">
    <div class="page-inner">
      <header class="page-head">
        <div>
          <h1>历史会议</h1>

          <p class="page-desc">
            每一份纪要都在册。可检索、可置顶、可回听原文。
          </p>
        </div>

        <div class="page-head-actions">
          <el-button :loading="loading" @click="loadMeetings">
            刷新
          </el-button>
        </div>
      </header>

      <!-- 检索带 -->
      <div class="filter-bar">
        <el-input v-model="searchKeyword" class="f-search" placeholder="搜索标题、摘要、原文、决策与待办" clearable>
          <template #prefix>
            <el-icon>
              <Search />
            </el-icon>
          </template>
        </el-input>

        <el-date-picker v-model="startDate" class="w-date" type="date" placeholder="开始日期" value-format="YYYY-MM-DD"
          clearable />

        <el-date-picker v-model="endDate" class="w-date" type="date" placeholder="结束日期" value-format="YYYY-MM-DD"
          clearable />

        <el-select v-model="selectedStatus" class="f-status" placeholder="会议状态" clearable>
          <el-option label="全部状态" value="" />

          <el-option v-for="option in completionStatusOptions" :key="option.value" :label="option.label"
            :value="option.value" />
        </el-select>

        <el-select v-model="sortOrder" class="f-sort" placeholder="排序">
          <el-option label="最新创建" value="newest" />
          <el-option label="最早创建" value="oldest" />
        </el-select>

        <el-button
          @click="searchKeyword = ''; startDate = ''; endDate = ''; selectedStatus = ''; sortOrder = 'newest'">
          重置
        </el-button>

        <span class="filter-count">
          共 {{ totalMeetings }} 份
          <template v-if="pinnedCount > 0">，置顶 {{ pinnedCount }} 份</template>
        </span>
      </div>

      <!-- 登记簿 -->
      <div v-loading="loading" class="register sheet">
        <div class="register-head">
          <span class="register-title">会议登记簿</span>

          <span class="register-meta">
            {{ filteredMeetings.length }} 份显示中
          </span>

          <el-button link :disabled="filteredMeetings.length === 0" @click="toggleAllExpanded">
            {{ allExpanded ? '全部收起' : '全部展开' }}
          </el-button>
        </div>

        <el-empty v-if="!loading && meetings.length === 0" description="暂时没有会议记录" />

        <el-empty v-else-if="!loading && filteredMeetings.length === 0" description="没有找到匹配的会议" />

        <template v-else>
          <article v-for="meeting in filteredMeetings" :key="meeting.id" class="reg-row"
            :class="{ 'reg-open': isExpanded(meeting.id), 'reg-pinned': !!meeting.pinnedAt }">
            <!-- 行首：文号 + 标题 + 日期；整行是展开开关 -->
            <header class="reg-head" role="button" tabindex="0" :aria-expanded="isExpanded(meeting.id)"
              @click="toggleExpanded(meeting.id)" @keydown.enter.prevent="toggleExpanded(meeting.id)"
              @keydown.space.prevent="toggleExpanded(meeting.id)">
              <span class="reg-no num">{{ refNo(meeting.id) }}</span>

              <div class="reg-main">
                <h2 class="reg-title">
                  <router-link :to="`/history/${meeting.id}`" @click.stop>
                    {{ meeting.title || `会议 #${meeting.id}` }}
                  </router-link>
                </h2>

                <span class="reg-sub num">
                  {{ formatDate(meeting.createdAt) }}
                </span>
              </div>

              <span v-if="meeting.pinnedAt" class="reg-pin">置顶</span>

              <div class="reg-state" @click.stop>
                <!-- 只读共享者只看到状态标记，不可修改 -->
                <span v-if="!meeting.canEdit" class="m-status" :class="`m-status--${statusKey(meeting.completionStatus)}`">
                  <i class="m-status-dot" />

                  {{ statusLabel(meeting.completionStatus) }}
                </span>

                <!-- 能改的人：同一枚标记，点开就是状态菜单 -->
                <el-dropdown v-else trigger="click" placement="bottom-end"
                  @command="(status: MeetingCompletionStatusValue) => handleCompletionStatusChange(meeting, status)">
                  <button type="button" class="m-status"
                    :class="`m-status--${statusKey(meeting.completionStatus)}`"
                    :disabled="completionUpdatingId === meeting.id"
                    :aria-label="`会议状态：${statusLabel(meeting.completionStatus)}，点击修改`">
                    <i class="m-status-dot" />

                    {{ statusLabel(meeting.completionStatus) }}

                    <span class="m-status-caret" aria-hidden="true" />
                  </button>

                  <template #dropdown>
                    <el-dropdown-menu>
                      <el-dropdown-item v-for="option in completionStatusOptions" :key="option.value"
                        :command="option.value">
                        <span class="m-status" :class="`m-status--${statusKey(option.value)}`">
                          <i class="m-status-dot" />

                          {{ option.label }}
                        </span>
                      </el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
              </div>

              <span class="reg-toggle" :title="isExpanded(meeting.id) ? '收起' : '展开'"
                :aria-label="isExpanded(meeting.id) ? '收起' : '展开'">
                <el-icon :class="{ rotated: isExpanded(meeting.id) }">
                  <ArrowDown />
                </el-icon>
              </span>
            </header>

            <!-- 展开：正文按「摘要 / 决策 / 待办」三段 -->
            <div v-show="isExpanded(meeting.id)" class="reg-body">
              <div class="sec">
                <div class="sec-h">
                  <span class="sec-n">一</span>
                  <span class="sec-t">摘要</span>
                </div>

                <p class="prose reg-summary">
                  {{ meeting.summary || '暂无会议摘要' }}
                </p>
              </div>

              <div v-if="detailOf(meeting.id)?.decisions?.length" class="sec">
                <div class="sec-h">
                  <span class="sec-n">二</span>
                  <span class="sec-t">核心决策</span>
                  <span class="sec-x">{{ detailOf(meeting.id)?.decisions?.length }} 条</span>
                </div>

                <ol class="reg-decisions">
                  <li v-for="(decision, index) in detailOf(meeting.id)?.decisions ?? []" :key="index">
                    <span class="num dec-no">{{ index + 1 }}</span>
                    <span>{{ decision }}</span>
                  </li>
                </ol>
              </div>

              <div v-if="detailOf(meeting.id)?.todos?.length" class="sec">
                <div class="sec-h">
                  <span class="sec-n">三</span>
                  <span class="sec-t">待办事项</span>
                  <span class="sec-x">{{ detailOf(meeting.id)?.todos?.length }} 项</span>
                </div>

                <div class="reg-todos">
                  <div v-for="(todo, index) in detailOf(meeting.id)?.todos ?? []" :key="index" class="reg-todo">
                    <span class="reg-todo-content">{{ todo.content }}</span>

                    <span class="reg-todo-meta">
                      <span class="reg-todo-who">{{ todo.assignee || '未指定' }}</span>
                      <span class="num reg-todo-when">{{ todo.deadline || '未指定' }}</span>
                    </span>
                  </div>
                </div>
              </div>

              <div class="reg-actions">
                <el-button type="primary" @click="handleView(meeting.id)">
                  打开纪要
                </el-button>

                <!-- 置顶属于写操作，只读共享者不可用 -->
                <el-button v-if="meeting.canEdit" :loading="pinningId === meeting.id" @click="handleTogglePin(meeting)">
                  {{ meeting.pinnedAt ? '取消置顶' : '置顶' }}
                </el-button>

                <!-- 删除按后端 capability 判定：拥有者与管理员及以上都能删 -->
                <el-button v-if="meeting.canDelete" type="danger" plain @click="handleDelete(meeting.id)">
                  删除
                </el-button>

                <el-tag v-if="meeting.access === 'read'" size="small" type="info">
                  只读共享
                </el-tag>

                <el-tag v-else-if="meeting.access === 'edit'" size="small" type="warning">
                  可编辑共享
                </el-tag>
              </div>
            </div>
          </article>
        </template>
      </div>

      <!-- 服务端分页：还有更多时继续加载 -->
      <div v-if="hasMore" class="load-more">
        <el-button :loading="loadingMore" @click="loadMeetings(false)">
          加载更早的会议
        </el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 登记簿行结构由全局 style.css 提供（.register / .reg-*），这里只放本页专有的部分 */

/* ---------- 检索带 ---------- */
.filter-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 18px;
}

.f-search {
  width: 260px;
}

.f-status,
.f-sort {
  width: 132px;
}

.filter-count {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--ink-3);
  white-space: nowrap;
}

/* ---------- 展开后的正文 ---------- */
.reg-summary {
  margin-top: 12px;
}

.reg-decisions {
  margin: 0;
  padding: 0;
  list-style: none;
}

.reg-decisions li {
  display: flex;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid var(--rule-soft);

  font-family: var(--fang);
  font-size: 14.5px;
  line-height: 1.75;
  color: var(--ink-body);
}

.reg-decisions li:last-child {
  border-bottom: none;
}

.dec-no {
  flex-shrink: 0;
  min-width: 14px;
  padding-top: 3px;
  font-size: 11px;
  color: var(--ink-3);
}

.reg-todos {
  margin-top: 8px;
  border-top: 1px solid var(--rule-soft);
}

.reg-todo {
  display: flex;
  align-items: baseline;
  gap: 16px;
  padding: 9px 0;
  border-bottom: 1px solid var(--rule-soft);
}

.reg-todo-content {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--ink);
}

.reg-todo-meta {
  display: flex;
  gap: 14px;
  flex-shrink: 0;
}

.reg-todo-who {
  font-family: var(--song);
  font-size: 13px;
  letter-spacing: 0.04em;
  color: var(--ink-2);
}

.reg-todo-when {
  font-size: 11px;
  color: var(--ink-3);
}

.load-more {
  display: flex;
  justify-content: center;
  padding: 20px 0 4px;
}

@media (max-width: 900px) {
  .filter-count {
    margin-left: 0;
    width: 100%;
  }
}

@media (max-width: 640px) {
  .page {
    padding: 22px 14px 48px;
  }

  .f-search,
  .f-status,
  .f-sort {
    width: 100%;
  }

  .reg-todo {
    flex-direction: column;
    gap: 4px;
  }
}
</style>
