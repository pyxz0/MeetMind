<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
    getMeetingStats,
    getMeetings,
    type MeetingStats,
    type MeetingRecord
} from '../api/meeting'

const stats = ref<MeetingStats | null>(null)
const recentMeetings = ref<MeetingRecord[]>([])
const loading = ref(false)

const router = useRouter()

/**
 * 「待办完成情况」卡片的展示维度。
 *
 * todos   —— 待办视角：待办整体完成率（环形图）
 * meeting —— 会议视角：正式会议按完成状态的分布（堆叠条形图）
 */
const completionMode = ref<'todos' | 'meeting'>('todos')

/** 正式会议总数（后端统计已排除草稿与 AI 失败记录） */
const meetingCompletionTotal = computed(() => {
    const s = stats.value

    if (!s) {
        return 0
    }

    return (
        s.notStartedMeetings +
        s.inProgressMeetings +
        s.completedMeetings +
        s.cancelledMeetings
    )
})

/**
 * 会议完成情况的四个分段。
 *
 * 颜色与历史会议页的状态色保持一致，便于跨页面对照。
 */
const meetingCompletionSegments = computed(() => {
    const s = stats.value

    if (!s) {
        return []
    }

    return [
        { key: 'NOT_STARTED', label: '未开始', count: s.notStartedMeetings, color: '#909399' },
        { key: 'IN_PROGRESS', label: '进行中', count: s.inProgressMeetings, color: '#e6a23c' },
        { key: 'COMPLETED', label: '已完成', count: s.completedMeetings, color: '#67c23a' },
        { key: 'CANCELLED', label: '已取消', count: s.cancelledMeetings, color: '#f56c6c' },
    ]
})

/**
 * 条形图只渲染数量大于 0 的分段。
 *
 * 若把 0 值分段也渲染成 0 宽度元素，:first-child/:last-child 的圆角
 * 会落在看不见的元素上，导致可见的首尾分段没有圆角。
 */
const barSegments = computed(() =>
    meetingCompletionSegments.value.filter(segment => segment.count > 0)
)

/** 某个分段占全部会议的宽度百分比 */
const segmentWidth = (count: number) => {
    if (meetingCompletionTotal.value === 0 || count === 0) {
        return '0%'
    }

    return `${(count / meetingCompletionTotal.value) * 100}%`
}

/** 会议完成率（不把已取消计入分母，否则取消会议会拉低完成率，口径失真） */
const meetingCompletionRate = computed(() => {
    const s = stats.value

    if (!s) {
        return 0
    }

    const effective = meetingCompletionTotal.value - s.cancelledMeetings

    return effective > 0
        ? Math.round((s.completedMeetings / effective) * 100)
        : 0
})

/** 待办完成率 */
const todoCompletionRate = computed(() => {
    if (!stats.value || stats.value.totalTodos === 0) {
        return 0
    }

    return Math.round(
        (stats.value.completedTodos /
            stats.value.totalTodos) *
        100
    )
})

/** 加载统计数据 */
const loadStats = async () => {
    loading.value = true

    try {
        const [statsData, meetingsData] = await Promise.all([
            getMeetingStats(),
            getMeetings()
        ])

        stats.value = statsData

        recentMeetings.value = meetingsData.slice(0, 5)
    } catch (error) {
        console.error('Dashboard 数据加载失败：', error)

        ElMessage.error(
            '数据加载失败，请检查后端服务'
        )
    } finally {
        loading.value = false
    }
}

/** 格式化会议创建时间 */
const formatMeetingDate = (date?: string) => {
    if (!date) {
        return '暂无时间'
    }

    const parsed = new Date(date)

    if (Number.isNaN(parsed.getTime())) {
        return '时间异常'
    }

    return parsed.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    })
}

/** 获取会议状态文字 */
/** 获取会议完成状态文字 */
const getCompletionStatusText = (
    status?: MeetingRecord['completionStatus']
) => {
    switch (status) {
        case 'NOT_STARTED':
            return '未开始'
        case 'IN_PROGRESS':
            return '进行中'
        case 'COMPLETED':
            return '已完成'
        case 'CANCELLED':
            return '已取消'
        default:
            return '未开始'
    }
}

/** 点击最近会议进入详情 */
const openMeeting = (id: number) => {
    router.push(`/history/${id}`)
}

onMounted(loadStats)
</script>

<template>
    <div class="dashboard-page" v-loading="loading">
        <div class="dashboard-container">

            <!-- 页面标题 -->
            <div class="page-header">
                <div>
                    <h1>数据看板</h1>

                    <p>
                        查看 MeetMind 的会议、决策和待办数据
                    </p>
                </div>

                <el-button :loading="loading" @click="loadStats">
                    刷新数据
                </el-button>
            </div>

            <template v-if="stats">

                <!-- 核心统计 -->
                <div class="stats-grid">

                    <el-card class="stat-card" shadow="never">
                        <div class="stat-label">
                            会议总数
                        </div>

                        <div class="stat-value">
                            {{ stats.totalMeetings }}
                        </div>

                        <div class="stat-description">
                            已创建会议
                        </div>
                    </el-card>

                    <el-card class="stat-card" shadow="never">
                        <div class="stat-label">
                            草稿箱
                        </div>

                        <div class="stat-value">
                            {{ stats.draftMeetings }}
                        </div>

                        <div class="stat-description">
                            待重新生成的会议
                        </div>
                    </el-card>

                    <el-card class="stat-card" shadow="never">
                        <div class="stat-label">
                            已完成会议
                        </div>

                        <div class="stat-value">
                            {{ stats.completedMeetings }}
                        </div>

                        <div class="stat-description">
                            已完成的会议
                        </div>
                    </el-card>

                    <el-card class="stat-card" shadow="never">
                        <div class="stat-label">
                            待办事项
                        </div>

                        <div class="stat-value">
                            {{ stats.totalTodos }}
                        </div>

                        <div class="stat-description">
                            会议产生的任务
                        </div>
                    </el-card>

                    <el-card class="stat-card" shadow="never">
                        <div class="stat-label">
                            核心决策
                        </div>

                        <div class="stat-value">
                            {{ stats.totalDecisions }}
                        </div>

                        <div class="stat-description">
                            AI 提取的会议决策
                        </div>
                    </el-card>

                </div>

                <!-- 状态概览 -->
                <div class="overview-grid">

                    <el-card class="overview-card" shadow="never">
                        <template #header>
                            <span>会议状态</span>
                        </template>

                        <div class="status-row">
                            <span>未开始</span>
                            <strong>
                                {{ stats.notStartedMeetings }}
                            </strong>
                        </div>

                        <div class="status-row">
                            <span>进行中</span>
                            <strong>
                                {{ stats.inProgressMeetings }}
                            </strong>
                        </div>

                        <div class="status-row">
                            <span>已完成</span>
                            <strong>
                                {{ stats.completedMeetings }}
                            </strong>
                        </div>

                        <div class="status-row">
                            <span>已取消</span>
                            <strong>
                                {{ stats.cancelledMeetings }}
                            </strong>
                        </div>
                    </el-card>

                    <el-card class="overview-card" shadow="never">
                        <template #header>
                            <div class="overview-header">
                                <span>完成情况</span>

                                <!-- 切换统计维度：待办完成情况 / 会议完成情况 -->
                                <el-segmented
                                    v-model="completionMode"
                                    size="small"
                                    :options="[
                                        { label: '待办完成情况', value: 'todos' },
                                        { label: '会议完成情况', value: 'meeting' }
                                    ]"
                                />
                            </div>
                        </template>

                        <!-- 待办完成情况 -->
                        <template v-if="completionMode === 'todos'">
                            <div class="todo-progress">
                                <el-progress type="dashboard" :percentage="todoCompletionRate" />
                            </div>

                            <div class="progress-text">
                                已完成
                                {{ stats.completedTodos }}
                                /
                                {{ stats.totalTodos }}
                                项
                            </div>
                        </template>

                        <!-- 会议完成情况 -->
                        <template v-else>
                            <el-empty
                                v-if="meetingCompletionTotal === 0"
                                description="暂无可统计的会议"
                            />

                            <template v-else>
                                <div class="completion-chart">
                                    <div
                                        class="completion-bar"
                                        role="img"
                                        :aria-label="`会议完成情况：共 ${meetingCompletionTotal} 场`"
                                    >
                                        <div
                                            v-for="segment in barSegments"
                                            :key="segment.key"
                                            class="completion-segment"
                                            :style="{
                                                width: segmentWidth(segment.count),
                                                background: segment.color
                                            }"
                                            :title="`${segment.label} ${segment.count} 场`"
                                        />
                                    </div>

                                    <div class="completion-legend">
                                        <div
                                            v-for="segment in meetingCompletionSegments"
                                            :key="segment.key"
                                            class="legend-item"
                                        >
                                            <span
                                                class="legend-dot"
                                                :style="{ background: segment.color }"
                                            />

                                            <span class="legend-label">
                                                {{ segment.label }}
                                            </span>

                                            <strong class="legend-value">
                                                {{ segment.count }}
                                            </strong>
                                        </div>
                                    </div>
                                </div>

                                <div class="progress-text">
                                    共 {{ meetingCompletionTotal }} 场正式会议
                                    <span class="completion-rate">
                                        （完成率 {{ meetingCompletionRate }}%）
                                    </span>
                                </div>
                            </template>
                        </template>
                    </el-card>

                </div>

                <!-- 最近会议 -->
                <el-card class="recent-card" shadow="never">
                    <template #header>
                        <div class="recent-header">
                            <span>最近会议</span>

                            <el-button type="primary" link @click="router.push('/history')">
                                查看全部
                            </el-button>
                        </div>
                    </template>

                    <el-empty v-if="!recentMeetings.length" description="暂无会议记录" />

                    <div v-else class="recent-list">
                        <div v-for="meeting in recentMeetings" :key="meeting.id" class="recent-item"
                            @click="openMeeting(meeting.id)">
                            <div class="recent-main">
                                <div class="recent-title">
                                    {{ meeting.title || `会议 #${meeting.id}` }}
                                </div>

                                <div class="recent-meta">
                                    {{ formatMeetingDate(meeting.createdAt) }}
                                </div>
                            </div>

                            <el-tag :type="meeting.completionStatus === 'COMPLETED'
                                ? 'success'
                                : meeting.completionStatus === 'CANCELLED'
                                    ? 'danger'
                                    : meeting.completionStatus === 'IN_PROGRESS'
                                        ? 'warning'
                                        : 'info'
                                ">
                                {{ getCompletionStatusText(meeting.completionStatus) }}
                            </el-tag>

                            <span class="recent-arrow">
                                →
                            </span>
                        </div>
                    </div>
                </el-card>

                <div class="draft-entry">
                    <div>
                        <strong>草稿箱</strong>
                        <span>
                            当前有 {{ stats.draftMeetings }} 条会议需要处理
                        </span>
                    </div>

                    <el-button type="warning" plain @click="router.push('/drafts')">
                        查看草稿箱
                    </el-button>
                </div>

                <!-- 项目数据说明 -->
                <el-card class="info-card" shadow="never">
                    <template #header>
                        <span>MeetMind 数据概览</span>
                    </template>

                    <div class="info-grid">
                        <div>
                            <span>已完成会议</span>
                            <strong>
                                {{ stats.completedMeetings }}
                            </strong>
                        </div>

                        <div>
                            <span>待处理任务</span>
                            <strong>
                                {{
                                    Math.max(
                                        stats.totalTodos -
                                        stats.completedTodos,
                                        0
                                    )
                                }}
                            </strong>
                        </div>

                        <div>
                            <span>AI 提取决策</span>
                            <strong>
                                {{ stats.totalDecisions }}
                            </strong>
                        </div>
                    </div>
                </el-card>

            </template>

            <!-- 无数据 -->
            <el-empty v-else-if="!loading" description="暂无统计数据" />
        </div>
    </div>
</template>

<style scoped>
.recent-card {
    margin-top: 18px;
    border-radius: 12px;
}

.recent-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
}

.recent-list {
    display: flex;
    flex-direction: column;
}

.recent-item {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 16px 4px;
    border-bottom: 1px solid #f0f2f5;
    cursor: pointer;
    transition: background 0.2s;
}

.recent-item:last-child {
    border-bottom: none;
}

.recent-item:hover {
    background: #f8fafc;
}

.recent-main {
    flex: 1;
    min-width: 0;
}

.recent-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #303133;
    font-size: 14px;
    font-weight: 600;
}

.recent-meta {
    margin-top: 6px;
    color: #909399;
    font-size: 12px;
}

.recent-arrow {
    color: #c0c4cc;
    font-size: 18px;
}

.dashboard-page {
    min-height: 100%;
    background: #f5f7fa;
    padding: 40px 20px 60px;
}

.dashboard-container {
    max-width: 1100px;
    margin: 0 auto;
}

.page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
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

.stats-grid {
    display: grid;
    grid-template-columns:
        repeat(5, minmax(0, 1fr));
    gap: 18px;
}

.stat-card {
    border-radius: 12px;
}

.stat-label {
    color: #909399;
    font-size: 14px;
}

.stat-value {
    margin-top: 10px;
    font-size: 32px;
    font-weight: 700;
    color: #303133;
}

.stat-description {
    margin-top: 8px;
    color: #a0a4ab;
    font-size: 12px;
}

.overview-grid {
    display: grid;
    grid-template-columns:
        1fr 1fr;
    gap: 18px;
    margin-top: 18px;
}

.overview-card,
.info-card {
    border-radius: 12px;
}

.status-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 0;
    border-bottom: 1px solid #f0f2f5;
    color: #606266;
}

.status-row:last-child {
    border-bottom: none;
}

.status-row strong {
    color: #303133;
}

.todo-progress {
    display: flex;
    justify-content: center;
    padding-top: 10px;
}

.progress-text {
    margin-top: 10px;
    text-align: center;
    color: #606266;
    font-size: 14px;
}

/* 卡片标题行：标题 + 维度切换 */
.overview-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
}

.completion-chart {
    padding-top: 6px;
}

/* 堆叠条形图：用各状态占比表达会议完成情况 */
.completion-bar {
    display: flex;
    width: 100%;
    height: 26px;
    border-radius: 6px;
    overflow: hidden;
    background: #f0f2f5;
}

.completion-segment {
    height: 100%;
    transition: width 0.3s;
}

/* 没有数据的状态不占位，但仍保留圆角收口 */
.completion-segment:first-child {
    border-radius: 6px 0 0 6px;
}

.completion-segment:last-child {
    border-radius: 0 6px 6px 0;
}

.completion-legend {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px 16px;
    margin-top: 16px;
}

.legend-item {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: #606266;
}

.legend-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
}

.legend-label {
    flex: 1;
}

.legend-value {
    color: #303133;
    font-size: 14px;
}

.completion-rate {
    color: #909399;
}

.info-card {
    margin-top: 18px;
}

.info-grid {
    display: grid;
    grid-template-columns:
        repeat(3, 1fr);
    gap: 20px;
}

.info-grid div {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 18px;
    background: #f8fafc;
    border-radius: 10px;
}

.info-grid span {
    color: #909399;
    font-size: 13px;
}

.info-grid strong {
    color: #303133;
    font-size: 24px;
}

.draft-entry {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-top: 18px;
  padding: 18px 20px;
  background: #fff8e6;
  border: 1px solid #f3e2b3;
  border-radius: 12px;
}

.draft-entry > div {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.draft-entry strong {
  color: #303133;
  font-size: 15px;
}

.draft-entry span {
  color: #909399;
  font-size: 13px;
}

@media (max-width: 600px) {
  .draft-entry {
    align-items: stretch;
    flex-direction: column;
  }
}

@media (max-width: 900px) {
    .stats-grid {
        grid-template-columns:
            repeat(2, minmax(0, 1fr));
    }
}

@media (max-width: 600px) {

    .recent-item {
        gap: 10px;
    }

    .recent-arrow {
        display: none;
    }

    .dashboard-page {
        padding: 24px 12px 40px;
    }

    .page-header {
        align-items: stretch;
        flex-direction: column;
    }

    .page-header h1 {
        font-size: 24px;
    }

    .stats-grid {
        grid-template-columns: 1fr;
    }

    .overview-grid {
        grid-template-columns: 1fr;
    }

    .info-grid {
        grid-template-columns: 1fr;
    }
}
</style>