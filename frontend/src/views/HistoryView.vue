<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Search, ArrowDown } from '@element-plus/icons-vue'

import {
  getMeetings,
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
const pinnedCount = computed(
  () => filteredMeetings.value.filter(meeting => !!meeting.pinnedAt).length
)

/**
 * 可直接修改的会议完成状态。
 *
 * 与筛选下拉共用同一套取值，避免两处枚举漂移。
 */
const completionStatusOptions: Array<{
  label: string
  value: MeetingCompletionStatusValue
  type: 'info' | 'warning' | 'success' | 'danger'
}> = [
    { label: '未开始', value: 'NOT_STARTED', type: 'info' },
    { label: '进行中', value: 'IN_PROGRESS', type: 'warning' },
    { label: '已完成', value: 'COMPLETED', type: 'success' },
    { label: '已取消', value: 'CANCELLED', type: 'danger' },
  ]

/**
 * 各完成状态对应的颜色，与下方下拉选项的 `.status-option--*` 保持一致。
 *
 * 下拉选项是自绘内容，用的是固定色值；而选中后的显示值由
 * Element Plus 通过 --el-input-text-color 控制，因此这里把同一个色值
 * 以 CSS 变量形式注入到显示值上，做到「选中什么颜色，显示值就是什么颜色」。
 */
const completionStatusColors: Record<
  MeetingCompletionStatusValue,
  string
> = {
  NOT_STARTED: '#909399',
  IN_PROGRESS: '#e6a23c',
  COMPLETED: '#67c23a',
  CANCELLED: '#f56c6c',
}

/** 把当前状态色注入显示值；状态缺失（如筛选的「全部状态」）时回退到「未开始」的颜色。 */
const completionStatusStyle = (
  status?: MeetingCompletionStatusValue | null | string
) => {
  const key = (status || 'NOT_STARTED') as MeetingCompletionStatusValue

  const color =
    completionStatusColors[key] ?? completionStatusColors.NOT_STARTED

  return {
    // 有值时 Element Plus 取这个变量作为文字色
    '--el-input-text-color': color,
    // 尚未选择时走的是「占位符」变量，一并覆盖，避免空态落回默认浅灰
    '--el-text-color-placeholder': color,
    color,
  }
}

/** 正在提交状态修改的会议 ID，避免重复提交 */
const completionUpdatingId = ref<number | null>(null)

/** 根据标题和日期筛选会议 */
const filteredMeetings = computed(() => {
  const keyword = searchKeyword.value.trim().toLowerCase()

  const filtered = meetings.value.filter(meeting => {
    const title = (meeting.title || `会议 #${meeting.id}`).toLowerCase()

    const matchesKeyword =
      !keyword || title.includes(keyword)

    const matchesStatus =
      !selectedStatus.value ||
      meeting.completionStatus === selectedStatus.value

    const meetingDate = meeting.createdAt
      ? new Date(meeting.createdAt)
      : null

    const matchesStartDate =
      !startDate.value ||
      (meetingDate !== null &&
        !Number.isNaN(meetingDate.getTime()) &&
        meetingDate >= new Date(`${startDate.value}T00:00:00`))

    const matchesEndDate =
      !endDate.value ||
      (meetingDate !== null &&
        !Number.isNaN(meetingDate.getTime()) &&
        meetingDate < new Date(
          new Date(`${endDate.value}T00:00:00`).getTime() +
          24 * 60 * 60 * 1000
        ))

    return (
      matchesKeyword &&
      matchesStatus &&
      matchesStartDate &&
      matchesEndDate
    )
  })

  return [...filtered].sort((a, b) => {
    // 置顶优先：无论用户选哪种排序，置顶会议始终在最前
    const pinA = a.pinnedAt ? new Date(a.pinnedAt).getTime() : 0
    const pinB = b.pinnedAt ? new Date(b.pinnedAt).getTime() : 0

    if (pinA !== pinB) {
      // 多条置顶之间按“最近置顶优先”
      return pinB - pinA
    }

    // 同为置顶或同为未置顶时，按用户选择的创建时间排序
    const timeA = new Date(a.createdAt || 0).getTime()
    const timeB = new Date(b.createdAt || 0).getTime()

    return sortOrder.value === 'newest'
      ? timeB - timeA
      : timeA - timeB
  })
})

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

const isExpanded = (id: number) => expandedIds.value.has(id)

/** 用替换 Set 的方式更新，确保 Vue 能感知变化 */
const toggleExpanded = (id: number) => {
  const next = new Set(expandedIds.value)

  if (next.has(id)) {
    next.delete(id)
  } else {
    next.add(id)
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
}

/** 加载历史会议 */
const loadMeetings = async () => {
  loading.value = true

  try {
    meetings.value = await getMeetings()

  } catch (error) {
    console.error(error)

    ElMessage.error('历史记录加载失败，请检查后端服务是否启动')
  } finally {
    loading.value = false
  }
}

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

onMounted(() => {
  loadMeetings()
})
</script>

<template>
  <div class="history-page">
    <div class="page-container">

      <div class="page-header">
        <div>
          <h1>历史会议</h1>
          <p>查看和管理之前生成的会议纪要</p>
        </div>

        <el-button :loading="loading" @click="loadMeetings">
          刷新
        </el-button>
      </div>

      <div v-loading="loading" class="history-container">

        <!-- 搜索与日期筛选 -->
        <div class="search-bar">
          <el-input v-model="searchKeyword" placeholder="请输入会议标题关键词搜索" clearable style="max-width: 300px">
            <template #prefix>
              <el-icon>
                <Search />
              </el-icon>
            </template>
          </el-input>

          <el-date-picker v-model="startDate" type="date" placeholder="开始日期" value-format="YYYY-MM-DD" clearable />

          <el-date-picker v-model="endDate" type="date" placeholder="结束日期" value-format="YYYY-MM-DD" clearable />

          <el-select v-model="selectedStatus" placeholder="会议状态" clearable style="width: 140px"
            :style="completionStatusStyle(selectedStatus)">
            <el-option label="全部状态" value="" />

            <el-option
              v-for="option in completionStatusOptions"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>

          <el-select v-model="sortOrder" placeholder="排序方式" style="width: 140px">
            <el-option label="最新创建" value="newest" />
            <el-option label="最早创建" value="oldest" />
          </el-select>

          <el-button
            @click="searchKeyword = ''; startDate = ''; endDate = ''; selectedStatus = ''; sortOrder = 'newest'">
            重置筛选
          </el-button>

          <el-button
            :disabled="filteredMeetings.length === 0"
            @click="toggleAllExpanded"
          >
            {{ allExpanded ? '全部收起' : '全部展开' }}
          </el-button>

          <span class="search-count">
            共找到 {{ filteredMeetings.length }} 条会议记录
            <template v-if="pinnedCount > 0">
              （已置顶 {{ pinnedCount }} 条）
            </template>
          </span>
        </div>

        <el-empty v-if="!loading && meetings.length === 0" description="暂时没有会议记录" />

        <el-empty v-else-if="!loading && filteredMeetings.length === 0" description="没有找到匹配的会议记录" />

        <div v-else class="meeting-list">
          <el-card v-for="meeting in filteredMeetings" :key="meeting.id"
            :class="['meeting-card', { pinned: !!meeting.pinnedAt, collapsed: !isExpanded(meeting.id) }]"
            shadow="hover">
            <!-- 卡片头部即折叠开关；折叠后仅保留标题 -->
            <div class="meeting-header" @click="toggleExpanded(meeting.id)">
              <div class="meeting-heading">
                <h2>
                  <span v-if="meeting.pinnedAt" class="pin-mark" title="已置顶">
                    📌
                  </span>

                  <router-link :to="`/history/${meeting.id}`" class="meeting-title-link" @click.stop>
                    {{ meeting.title || `会议 #${meeting.id}` }}
                  </router-link>
                </h2>

                <span v-if="isExpanded(meeting.id)" class="meeting-time">
                  {{ formatDate(meeting.createdAt) }}
                </span>
              </div>

              <div class="header-tags">
                <el-tag v-if="meeting.pinnedAt" type="warning" effect="dark">
                  已置顶
                </el-tag>

                <!-- 可直接在此修改会议状态，无需进入详情页；只改状态，不动待办 -->
                <!--
                  不加 size="small"：Element Plus 会把 small 选择器的标签字号
                  压到 12px，而下拉选项固定 14px，会出现“显示值比选项小一号”的不一致。
                  显示值颜色与选项状态色同步，见 completionStatusStyle。
                -->
                <el-select
                  v-if="isExpanded(meeting.id)"
                  :model-value="meeting.completionStatus || 'NOT_STARTED'"
                  :loading="completionUpdatingId === meeting.id"
                  class="status-select"
                  :style="completionStatusStyle(meeting.completionStatus)"
                  @click.stop
                  @change="(status: MeetingCompletionStatusValue) =>
                    handleCompletionStatusChange(meeting, status)"
                >
                  <el-option
                    v-for="option in completionStatusOptions"
                    :key="option.value"
                    :label="option.label"
                    :value="option.value"
                  >
                    <span :class="`status-option status-option--${option.type}`">
                      {{ option.label }}
                    </span>
                  </el-option>
                </el-select>

                <!-- 只显示箭头，不显示「展开/收起」文字 -->
                <span
                  class="collapse-toggle"
                  :title="isExpanded(meeting.id) ? '收起' : '展开'"
                  :aria-label="isExpanded(meeting.id) ? '收起' : '展开'"
                >
                  <el-icon :class="{ rotated: isExpanded(meeting.id) }">
                    <ArrowDown />
                  </el-icon>
                </span>
              </div>
            </div>

            <div v-show="isExpanded(meeting.id)" class="meeting-body">
              <div class="summary">
                <div class="label">📝 会议摘要</div>

                <p>
                  {{ meeting.summary || '暂无会议摘要' }}
                </p>
              </div>

              <div v-if="meeting.decisions?.length" class="section">
                <div class="label">🎯 会议决策</div>

                <ul>
                  <li v-for="(decision, index) in meeting.decisions" :key="index">
                    {{ decision }}
                  </li>
                </ul>
              </div>

              <div v-if="meeting.todos?.length" class="section">
                <div class="label">✅ 待办事项</div>

                <div class="todo-list">
                  <div v-for="(todo, index) in meeting.todos" :key="index" class="todo-item">
                    <div class="todo-content">
                      {{ todo.content }}
                    </div>

                    <div class="todo-meta">
                      <span>负责人：{{ todo.assignee || '未指定' }}</span>
                      <span>截止：{{ todo.deadline || '未指定' }}</span>
                    </div>
                  </div>
                </div>
              </div>

              <div class="card-actions">
                <el-button type="primary" plain @click="handleView(meeting.id)">
                  查看详情
                </el-button>

                <el-button
                  :type="meeting.pinnedAt ? 'warning' : 'default'"
                  :plain="!meeting.pinnedAt"
                  :loading="pinningId === meeting.id"
                  @click="handleTogglePin(meeting)"
                >
                  {{ meeting.pinnedAt ? '取消置顶' : '置顶' }}
                </el-button>

                <el-button type="danger" plain @click="handleDelete(meeting.id)">
                  删除
                </el-button>
              </div>
            </div>
          </el-card>
        </div>

      </div>
    </div>
  </div>
</template>

<style scoped>
.history-page {
  min-height: 100%;
  background: #f5f7fa;
  padding: 40px 20px 60px;
}

.page-container {
  max-width: 1000px;
  margin: 0 auto;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
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
}

.history-container {
  min-height: 300px;
}

.meeting-list {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.meeting-card {
  border-radius: 12px;
  border: 1px solid #ebeef5;
}

/* 置顶卡片用左侧色条 + 淡背景区分，避免只靠一个标签识别 */
.meeting-card.pinned {
  border-color: #f3d19e;
  background: #fffdf7;
  box-shadow: inset 3px 0 0 #e6a23c;
}

.pin-mark {
  margin-right: 4px;
}

.header-tags {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.status-select {
  width: 116px;
}

/* 下拉选项按状态着色，与详情页状态含义保持一致 */
.status-option--info {
  color: #909399;
}

.status-option--warning {
  color: #e6a23c;
}

.status-option--success {
  color: #67c23a;
}

.status-option--danger {
  color: #f56c6c;
}


.meeting-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  padding-bottom: 18px;
  border-bottom: 1px solid #ebeef5;
  cursor: pointer;
}

/* 折叠态没有内容区，头部不需要下边框与内边距 */
.meeting-card.collapsed .meeting-header {
  padding-bottom: 0;
  border-bottom: none;
}

.meeting-heading {
  min-width: 0;
  flex: 1;
}

/* 标题可直接点进详情，不需要先展开 */
.meeting-title-link {
  color: #303133;
  transition: color 0.2s;
}

.meeting-title-link:hover {
  color: #409eff;
}

.collapse-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  color: #909399;
  font-size: 15px;
  cursor: pointer;
  transition: background 0.2s, color 0.2s;
}

.collapse-toggle:hover {
  color: #409eff;
  background: #f0f2f5;
}

.collapse-toggle .el-icon {
  transition: transform 0.2s;
}

.collapse-toggle .el-icon.rotated {
  transform: rotate(180deg);
}

.meeting-header h2 {
  margin: 0 0 6px;
  font-size: 18px;
  color: #303133;
}

.meeting-time {
  font-size: 13px;
  color: #909399;
}

.summary,
.section {
  margin-top: 18px;
}

.label {
  margin-bottom: 10px;
  font-size: 14px;
  font-weight: 600;
  color: #606266;
}

.summary p {
  margin: 0;
  line-height: 1.7;
  color: #606266;
  white-space: pre-wrap;
}

.section ul {
  margin: 0;
  padding-left: 20px;
  color: #606266;
  line-height: 1.8;
}

.todo-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.todo-item {
  padding: 12px;
  background: #f8f9fb;
  border-radius: 8px;
}

.todo-content {
  color: #303133;
  font-weight: 500;
}

.todo-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin-top: 8px;
  font-size: 13px;
  color: #909399;
}

.card-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid #ebeef5;
}

@media (max-width: 768px) {
  .history-page {
    padding: 24px 12px 40px;
  }

  .page-header h1 {
    font-size: 24px;
  }

  .meeting-header {
    gap: 12px;
  }

  .todo-meta {
    flex-direction: column;
    gap: 5px;
  }
}
</style>