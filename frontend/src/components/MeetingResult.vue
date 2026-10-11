<script setup lang="ts">
import type { MeetingResult } from '../api/meeting'

defineProps<{
  result: MeetingResult
}>()
</script>

<template>
  <div class="result-card">

    <!-- 会议总结 -->
    <el-card class="section">
      <template #header>
        <b>📌 会议总结</b>
      </template>

      <p class="summary">
        {{ result.summary }}
      </p>
    </el-card>

    <!-- 核心决策 -->
    <el-card class="section">
      <template #header>
        <b>🚀 核心决策</b>
      </template>

      <div
        v-if="result.decisions && result.decisions.length"
        class="decision-list"
      >
        <el-tag
  v-for="(item, index) in result.decisions"
  :key="index"
  class="tag"
  type="success"
>
  {{ typeof item === 'string' ? item : (item as any).content }}
</el-tag>
      </div>

      <el-empty
        v-else
        description="暂无明确决策"
      />
    </el-card>

    <!-- 待办事项 -->
    <el-card class="section">
      <template #header>
        <b>✅ 待办事项</b>
      </template>

      <el-table
        v-if="result.todos && result.todos.length"
        :data="result.todos"
        border
        stripe
      >
        <el-table-column
          prop="content"
          label="任务"
          min-width="220"
        />

        <el-table-column
          prop="assignee"
          label="负责人"
          width="120"
        />

        <el-table-column
          prop="deadline"
          label="截止时间"
          width="150"
        />

        <el-table-column
          prop="status"
          label="状态"
          width="110"
        >
          <template #default="{ row }">
            <el-tag
              :type="row.status === 'OPEN' ? 'warning' : 'success'"
            >
              {{ row.status === 'OPEN' ? '待处理' : row.status }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>

      <el-empty
        v-else
        description="暂无待办事项"
      />
    </el-card>

  </div>
</template>

<style scoped>
.result-card {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.section {
  border-radius: 12px;
}

.summary {
  margin: 0;
  line-height: 1.8;
  color: #606266;
}

.decision-list {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.tag {
  margin: 0;
}
</style>