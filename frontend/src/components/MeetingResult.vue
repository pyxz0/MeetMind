<script setup lang="ts">
import { computed } from 'vue'

import type { MeetingResult } from '../api/meeting'

const props = defineProps<{
  result: MeetingResult
}>()

/** 决策既可能是字符串，也可能是 { content }，统一取文本 */
const decisions = computed(() =>
  (props.result.decisions ?? []).map((item) => {
    if (typeof item === 'string') return item

    return (item as { content?: string }).content ?? ''
  }).filter(Boolean)
)

const todos = computed(() => props.result.todos ?? [])

const todoStatusText = (status?: string) => {
  switch (status) {
    case 'COMPLETED':
      return '已完成'
    case 'IN_PROGRESS':
      return '进行中'
    case 'OPEN':
      return '待处理'
    default:
      return status || '待处理'
  }
}

const todoStatusType = (status?: string) => {
  if (status === 'COMPLETED') return 'success'
  if (status === 'IN_PROGRESS') return 'warning'

  return 'danger'
}
</script>

<template>
  <div class="result">
    <!-- 摘要：不设标题，直接当卷首语读 -->
    <p class="prose summary">
      {{ result.summary }}
    </p>

    <div class="red-rule" />

    <section class="sec">
      <div class="sec-h">
        <span class="sec-n">一</span>
        <span class="sec-t">核心决策</span>
        <span class="sec-x">{{ decisions.length }} 条</span>
      </div>

      <ol v-if="decisions.length" class="decisions">
        <li v-for="(decision, index) in decisions" :key="index">
          <span class="num dec-no">{{ index + 1 }}</span>
          <span class="dec-text">{{ decision }}</span>
        </li>
      </ol>

      <p v-else class="empty-line">
        这场会议没有明确的决策。
      </p>
    </section>

    <section class="sec">
      <div class="sec-h">
        <span class="sec-n">二</span>
        <span class="sec-t">待办事项</span>
        <span class="sec-x">{{ todos.length }} 项</span>
      </div>

      <el-table v-if="todos.length" :data="todos" class="todo-table">
        <el-table-column prop="content" label="任务" min-width="240" />

        <el-table-column prop="assignee" label="负责人" width="120">
          <template #default="{ row }">
            <span class="assignee">{{ row.assignee || '未指定' }}</span>
          </template>
        </el-table-column>

        <el-table-column prop="deadline" label="截止" width="150">
          <template #default="{ row }">
            <span class="deadline">{{ row.deadline || '未指定' }}</span>
          </template>
        </el-table-column>

        <el-table-column prop="status" label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="todoStatusType(row.status)" size="small">
              {{ todoStatusText(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>

      <p v-else class="empty-line">
        这场会议没有留下待办。
      </p>
    </section>
  </div>
</template>

<style scoped>
.summary {
  margin: 0;
}

.red-rule {
  margin: 24px 0 0;
  height: 3px;
  border-top: 1.5px solid var(--vermilion);
  border-bottom: 1px solid var(--vermilion);
  opacity: 0.7;
}

.decisions {
  margin: 0;
  padding: 0;
  list-style: none;
}

.decisions li {
  display: flex;
  gap: 14px;
  padding: 9px 0;
  border-bottom: 1px solid var(--rule-soft);

  font-family: var(--fang);
  font-size: 15px;
  line-height: 1.75;
  color: var(--ink-body);
}

.decisions li:last-child {
  border-bottom: none;
}

.dec-no {
  flex-shrink: 0;
  min-width: 16px;
  padding-top: 3px;

  font-size: 11.5px;
  color: var(--ink-3);
}

.dec-text {
  min-width: 0;
}

.assignee {
  font-family: var(--song);
  font-size: 13.5px;
  letter-spacing: 0.04em;
}

.deadline {
  font-family: var(--num);
  font-size: 12px;
  color: var(--ink-2);
}

.todo-table {
  margin-top: 4px;
}

.empty-line {
  padding: 18px 0;
  font-size: 12.5px;
  color: var(--ink-3);
}
</style>
