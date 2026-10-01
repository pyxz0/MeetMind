<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  getMeetings,
  deleteMeeting,
  type MeetingRecord
} from '../api/meeting'

// 列表数据由历史 API 加载；loading 同时控制骨架遮罩和按钮状态。
const meetings = ref<MeetingRecord[]>([])

const loading = ref(false)

/** 请求历史会议列表，并在失败时提示用户检查数据服务。 */
const loadMeetings = async () => {
  loading.value = true

  try {
    meetings.value = await getMeetings()
  } catch (error) {
    console.error(error)

    ElMessage.error(
      '历史记录加载失败，请检查后端服务是否启动'
    )
  } finally {
    loading.value = false
  }
}

/** 删除前弹出二次确认；成功后重新加载列表保持界面与数据库一致。 */
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
    if (error !== 'cancel') {
      console.error(error)

      ElMessage.error('删除失败')
    }
  }
}

/** 将后端 ISO 时间转换为本地中文格式；无效时间原样显示便于排查。 */
const formatDate = (date: string) => {
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

// 进入历史页时自动加载最新记录。
onMounted(() => {
  loadMeetings()
})
</script>

<template>
  <div class="history-page">
    <div class="page-container">

      <!-- 标题 -->
      <div class="page-header">
        <div>
          <h1>历史会议</h1>

          <p>
            查看之前生成的会议纪要
          </p>
        </div>

        <el-button
          :loading="loading"
          @click="loadMeetings"
        >
          刷新
        </el-button>
      </div>

      <!-- 加载 -->
      <div
        v-loading="loading"
        class="history-container"
      >

        <!-- 空状态 -->
        <el-empty
          v-if="!loading && meetings.length === 0"
          description="暂时没有会议记录"
        />

        <!-- 会议列表 -->
        <div
          v-else
          class="meeting-list"
        >
          <el-card
            v-for="meeting in meetings"
            :key="meeting.id"
            class="meeting-card"
            shadow="hover"
          >
            <div class="meeting-header">
              <div>
                <h2>
                  会议 #{{ meeting.id }}
                </h2>

                <span class="meeting-time">
                  {{ formatDate(meeting.created_at) }}
                </span>
              </div>

              <el-button
                type="danger"
                plain
                size="small"
                @click="handleDelete(meeting.id)"
              >
                删除
              </el-button>
            </div>

            <div class="summary">
              <div class="label">
                📝 会议摘要
              </div>

              <p>
                {{ meeting.summary }}
              </p>
            </div>

            <div
              v-if="meeting.decisions?.length"
              class="section"
            >
              <div class="label">
                🎯 会议决策
              </div>

              <ul>
                <li
                  v-for="(decision, index) in meeting.decisions"
                  :key="index"
                >
                  {{ decision }}
                </li>
              </ul>
            </div>

            <div
              v-if="meeting.todos?.length"
              class="section"
            >
              <div class="label">
                ✅ 待办事项
              </div>

              <div class="todo-tags">
                <el-tag
                  v-for="(todo, index) in meeting.todos"
                  :key="index"
                  size="small"
                >
                  {{ todo.content }}
                </el-tag>
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
  min-height: calc(100vh - 64px);
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

.meeting-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding-bottom: 18px;
  border-bottom: 1px solid #ebeef5;
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
}

.section ul {
  margin: 0;
  padding-left: 20px;
  color: #606266;
  line-height: 1.8;
}

.todo-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

@media (max-width: 768px) {
  .history-page {
    padding: 24px 12px 40px;
  }

  .page-header h1 {
    font-size: 24px;
  }
}
</style>
