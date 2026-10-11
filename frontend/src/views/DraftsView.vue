<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'

import {
  getDraftMeetings,
  deleteMeeting,
  regenerateMeeting,
  type MeetingRecord
} from '../api/meeting'

import { useDraftStore } from '../composables/draftStore'

const router = useRouter()
const draftStore = useDraftStore()

const drafts = ref<MeetingRecord[]>([])
const loading = ref(false)
const regeneratingId = ref<number | null>(null)

/** 加载草稿箱 */
const loadDrafts = async () => {
  loading.value = true

  try {
    drafts.value = await getDraftMeetings()

    // 与顶部徽标同步
    await draftStore.refresh()
  } catch (error) {
    console.error('草稿箱加载失败：', error)

    ElMessage.error(
      '草稿箱加载失败，请检查后端服务是否启动'
    )
  } finally {
    loading.value = false
  }
}

/** 查看草稿会议详情 */
const handleView = (id: number) => {
  router.push(`/history/${id}`)
}

/** 重新生成会议纪要 */
const handleRegenerate = async (
  meeting: MeetingRecord
) => {
  try {
    await ElMessageBox.confirm(
      '将根据当前保存的会议原文重新生成纪要，是否继续？',
      '重新生成确认',
      {
        confirmButtonText: '重新生成',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )

    regeneratingId.value = meeting.id

    const updatedMeeting = await regenerateMeeting(
      meeting.id
    )

    // 从草稿列表移除
    drafts.value = drafts.value.filter(
      item => item.id !== meeting.id
    )

    // 顶部徽标立即 -1
    draftStore.decrement()

    ElMessage.success(
      '会议纪要重新生成成功'
    )

    // 跳转到正常会议详情
    router.push(
      `/history/${updatedMeeting.id}`
    )
  } catch (error: any) {
    if (
      error !== 'cancel' &&
      error !== 'close'
    ) {
      console.error(
        '重新生成失败：',
        error
      )

      ElMessage.error(
        '重新生成失败，请稍后重试'
      )
    }
  } finally {
    regeneratingId.value = null
  }
}

/** 删除草稿 */
const handleDelete = async (
  id: number
) => {
  try {
    await ElMessageBox.confirm(
      '确定删除这条草稿吗？删除后无法恢复。',
      '删除确认',
      {
        confirmButtonText: '确定删除',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )

    await deleteMeeting(id)

    // 从当前列表移除
    drafts.value = drafts.value.filter(
      meeting => meeting.id !== id
    )

    // 顶部徽标立即 -1
    draftStore.decrement()

    ElMessage.success(
      '草稿删除成功'
    )
  } catch (error: any) {
    if (
      error !== 'cancel' &&
      error !== 'close'
    ) {
      console.error(
        '删除草稿失败：',
        error
      )

      ElMessage.error(
        '删除草稿失败'
      )
    }
  }
}

/** 格式化时间 */
const formatDate = (
  date?: string
) => {
  if (!date) {
    return '时间未知'
  }

  const value = new Date(date)

  if (Number.isNaN(value.getTime())) {
    return date
  }

  return value.toLocaleString(
    'zh-CN',
    {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }
  )
}

onMounted(loadDrafts)
</script>

<template>
  <div class="draft-page">
    <div class="page-container">

      <!-- 页面标题 -->
      <div class="page-header">
        <div>
          <h1>草稿箱</h1>

          <p>
            暂存未成功生成纪要的会议原文，可重新生成或删除
          </p>
        </div>

        <el-button :loading="loading" @click="loadDrafts">
          刷新
        </el-button>
      </div>

      <div v-loading="loading" class="draft-container">

        <!-- 空状态 -->
        <el-empty v-if="!loading && drafts.length === 0" description="草稿箱为空" />

        <!-- 草稿列表 -->
        <div v-else class="draft-list">
          <el-card v-for="meeting in drafts" :key="meeting.id" class="draft-card" shadow="hover">
            <div class="draft-header">
              <div class="draft-main">
                <h2>
                  {{ meeting.title || `会议 #${meeting.id}` }}
                </h2>

                <span class="draft-time">
                  {{ formatDate(meeting.createdAt) }}
                </span>
              </div>

              <el-tag type="warning">
                草稿
              </el-tag>
            </div>

            <div class="draft-content">
              <div class="label">
                📝 会议原文
              </div>

              <p>
                {{ meeting.content || '暂无会议原文' }}
              </p>
            </div>

            <div class="draft-tip">
              该会议原文已保存，可以重新生成 AI 会议纪要。
            </div>

            <div class="card-actions">
              <el-button @click="handleView(meeting.id)">
                查看详情
              </el-button>

              <el-button type="primary" :loading="regeneratingId === meeting.id
                " @click="
                  handleRegenerate(meeting)
                  ">
                重新生成纪要
              </el-button>

              <el-button type="danger" plain :disabled="regeneratingId === meeting.id
                " @click="
                  handleDelete(meeting.id)
                  ">
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
.draft-page {
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
  font-size: 14px;
}

.draft-container {
  min-height: 300px;
}

.draft-list {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.draft-card {
  border-radius: 12px;
  border: 1px solid #ebeef5;
}

.draft-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  padding-bottom: 18px;
  border-bottom: 1px solid #ebeef5;
}

.draft-main {
  min-width: 0;
}

.draft-main h2 {
  margin: 0 0 6px;
  font-size: 18px;
  color: #303133;
}

.draft-time {
  font-size: 13px;
  color: #909399;
}

.draft-content {
  margin-top: 18px;
}

.label {
  margin-bottom: 10px;
  font-size: 14px;
  font-weight: 600;
  color: #606266;
}

.draft-content p {
  margin: 0;
  max-height: 160px;
  overflow: hidden;
  line-height: 1.8;
  color: #606266;
  white-space: pre-wrap;
}

.draft-tip {
  margin-top: 14px;
  padding: 10px 12px;
  background: #fff8e6;
  border-radius: 8px;
  color: #9a6700;
  font-size: 13px;
}

.card-actions {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid #ebeef5;
}

@media (max-width: 600px) {
  .draft-page {
    padding: 24px 12px 40px;
  }

  .page-header {
    align-items: stretch;
    flex-direction: column;
    gap: 14px;
  }

  .page-header h1 {
    font-size: 24px;
  }

  .draft-header {
    flex-direction: column;
  }

  .card-actions {
    flex-direction: column;
  }

  .card-actions .el-button {
    width: 100%;
    margin-left: 0;
  }
}
</style>