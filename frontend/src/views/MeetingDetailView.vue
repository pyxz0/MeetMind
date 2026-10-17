<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  getMeeting,
  updateTodoStatus,
  createTodo,
  deleteTodo,
  updateTodo,
  updateMeeting,
  regenerateMeeting,
  updateMeetingCompletionStatus,
  type MeetingRecord
} from '../api/meeting'
import MeetingAudioPlayer from '../components/MeetingAudioPlayer.vue'
import MeetingShareDialog from '../components/MeetingShareDialog.vue'
const route = useRoute()
const router = useRouter()

const meeting = ref<MeetingRecord | null>(null)

/** 分享弹窗状态 */
const shareDialogVisible = ref(false)

/**
 * 权限判断集中在这里，模板只读这些计算属性。
 *
 * 后端已强制校验，前端隐藏按钮只为避免用户点了才收到 403。
 */
const canEdit = computed(() => meeting.value?.canEdit === true)
const canShare = computed(() => meeting.value?.canShare === true)
const isReadOnly = computed(
  () => !!meeting.value && meeting.value.canEdit === false
)

const todoDialogVisible = ref(false)
const todoSubmitting = ref(false)
const editTodoDialogVisible = ref(false)
const editTodoSubmitting = ref(false)

// 编辑会议标题
const editTitleDialogVisible = ref(false)
const editTitleSubmitting = ref(false)
const editTitle = ref('')

const editTodoForm = ref({
  id: 0,
  content: '',
  assignee: '',
  deadline: ''
})

const todoForm = ref({
  content: '',
  assignee: '',
  deadline: ''
})
const loading = ref(false)
const completionStatusUpdating = ref(false)
const regenerating = ref(false)

// 打开编辑标题弹窗
const openEditTitle = () => {
  editTitle.value = meeting.value?.title || ''
  editTitleDialogVisible.value = true
}

// 保存会议标题
const handleUpdateTitle = async () => {
  const title = editTitle.value.trim()

  if (!title) {
    ElMessage.warning('会议标题不能为空')
    return
  }

  editTitleSubmitting.value = true

  try {
    await updateMeeting(Number(route.params.id), { title })

    ElMessage.success('会议标题修改成功')
    editTitleDialogVisible.value = false

    await loadMeeting()
  } catch (error) {
    ElMessage.error('修改会议标题失败')
  } finally {
    editTitleSubmitting.value = false
  }
}

const loadMeeting = async () => {
  const id = Number(route.params.id)

  if (!Number.isInteger(id) || id <= 0) {
    ElMessage.error('会议编号无效')
    router.push('/history')
    return
  }

  loading.value = true

  try {
    meeting.value = await getMeeting(id)
  } catch (error) {
    console.error('会议详情加载失败：', error)
    ElMessage.error('会议详情加载失败，请检查后端服务')
  } finally {
    loading.value = false
  }
}

const formatDate = (date?: string) => {
  if (!date) return '暂无时间'

  const parsed = new Date(date)

  if (Number.isNaN(parsed.getTime())) return '时间格式异常'

  return parsed.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * 待办状态变化后，后端会按“全部完成 → 会议已完成”的规则同步会议状态。
 * 这里把同步结果立即写回本地，避免表头状态与待办列表不一致。
 */
const applyMeetingCompletionStatus = (
  status?: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED'
) => {
  if (!meeting.value || !status) {
    return
  }

  if (meeting.value.completionStatus === status) {
    return
  }

  meeting.value.completionStatus = status

  // 只在“自动变成已完成”时额外提示，避免每次操作都弹消息
  if (status === 'COMPLETED') {
    ElMessage.success('全部待办已完成，会议状态已自动置为「已完成」')
  }
}

/** 更新待办状态并保存到数据库 */
const handleTodoStatusChange = async (
  todo: any,
  status: 'OPEN' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED'
) => {
  if (!todo.id) {
    ElMessage.error('待办 ID 不存在')
    return
  }

  const previousStatus = todo.status

  try {
    const result = await updateTodoStatus(todo.id, status)

    todo.status = status

    applyMeetingCompletionStatus(result?.meetingCompletionStatus)

    ElMessage.success('待办状态更新成功')
  } catch (error) {
    todo.status = previousStatus

    console.error(error)
    ElMessage.error('状态更新失败，请重试')
  }
}

const handleCreateTodo = async () => {
  if (!meeting.value) return

  if (!todoForm.value.content.trim()) {
    ElMessage.warning('请输入待办内容')
    return
  }

  todoSubmitting.value = true

  try {
    await createTodo(meeting.value.id, {
      content: todoForm.value.content.trim(),
      assignee: todoForm.value.assignee.trim() || undefined,
      deadline: todoForm.value.deadline.trim() || undefined
    })

    ElMessage.success('待办新增成功')

    todoDialogVisible.value = false

    todoForm.value = {
      content: '',
      assignee: '',
      deadline: ''
    }

    await loadMeeting()
  } catch (error) {
    console.error(error)
    ElMessage.error('新增待办失败，请重试')
  } finally {
    todoSubmitting.value = false
  }
}

/** 打开编辑待办弹窗 */
const handleEditTodo = (todo: any) => {
  editTodoForm.value = {
    id: todo.id,
    content: todo.content || '',
    assignee: todo.assignee || '',
    deadline: todo.deadline || ''
  }

  editTodoDialogVisible.value = true
}

/** 提交待办编辑 */
const handleUpdateTodo = async () => {
  if (!editTodoForm.value.content.trim()) {
    ElMessage.warning('请输入待办内容')
    return
  }

  editTodoSubmitting.value = true

  try {
    await updateTodo(editTodoForm.value.id, {
      content: editTodoForm.value.content.trim(),
      assignee: editTodoForm.value.assignee,
      deadline: editTodoForm.value.deadline
    })

    ElMessage.success('待办修改成功')
    editTodoDialogVisible.value = false

    await loadMeeting()
  } catch (error) {
    console.error(error)
    ElMessage.error('修改失败，请重试')
  } finally {
    editTodoSubmitting.value = false
  }
}

const handleDeleteTodo = async (todo: any) => {
  if (!todo.id) {
    ElMessage.error('待办 ID 不存在')
    return
  }

  try {
    await ElMessageBox.confirm(
      `确定删除待办事项“${todo.content}”吗？`,
      '删除确认',
      {
        confirmButtonText: '确定删除',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )

    await deleteTodo(todo.id)

    ElMessage.success('待办删除成功')

    await loadMeeting()
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') {
      console.error(error)
      ElMessage.error('删除失败，请重试')
    }
  }
}

/** 重新生成当前会议的 AI 纪要 */
const handleRegenerate = async () => {
  if (!meeting.value) {
    return
  }

  try {
    await ElMessageBox.confirm(
      'AI 纪要生成失败，是否根据原始会议内容重新生成？',
      '重新生成确认',
      {
        confirmButtonText: '重新生成',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )

    regenerating.value = true

    const updatedMeeting = await regenerateMeeting(
      meeting.value.id
    )

    meeting.value = updatedMeeting

    ElMessage.success('会议纪要重新生成成功')
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') {
      console.error('重新生成失败：', error)
      ElMessage.error('重新生成失败，请稍后重试')
    }
  } finally {
    regenerating.value = false
  }
}

/** 手动修改会议完成状态 */
const handleCompletionStatusChange = async (
  status:
    | 'NOT_STARTED'
    | 'IN_PROGRESS'
    | 'COMPLETED'
    | 'CANCELLED'
) => {
  if (!meeting.value) {
    return
  }

  const previousStatus =
    meeting.value.completionStatus

  meeting.value.completionStatus = status
  completionStatusUpdating.value = true

  try {
    await updateMeetingCompletionStatus(
      meeting.value.id,
      status
    )

    ElMessage.success('会议状态更新成功')
  } catch (error) {
    console.error(
      '会议状态更新失败：',
      error
    )

    meeting.value.completionStatus =
      previousStatus

    ElMessage.error(
      '会议状态更新失败，请重试'
    )
  } finally {
    completionStatusUpdating.value = false
  }
}

const goBack = () => {
  router.push('/history')
}

onMounted(loadMeeting)
</script>

<template>
  <div class="detail-page" v-loading="loading">
    <div class="page-header">
      <el-button @click="goBack">
        ← 返回历史记录
      </el-button>

      <div class="header-title">
        <h2>会议详情</h2>
        <p>查看 AI 生成的完整会议纪要</p>
      </div>
    </div>

    <template v-if="meeting">
      <!-- 只读共享者会看到这条提示，避免误以为是页面故障 -->
      <el-alert v-if="isReadOnly" type="info" :closable="false" show-icon class="readonly-tip"
        title="你对该会议只有只读权限" description="由会议拥有者共享给你。如需修改，请联系拥有者调整权限。" />

      <el-card class="meeting-card">
        <template #header>
          <div class="meeting-header">
            <div class="title-actions">
              <h3>{{ meeting.title || `会议 #${meeting.id}` }}</h3>

              <el-button v-if="canEdit" type="primary" link @click="openEditTitle">
                编辑标题
              </el-button>

              <el-button v-if="canShare" type="primary" link @click="shareDialogVisible = true">
                共享
              </el-button>
            </div>

            <div class="status-actions">
              <span class="completion-label">
                会议状态
              </span>

              <!-- 只读用户只看不可改，用只读标签呈现 -->
              <el-tag v-if="!canEdit" size="small">
                {{
                  meeting.completionStatus === 'COMPLETED'
                    ? '已完成'
                    : meeting.completionStatus === 'IN_PROGRESS'
                      ? '进行中'
                      : meeting.completionStatus === 'CANCELLED'
                        ? '已取消'
                        : '未开始'
                }}
              </el-tag>

              <el-select v-else :model-value="meeting.completionStatus || 'NOT_STARTED'
                " :loading="completionStatusUpdating" size="small" style="width: 130px" @change="
      (status:
        | 'NOT_STARTED'
        | 'IN_PROGRESS'
        | 'COMPLETED'
        | 'CANCELLED') =>
        handleCompletionStatusChange(status)
    ">
                <el-option label="未开始" value="NOT_STARTED" />

                <el-option label="进行中" value="IN_PROGRESS" />

                <el-option label="已完成" value="COMPLETED" />

                <el-option label="已取消" value="CANCELLED" />
              </el-select>

              <el-button v-if="meeting.isDraft && canEdit" type="warning" :loading="regenerating"
                @click="handleRegenerate">
                重新生成纪要
              </el-button>
            </div>
          </div>
        </template>

        <div class="meta">
          <span>会议编号：{{ meeting.id }}</span>
          <span>创建时间：{{ formatDate(meeting.createdAt) }}</span>
          <span v-if="!meeting.isOwner" class="shared-tag">
            他人共享
          </span>
        </div>
      </el-card>

      <MeetingShareDialog v-if="meeting" v-model="shareDialogVisible" :meeting-id="meeting.id"
        :meeting-title="meeting.title || `会议 #${meeting.id}`" />

      <el-card class="section-card">
        <template #header>
          <h3>会议原始内容</h3>
        </template>

        <div class="content-text">
          {{ meeting.content || '暂无会议原文' }}
        </div>
      </el-card>

      <!-- 录音放在原文旁边，方便边听边核对转写是否准确 -->
      <MeetingAudioPlayer
        :audio-url="meeting.audioUrl"
        :duration-sec="meeting.audioDurationSec"
      />

      <el-card class="section-card">
        <template #header>
          <h3>AI 会议摘要</h3>
        </template>

        <div class="content-text">
          {{ meeting.summary || '暂无会议摘要' }}
        </div>
      </el-card>

      <el-card class="section-card">
        <template #header>
          <h3>会议决策</h3>
        </template>

        <el-empty v-if="!meeting.decisions?.length" description="暂无会议决策" />

        <div v-else class="decision-list">
          <div v-for="(decision, index) in meeting.decisions" :key="index" class="decision-item">
            <el-tag type="success">{{ index + 1 }}</el-tag>
            <span>
              {{ typeof decision === 'string' ? decision : (decision as any).content }}
            </span>
          </div>
        </div>
      </el-card>

      <el-card class="section-card">
        <div class="todo-header">
          <h3>待办事项</h3>

          <el-button v-if="canEdit" type="primary" @click="todoDialogVisible = true">
            新增待办
          </el-button>
        </div>

        <el-empty v-if="!meeting.todos?.length" description="暂无待办事项" />

        <el-table v-else :data="meeting.todos" stripe>
          <el-table-column prop="content" label="任务内容" min-width="180" />

          <el-table-column prop="assignee" label="负责人" width="120">
            <template #default="{ row }">
              {{ row.assignee || '未指定' }}
            </template>
          </el-table-column>

          <el-table-column prop="deadline" label="截止时间" min-width="140">
            <template #default="{ row }">
              {{ row.deadline || '未指定' }}
            </template>
          </el-table-column>

          <el-table-column prop="status" label="任务状态" width="160">
            <template #default="{ row }">
              <!-- 只读共享者看到状态文字，不能改 -->
              <el-tag v-if="!canEdit" size="small">
                {{
                  row.status === 'COMPLETED'
                    ? '已完成'
                    : row.status === 'IN_PROGRESS'
                      ? '进行中'
                      : row.status === 'CANCELLED'
                        ? '已取消'
                        : '待处理'
                }}
              </el-tag>

              <el-select v-else :model-value="row.status || 'OPEN'" size="small" style="width: 130px" @change="(status: 'OPEN' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED') =>
                handleTodoStatusChange(row, status)">
                <el-option label="待处理" value="OPEN" />
                <el-option label="进行中" value="IN_PROGRESS" />
                <el-option label="已完成" value="COMPLETED" />
                <el-option label="已取消" value="CANCELLED" />
              </el-select>
            </template>
          </el-table-column>

          <el-table-column v-if="canEdit" label="操作" width="150" align="center">
            <template #default="{ row }">
              <el-button type="primary" link @click="handleEditTodo(row)">
                编辑
              </el-button>

              <el-button type="danger" link @click="handleDeleteTodo(row)">
                删除
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-card>
    </template>

    <el-empty v-else-if="!loading" description="未找到会议记录">
      <el-button type="primary" @click="goBack">
        返回历史记录
      </el-button>
    </el-empty>
  </div>
  <el-dialog v-model="todoDialogVisible" title="新增待办事项" width="500px">
    <el-form :model="todoForm" label-width="80px">
      <el-form-item label="待办内容">
        <el-input v-model="todoForm.content" type="textarea" :rows="3" placeholder="请输入待办内容" />
      </el-form-item>

      <el-form-item label="负责人">
        <el-input v-model="todoForm.assignee" placeholder="请输入负责人" />
      </el-form-item>

      <el-form-item label="截止时间">
        <el-input v-model="todoForm.deadline" placeholder="例如：下周一" />
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="todoDialogVisible = false">
        取消
      </el-button>

      <el-button type="primary" :loading="todoSubmitting" @click="handleCreateTodo">
        确认新增
      </el-button>
    </template>
  </el-dialog>
  <!-- 编辑待办弹窗 -->
  <el-dialog v-model="editTodoDialogVisible" title="编辑待办事项" width="500px">
    <el-form :model="editTodoForm" label-width="80px">
      <el-form-item label="任务内容" required>
        <el-input v-model="editTodoForm.content" type="textarea" :rows="3" placeholder="请输入待办事项" />
      </el-form-item>

      <el-form-item label="负责人">
        <el-input v-model="editTodoForm.assignee" placeholder="请输入负责人" />
      </el-form-item>

      <el-form-item label="截止时间">
        <el-input v-model="editTodoForm.deadline" placeholder="例如：2026-10-05" />
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="editTodoDialogVisible = false">
        取消
      </el-button>

      <el-button type="primary" :loading="editTodoSubmitting" @click="handleUpdateTodo">
        保存修改
      </el-button>
    </template>
  </el-dialog>
  <!-- 编辑会议标题弹窗 -->
  <el-dialog v-model="editTitleDialogVisible" title="编辑会议标题" width="450px">
    <el-form label-width="90px">
      <el-form-item label="会议标题" required>
        <el-input v-model="editTitle" maxlength="200" show-word-limit placeholder="请输入会议标题"
          @keyup.enter="handleUpdateTitle" />
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="editTitleDialogVisible = false">
        取消
      </el-button>

      <el-button type="primary" :loading="editTitleSubmitting" @click="handleUpdateTitle">
        保存修改
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.detail-page {
  max-width: 1000px;
  margin: 0 auto;
  padding: 28px 24px 48px;
}

.page-header {
  margin-bottom: 24px;
}

.header-title {
  margin-top: 20px;
}

.header-title h2 {
  margin: 0;
  font-size: 25px;
  font-weight: 600;
}

.header-title p {
  margin: 8px 0 0;
  color: #909399;
  font-size: 14px;
}

.meeting-card,
.section-card {
  margin-bottom: 20px;
  border-radius: 12px;
}

.meeting-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.meeting-header h3,
.section-card h3 {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 20px;
  color: #909399;
  font-size: 13px;
}

.content-text {
  line-height: 1.9;
  white-space: pre-wrap;
  color: #606266;
  font-size: 14px;
}

/* 只读提示与「他人共享」标记 */
.readonly-tip {
  margin-bottom: 16px;
  border-radius: 10px;
}

.shared-tag {
  color: #e6a23c;
}

.decision-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.decision-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  line-height: 1.8;
  color: #606266;
}

@media (max-width: 600px) {
  .status-actions {
    flex-wrap: wrap;
  }

  .detail-page {
    padding: 18px 12px 32px;
  }

  .meta {
    flex-direction: column;
    gap: 8px;
  }
}

.status-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.completion-label {
  color: #909399;
  font-size: 13px;
}
</style>