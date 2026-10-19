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
  addMeetingLeader,
  removeMeetingLeader,
  addMeetingMember,
  removeMeetingMember,
  updateMeetingAudioOpen,
  type MeetingRecord,
  type MemberBrief
} from '../api/meeting'
import { listContacts, type Contact } from '../api/auth'
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
const canEditTodos = computed(() => meeting.value?.canEditTodos === true)
const canManageMembers = computed(
  () => meeting.value?.canManageMembers === true
)
const canToggleAudio = computed(
  () => meeting.value?.canToggleAudio === true
)
const canListenAudio = computed(
  () => meeting.value?.canListenAudio === true
)
/** 有录音但当前用户无权听 */
const audioBlocked = computed(
  () => !!meeting.value?.hasAudio && !canListenAudio.value
)
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

/* =========================
   负责人 / 成员 / 录音开放
   ========================= */

/** 通讯录（用于选择负责人与成员） */
const contacts = ref<Contact[]>([])
const contactsLoading = ref(false)

const loadContacts = async () => {
  if (contacts.value.length) return

  contactsLoading.value = true

  try {
    contacts.value = await listContacts()
  } catch {
    contacts.value = []
  } finally {
    contactsLoading.value = false
  }
}

/** 负责人选择 */
const leaderAdding = ref(false)
const selectedLeaderId = ref<number | null>(null)

const handleAddLeader = async () => {
  if (!meeting.value || !selectedLeaderId.value) return

  leaderAdding.value = true

  try {
    const leaders = await addMeetingLeader(meeting.value.id, selectedLeaderId.value)

    meeting.value.leaders = leaders
    selectedLeaderId.value = null

    ElMessage.success('负责人已添加')
  } catch (error: any) {
    const message = error?.response?.data?.message ?? '添加负责人失败'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  } finally {
    leaderAdding.value = false
  }
}

const handleRemoveLeader = async (leader: MemberBrief) => {
  if (!meeting.value) return

  try {
    const leaders = await removeMeetingLeader(meeting.value.id, leader.id)

    meeting.value.leaders = leaders

    ElMessage.success('负责人已移除')
  } catch (error: any) {
    const message = error?.response?.data?.message ?? '移除负责人失败'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  }
}

/** 可添加为负责人的人：排除已是负责人的 */
const leaderCandidates = computed(() => {
  const existing = new Set((meeting.value?.leaders ?? []).map((l) => l.id))

  return contacts.value.filter((c) => !existing.has(c.id))
})

/** 成员选择与增删 */
const memberSelecting = ref(false)
const selectedMemberId = ref<number | null>(null)

const handleAddMember = async () => {
  if (!meeting.value || !selectedMemberId.value) return

  memberSelecting.value = true

  try {
    const members = await addMeetingMember(
      meeting.value.id,
      selectedMemberId.value
    )

    meeting.value.members = members
    selectedMemberId.value = null

    ElMessage.success('成员已添加')
  } catch (error: any) {
    const message = error?.response?.data?.message ?? '添加成员失败'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  } finally {
    memberSelecting.value = false
  }
}

const handleRemoveMember = async (member: MemberBrief) => {
  if (!meeting.value) return

  try {
    const members = await removeMeetingMember(meeting.value.id, member.id)

    meeting.value.members = members

    ElMessage.success('成员已移除')
  } catch (error: any) {
    const message = error?.response?.data?.message ?? '移除成员失败'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  }
}

/** 可添加为成员的人：排除已在成员里的 */
const memberCandidates = computed(() => {
  const existing = new Set((meeting.value?.members ?? []).map((m) => m.id))

  return contacts.value.filter((c) => !existing.has(c.id))
})

/** 录音开放开关 */
const audioOpenUpdating = ref(false)

const handleAudioOpenChange = async (value: boolean) => {
  if (!meeting.value) return

  audioOpenUpdating.value = true

  try {
    const result = await updateMeetingAudioOpen(meeting.value.id, value)

    /**
     * 开关变化会直接影响当前用户能否收听：
     * 非负责人关闭后自己也将听不到，需要用最新权限刷新页面数据。
     */
    const refreshed = await getMeeting(meeting.value.id)

    meeting.value = refreshed

    ElMessage.success(
      result.audioOpen ? '录音已对成员开放' : '录音已设为不开放'
    )
  } catch (error: any) {
    const message = error?.response?.data?.message ?? '录音开关更新失败'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  } finally {
    audioOpenUpdating.value = false
  }
}

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

onMounted(async () => {
  await loadMeeting()

  // 只有能管理成员时才需要通讯录，避免无权用户多打一次接口
  if (canManageMembers.value) {
    await loadContacts()
  }
})
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

      <!-- 负责人与成员 -->
      <el-card class="section-card members-card">
        <template #header>
          <div class="members-header">
            <h3>负责人与成员</h3>

            <span class="members-count">
              {{ (meeting.members?.length ?? 0) }} 名成员
            </span>
          </div>
        </template>

        <div class="member-row member-row--list">
          <span class="member-label">负责人</span>

          <div class="member-list">
            <span v-if="!meeting.leaders?.length" class="member-empty">暂无负责人</span>

            <span v-for="l in meeting.leaders" :key="l.id" class="member-chip member-chip--leader">
              <span class="chip-avatar">{{ l.name.slice(0, 1) }}</span>
              <span>{{ l.name }}</span>

              <el-button v-if="canManageMembers && (meeting.leaders?.length ?? 0) > 1" link type="danger" size="small"
                class="chip-remove" @click="handleRemoveLeader(l)">
                ×
              </el-button>
            </span>
          </div>
        </div>

        <div v-if="canManageMembers" class="member-add">
          <el-select v-model="selectedLeaderId" size="small" placeholder="添加负责人" filterable clearable
            style="width: 200px" :loading="contactsLoading" @focus="loadContacts">
            <el-option v-for="c in leaderCandidates" :key="c.id" :label="`${c.name}（${c.phone}）`" :value="c.id" />
          </el-select>

          <el-button type="primary" size="small" :loading="leaderAdding" :disabled="!selectedLeaderId"
            @click="handleAddLeader">
            添加负责人
          </el-button>
        </div>

        <div class="member-row member-row--list">
          <span class="member-label">成员</span>

          <div class="member-list">
            <span v-if="!meeting.members?.length" class="member-empty">暂无成员</span>

            <span v-for="m in meeting.members" :key="m.id" class="member-chip">
              <span class="chip-avatar">{{ m.name.slice(0, 1) }}</span>
              <span>{{ m.name }}</span>

              <el-button v-if="canManageMembers" link type="danger" size="small" class="chip-remove"
                @click="handleRemoveMember(m)">
                ×
              </el-button>
            </span>
          </div>
        </div>

        <div v-if="canManageMembers" class="member-add">
          <el-select v-model="selectedMemberId" size="small" placeholder="选择要添加的成员" filterable clearable
            style="width: 240px" :loading="contactsLoading" @focus="loadContacts">
            <el-option v-for="c in memberCandidates" :key="c.id" :label="`${c.name}（${c.phone}）`" :value="c.id" />
          </el-select>

          <el-button type="primary" size="small" :loading="memberSelecting" :disabled="!selectedMemberId"
            @click="handleAddMember">
            添加成员
          </el-button>
        </div>
      </el-card>

      <el-card class="section-card">
        <template #header>
          <h3>会议原始内容</h3>
        </template>

        <div class="content-text">
          {{ meeting.content || '暂无会议原文' }}
        </div>
      </el-card>

      <!-- 录音开关：只有负责人/创建者/超管能改 -->
      <el-card v-if="meeting.hasAudio || canToggleAudio" class="section-card audio-switch-card">
        <div class="audio-switch-row">
          <div class="audio-switch-main">
            <div class="audio-switch-title">录音开放</div>
            <div class="audio-switch-desc">
              关闭后仅负责人、会议创建者与超级管理员可以收听，成员与共享者听不到
            </div>
          </div>

          <el-switch v-if="canToggleAudio" :model-value="meeting.audioOpen" :loading="audioOpenUpdating"
            active-text="开放" inactive-text="不开放" @change="(v: boolean) => handleAudioOpenChange(v)" />

          <el-tag v-else :type="meeting.audioOpen ? 'success' : 'info'" size="small">
            {{ meeting.audioOpen ? '已开放' : '未开放' }}
          </el-tag>
        </div>
      </el-card>

      <!-- 录音放在原文旁边，方便边听边核对转写是否准确 -->
      <el-alert v-if="audioBlocked" class="audio-blocked-tip" type="info" :closable="false" show-icon
        title="该会议录音未对成员开放" description="如需收听，请联系会议负责人或创建者开启录音开放。" />

      <MeetingAudioPlayer v-else-if="canListenAudio" :audio-url="meeting.audioUrl"
        :duration-sec="meeting.audioDurationSec" />

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
              <!-- 成员可以勾选状态；只读共享者只能看到文字 -->
              <el-tag v-if="!canEditTodos" size="small">
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

/* ---- 负责人与成员 ---- */
.members-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.members-count {
  color: #909399;
  font-size: 13px;
  font-weight: 400;
}

.member-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
}

.member-row--list {
  align-items: flex-start;
}

.member-label {
  flex-shrink: 0;
  width: 56px;
  color: #909399;
  font-size: 13px;
}

.member-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
}

.member-empty {
  color: #c0c4cc;
  font-size: 13px;
}

.member-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;

  padding: 3px 10px 3px 4px;
  border-radius: 14px;
  background: #f5f7fa;

  color: #303133;
  font-size: 13px;
}

.member-chip--leader {
  background: #ecf5ff;
}

.chip-avatar {
  width: 20px;
  height: 20px;

  display: inline-flex;
  align-items: center;
  justify-content: center;

  border-radius: 50%;
  background: #ffffff;
  color: #409eff;

  font-size: 11px;
  font-weight: 600;
}

.chip-badge {
  padding: 0 5px;
  border-radius: 8px;
  background: #409eff;
  color: #ffffff;
  font-size: 10px;
  line-height: 14px;
}

.chip-remove {
  margin-left: 2px;
  padding: 0;
  font-size: 14px;
  line-height: 1;
}

.member-add {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  padding-top: 12px;
  border-top: 1px dashed #ebeef5;
}

/* ---- 录音开放 ---- */
.audio-switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.audio-switch-title {
  color: #303133;
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 4px;
}

.audio-switch-desc {
  color: #909399;
  font-size: 12px;
}

.audio-blocked-tip {
  margin-bottom: 16px;
  border-radius: 10px;
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