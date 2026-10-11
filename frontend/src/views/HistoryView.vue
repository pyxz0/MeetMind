<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Search } from '@element-plus/icons-vue'

import {
  getMeetings,
  deleteMeeting,
  type MeetingRecord
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
    const timeA = new Date(a.createdAt || 0).getTime()
    const timeB = new Date(b.createdAt || 0).getTime()

    return sortOrder.value === 'newest'
      ? timeB - timeA
      : timeA - timeB
  })
})

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

/** 查看会议详情 */
const handleView = (id: number) => {
  router.push(`/history/${id}`)
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

/** 获取会议完成状态标签类型 */
const getCompletionStatusType = (
  status?: MeetingRecord['completionStatus']
) => {
  switch (status) {
    case 'COMPLETED':
      return 'success'
    case 'IN_PROGRESS':
      return 'warning'
    case 'CANCELLED':
      return 'danger'
    case 'NOT_STARTED':
    default:
      return 'info'
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

          <el-select v-model="selectedStatus" placeholder="会议状态" clearable style="width: 140px">
            <el-option label="全部状态" value="" />
            <el-option label="未开始" value="NOT_STARTED" />
            <el-option label="进行中" value="IN_PROGRESS" />
            <el-option label="已完成" value="COMPLETED" />
            <el-option label="已取消" value="CANCELLED" />
          </el-select>

          <el-select v-model="sortOrder" placeholder="排序方式" style="width: 140px">
            <el-option label="最新创建" value="newest" />
            <el-option label="最早创建" value="oldest" />
          </el-select>

          <el-button
            @click="searchKeyword = ''; startDate = ''; endDate = ''; selectedStatus = ''; sortOrder = 'newest'">
            重置筛选
          </el-button>

          <span class="search-count">
            共找到 {{ filteredMeetings.length }} 条会议记录
          </span>
        </div>

        <el-empty v-if="!loading && meetings.length === 0" description="暂时没有会议记录" />

        <el-empty v-else-if="!loading && filteredMeetings.length === 0" description="没有找到匹配的会议记录" />

        <div v-else class="meeting-list">
          <el-card v-for="meeting in filteredMeetings" :key="meeting.id" class="meeting-card" shadow="hover">
            <div class="meeting-header">
              <div>
                <h2>
                  {{ meeting.title || `会议 #${meeting.id}` }}
                </h2>

                <span class="meeting-time">
                  {{ formatDate(meeting.createdAt) }}
                </span>
              </div>

              <el-tag :type="getCompletionStatusType(meeting.completionStatus)">
                {{ getCompletionStatusText(meeting.completionStatus) }}
              </el-tag>
            </div>

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

              <el-button type="danger" plain @click="handleDelete(meeting.id)">
                删除
              </el-button>
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