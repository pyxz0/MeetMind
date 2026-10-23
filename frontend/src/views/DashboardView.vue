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
        { key: 'NOT_STARTED', label: '未开始', count: s.notStartedMeetings, color: 'var(--status-wait-dot)' },
        { key: 'IN_PROGRESS', label: '进行中', count: s.inProgressMeetings, color: 'var(--status-live-dot)' },
        { key: 'COMPLETED', label: '已完成', count: s.completedMeetings, color: 'var(--status-done-dot)' },
        { key: 'CANCELLED', label: '已取消', count: s.cancelledMeetings, color: 'var(--status-cancel-dot)' },
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

/** 状态 → 视觉修饰词，颜色统一在 style.css 的 .m-status--* 里 */
const statusKey = (status?: MeetingRecord['completionStatus']) => {
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

/** 点击最近会议进入详情 */
const openMeeting = (id: number) => {
    router.push(`/history/${id}`)
}

onMounted(loadStats)
</script>

<template>
    <div class="page" v-loading="loading">
        <div class="page-inner">
            <header class="page-head">
                <div>
                    <h1>数据看板</h1>

                    <p class="page-desc">
                        会议、待办与决策的底账。数字按完成时间统计。
                    </p>
                </div>

                <div class="page-head-actions">
                    <el-button :loading="loading" @click="loadStats">
                        刷新数据
                    </el-button>
                </div>
            </header>

            <template v-if="stats">

                <!-- 汇总条：五个数字用竖线分开，不做五张卡片 -->
                <div class="totals sheet">
                    <div class="total">
                        <span class="total-k">会议总数</span>
                        <span class="total-v">{{ stats.totalMeetings }}</span>
                        <span class="total-x">已创建会议</span>
                    </div>

                    <div class="total">
                        <span class="total-k">草稿箱</span>
                        <span class="total-v">{{ stats.draftMeetings }}</span>
                        <span class="total-x">待生成纪要</span>
                    </div>

                    <div class="total">
                        <span class="total-k">已完成会议</span>
                        <span class="total-v">{{ stats.completedMeetings }}</span>
                        <span class="total-x">已归档</span>
                    </div>

                    <div class="total">
                        <span class="total-k">待办事项</span>
                        <span class="total-v">{{ stats.totalTodos }}</span>
                        <span class="total-x">会议产生的任务</span>
                    </div>

                    <div class="total">
                        <span class="total-k">核心决策</span>
                        <span class="total-v">{{ stats.totalDecisions }}</span>
                        <span class="total-x">AI 提取</span>
                    </div>
                </div>

                <div class="two-col">
                    <!-- 会议状态 -->
                    <section class="sheet block">
                        <div class="block-head">
                            <span class="sec-t">会议状态</span>

                            <span class="sec-x">共 {{ stats.totalMeetings }} 场</span>
                        </div>

                        <ul class="status-list">
                            <li>
                                <span class="status-name"><i class="m-dot m-dot--wait" /><span class="status-k">未开始</span></span>
                                <span class="num status-v">{{ stats.notStartedMeetings }}</span>
                            </li>

                            <li>
                                <span class="status-name"><i class="m-dot m-dot--live" /><span class="status-k">进行中</span></span>
                                <span class="num status-v">{{ stats.inProgressMeetings }}</span>
                            </li>

                            <li>
                                <span class="status-name"><i class="m-dot m-dot--done" /><span class="status-k">已完成</span></span>
                                <span class="num status-v">{{ stats.completedMeetings }}</span>
                            </li>

                            <li>
                                <span class="status-name"><i class="m-dot m-dot--cancel" /><span class="status-k">已取消</span></span>
                                <span class="num status-v">{{ stats.cancelledMeetings }}</span>
                            </li>
                        </ul>
                    </section>

                    <!-- 完成情况 -->
                    <section class="sheet block">
                        <div class="block-head">
                            <span class="sec-t">完成情况</span>

                            <!-- 切换统计维度：待办完成情况 / 会议完成情况 -->
                            <el-segmented v-model="completionMode" size="small" class="block-seg" :options="[
                                { label: '待办', value: 'todos' },
                                { label: '会议', value: 'meeting' }
                            ]" />
                        </div>

                        <!-- 待办完成情况 -->
                        <template v-if="completionMode === 'todos'">
                            <div class="todo-progress">
                                <div class="todo-nums">
                                    <span class="num todo-done">{{ stats.completedTodos }}</span>
                                    <span class="todo-slash">/</span>
                                    <span class="num todo-all">{{ stats.totalTodos }}</span>
                                    <span class="todo-unit">项待办</span>
                                </div>

                                <div class="completion-bar todo-bar" role="img"
                                    :aria-label="`待办完成率 ${todoCompletionRate}%`">
                                    <div class="completion-segment"
                                        :style="{ width: todoCompletionRate + '%', background: 'var(--brand)' }" />
                                </div>

                                <p class="gauge-text">
                                    完成率
                                    <span class="num">{{ todoCompletionRate }}%</span>
                                </p>

                                <div class="todo-split">
                                    <div class="todo-split-item">
                                        <span>已完成</span>
                                        <b class="num">{{ stats.completedTodos }}</b>
                                    </div>

                                    <div class="todo-split-item">
                                        <span>待处理</span>
                                        <b class="num">{{ Math.max(stats.totalTodos - stats.completedTodos, 0) }}</b>
                                    </div>
                                </div>
                            </div>
                        </template>

                        <!-- 会议完成情况 -->
                        <template v-else>
                            <el-empty v-if="meetingCompletionTotal === 0" description="暂无可统计的会议" />

                            <template v-else>
                                <div class="completion-chart">
                                    <div class="completion-bar" role="img"
                                        :aria-label="`会议完成情况：共 ${meetingCompletionTotal} 场`">
                                        <div v-for="segment in barSegments" :key="segment.key" class="completion-segment"
                                            :style="{
                                                width: segmentWidth(segment.count),
                                                background: segment.color
                                            }" :title="`${segment.label} ${segment.count} 场`" />
                                    </div>

                                    <div class="completion-legend">
                                        <div v-for="segment in meetingCompletionSegments" :key="segment.key"
                                            class="legend-item">
                                            <span class="legend-dot" :style="{ background: segment.color }" />

                                            <span class="legend-label">
                                                {{ segment.label }}
                                            </span>

                                            <strong class="legend-value num">
                                                {{ segment.count }}
                                            </strong>
                                        </div>
                                    </div>
                                </div>

                                <p class="gauge-text">
                                    共 {{ meetingCompletionTotal }} 场正式会议，完成率
                                    <span class="num">{{ meetingCompletionRate }}%</span>
                                </p>
                            </template>
                        </template>
                    </section>
                </div>

                <!-- 最近会议 -->
                <section class="sheet block recent">
                    <div class="block-head">
                        <span class="sec-t">最近会议</span>

                        <el-button link class="block-more" @click="router.push('/history')">
                            查看全部
                        </el-button>
                    </div>

                    <el-empty v-if="!recentMeetings.length" description="暂无会议记录" />

                    <div v-else class="recent-list">
                        <div v-for="meeting in recentMeetings" :key="meeting.id" class="recent-row"
                            @click="openMeeting(meeting.id)">
                            <span class="num recent-date">{{ formatMeetingDate(meeting.createdAt) }}</span>

                            <span class="recent-title">
                                {{ meeting.title || `会议 #${meeting.id}` }}
                            </span>

                            <span class="m-status" :class="`m-status--${statusKey(meeting.completionStatus)}`">
                                <i class="m-status-dot" />

                                {{ getCompletionStatusText(meeting.completionStatus) }}
                            </span>
                        </div>
                    </div>
                </section>

                <!-- 草稿提醒：有草稿才出现 -->
                <div v-if="stats.draftMeetings > 0" class="draft-strip">
                    <span>
                        草稿箱里有 <strong>{{ stats.draftMeetings }}</strong> 条原文还没生成纪要
                    </span>

                    <el-button link @click="router.push('/drafts')">
                        去处理
                    </el-button>
                </div>

            </template>

            <!-- 无数据 -->
            <el-empty v-else-if="!loading" description="暂无统计数据" />
        </div>
    </div>
</template>

<style scoped>
/* ---------- 汇总条 ---------- */
.totals {
    display: flex;
}

.total {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 7px;
    padding: 18px 20px 17px;
    border-left: 1px solid var(--rule);
}

.total:first-child {
    border-left: none;
}

.total-k {
    font-size: 11.5px;
    letter-spacing: 0.04em;
    color: var(--ink-3);
}

/* 数字是宋体：和纪要标题同一副字，落在这套语言里 */
.total-v {
    font-family: var(--song);
    font-size: 30px;
    line-height: 1;
    letter-spacing: 0.02em;
    color: var(--ink);
}

.total-x {
    font-size: 11px;
    color: var(--ink-3);
}

/* ---------- 两栏 ---------- */
.two-col {
    display: grid;
    grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
    gap: 18px;
    margin-top: 18px;
    align-items: stretch;
}

.block {
    padding: 18px 22px 20px;
    display: flex;
    flex-direction: column;
}

.block-head {
    display: flex;
    align-items: center;
    gap: 12px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--rule);
}

.block-head .sec-x {
    margin-left: auto;
}

.block-seg {
    margin-left: auto;
}

.block-more {
    margin-left: auto;
}

/* 状态：一行一条横线，数字右对齐 */
.status-list {
    margin: 0;
    padding: 0;
    list-style: none;
}

.status-list li {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding: 13px 2px;
    border-bottom: 1px solid var(--rule-soft);
}

.status-list li:last-child {
    border-bottom: none;
}

.status-name {
    display: flex;
    align-items: center;
    gap: 8px;
}
.status-k {
    font-size: 13px;
    color: var(--ink-2);
}

.status-v {
    font-size: 17px;
    color: var(--ink);
}

/* 完成情况：用条，不用仪表盘 */
.todo-progress {
    padding: 28px 0 8px;
}

.todo-nums {
    display: flex;
    align-items: baseline;
    gap: 8px;
}

.todo-done {
    font-family: var(--song);
    font-size: 34px;
    line-height: 1;
    color: var(--ink);
}

.todo-slash {
    font-size: 15px;
    color: var(--rule);
}

.todo-all {
    font-size: 17px;
    color: var(--ink-2);
}

.todo-unit {
    margin-left: 4px;
    font-size: 11.5px;
    color: var(--ink-3);
}

.todo-bar {
    height: 10px;
    margin-top: 18px;
}

.gauge-text {
    margin-top: 10px;
    font-size: 12px;
    color: var(--ink-2);
}

/* 已完成 / 待处理：两栏，用竖线分开 */
.todo-split {
    display: flex;
    margin-top: 24px;
    border-top: 1px solid var(--rule-soft);
}

.todo-split-item {
    flex: 1;
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    padding: 12px 2px 0;
    border-left: 1px solid var(--rule-soft);
    padding-left: 16px;
}

.todo-split-item:first-child {
    border-left: none;
    padding-left: 2px;
}

.todo-split-item span {
    font-size: 11.5px;
    color: var(--ink-3);
}

.todo-split-item b {
    font-size: 16px;
    font-weight: 400;
    color: var(--ink);
}

.gauge-text .num {
    font-size: 13px;
    color: var(--ink);
}

.completion-chart {
    padding: 26px 0 6px;
}

.completion-bar {
    display: flex;
    height: 14px;
    width: 100%;
    overflow: hidden;
    background: var(--rule-soft);
    border: 1px solid var(--rule);
}

.completion-segment {
    height: 100%;
}

.completion-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 20px;
    margin-top: 18px;
}

.legend-item {
    display: flex;
    align-items: baseline;
    gap: 7px;
    font-size: 12px;
    color: var(--ink-2);
}

.legend-dot {
    width: 8px;
    height: 8px;
    flex-shrink: 0;
}

.legend-value {
    font-size: 12.5px;
    color: var(--ink);
}

/* ---------- 最近会议 ---------- */
.recent {
    margin-top: 18px;
}

.recent-list {
    margin-top: 2px;
}

.recent-row {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 12px 2px;
    border-bottom: 1px solid var(--rule-soft);
    cursor: pointer;
    transition: background-color 0.16s;
}

.recent-row:last-child {
    border-bottom: none;
}

.recent-row:hover {
    background: var(--paper-2);
}

.recent-date {
    flex-shrink: 0;
    width: 96px;
    font-size: 11px;
    color: var(--ink-3);
}

.recent-title {
    flex: 1;
    min-width: 0;

    font-family: var(--song);
    font-size: 14.5px;
    letter-spacing: 0.04em;
    color: var(--ink);

    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

/* ---------- 草稿提醒 ---------- */
.draft-strip {
    display: flex;
    align-items: center;
    gap: 14px;

    margin-top: 18px;
    padding: 13px 20px;

    background: var(--ochre-wash);
    border: 1px solid var(--ochre-line);

    font-size: 12.5px;
    color: var(--ochre-deep);
}

.draft-strip .el-button {
    margin-left: auto;
}

@media (max-width: 980px) {
    .two-col {
        grid-template-columns: minmax(0, 1fr);
    }

    .totals {
        flex-wrap: wrap;
    }

    .total {
        flex: 1 1 33%;
        border-left: none;
        border-bottom: 1px solid var(--rule-soft);
    }
}

@media (max-width: 640px) {
    .page {
        padding: 22px 14px 48px;
    }

    .total {
        flex: 1 1 50%;
    }

    .total-v {
        font-size: 26px;
    }

    .recent-date {
        width: 78px;
    }
}
</style>
