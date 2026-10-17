<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  listShares,
  shareMeeting,
  revokeShare,
  listUsers,
  type MeetingShare,
  type SharePermission,
  type ManagedUser
} from '../api/auth'
import { authStore } from '../stores/auth'

const props = defineProps<{
  modelValue: boolean
  meetingId: number
  meetingTitle: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
})

const shares = ref<MeetingShare[]>([])
const loading = ref(false)
const submitting = ref(false)

/** 可选接收人（排除自己与已共享的人） */
const candidates = ref<ManagedUser[]>([])
const selectedUserId = ref<number | null>(null)
const permission = ref<SharePermission>('READ')

const currentUser = computed(() => authStore.user)

/** 只有管理员及以上才能拉取用户列表用于挑选接收人 */
const canPickUsers = computed(() => authStore.can('user:read'))

const loadShares = async () => {
  if (!props.meetingId) return

  loading.value = true

  try {
    shares.value = await listShares(props.meetingId)
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.message ?? '共享名单加载失败')
  } finally {
    loading.value = false
  }
}

const loadCandidates = async () => {
  if (!canPickUsers.value) return

  try {
    const users = await listUsers()

    const sharedIds = new Set(shares.value.map(s => s.userId))

    candidates.value = users.filter(
      u =>
        u.id !== currentUser.value?.id &&
        u.isActive &&
        !sharedIds.has(u.id)
    )
  } catch {
    // 普通用户没有 user:read，静默失败即可（只能手动输入 ID 的降级路径不需要）
    candidates.value = []
  }
}

const refreshAll = async () => {
  await loadShares()
  await loadCandidates()
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      selectedUserId.value = null
      permission.value = 'READ'
      refreshAll()
    }
  }
)

const handleShare = async () => {
  if (!selectedUserId.value) {
    ElMessage.warning('请选择要共享的用户')
    return
  }

  submitting.value = true

  try {
    await shareMeeting(props.meetingId, selectedUserId.value, permission.value)

    ElMessage.success('共享成功')
    selectedUserId.value = null
    await refreshAll()
  } catch (error: any) {
    const message = error?.response?.data?.message ?? '共享失败'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  } finally {
    submitting.value = false
  }
}

/** 修改已有共享的权限 */
const changingUserId = ref<number | null>(null)

const changePermission = async (
  share: MeetingShare,
  next: SharePermission
) => {
  if (next === share.permission) return

  const previous = share.permission
  changingUserId.value = share.userId
  share.permission = next

  try {
    await shareMeeting(props.meetingId, share.userId, next)
    ElMessage.success('权限已更新')
  } catch (error: any) {
    share.permission = previous
    ElMessage.error(error?.response?.data?.message ?? '权限修改失败')
  } finally {
    changingUserId.value = null
  }
}

const handleRevoke = async (share: MeetingShare) => {
  try {
    await ElMessageBox.confirm(
      `确定取消「${share.name}」对该会议的访问权限吗？`,
      '撤销共享',
      {
        confirmButtonText: '确定撤销',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )
  } catch {
    return
  }

  try {
    await revokeShare(props.meetingId, share.userId)
    ElMessage.success('已撤销共享')
    await refreshAll()
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.message ?? '撤销失败')
  }
}
</script>

<template>
  <el-dialog v-model="visible" title="共享会议" width="560px">
    <div class="share-meeting">
      <span class="share-label">会议：</span>
      <span class="share-title">{{ meetingTitle }}</span>
    </div>

    <!-- 新增共享 -->
    <div v-if="canPickUsers" class="share-form">
      <el-select v-model="selectedUserId" placeholder="选择用户" filterable style="flex: 1" :disabled="submitting">
        <el-option v-for="user in candidates" :key="user.id" :label="`${user.name}（${user.email}）`"
          :value="user.id" />
      </el-select>

      <el-select v-model="permission" style="width: 110px" :disabled="submitting">
        <el-option label="只读" value="READ" />
        <el-option label="可编辑" value="EDIT" />
      </el-select>

      <el-button type="primary" :loading="submitting" :disabled="!selectedUserId" @click="handleShare">
        共享
      </el-button>
    </div>

    <el-alert v-else type="info" :closable="false" show-icon class="no-pick-tip"
      title="当前角色无法浏览用户列表" description="共享功能需要管理员及以上角色。你仍可查看下方已有的共享名单。" />

    <!-- 已共享名单 -->
    <div v-loading="loading" class="share-list">
      <el-empty v-if="!loading && shares.length === 0" description="该会议尚未共享给任何人" :image-size="70" />

      <div v-for="share in shares" :key="share.id" class="share-item">
        <div class="share-user">
          <span class="share-avatar">{{ share.name.slice(0, 1) }}</span>

          <div class="share-user-meta">
            <div class="share-user-name">{{ share.name }}</div>
            <div class="share-user-email">{{ share.email }}</div>
          </div>
        </div>

        <el-select :model-value="share.permission" size="small" style="width: 100px"
          :loading="changingUserId === share.userId"
          @change="(v: SharePermission) => changePermission(share, v)">
          <el-option label="只读" value="READ" />
          <el-option label="可编辑" value="EDIT" />
        </el-select>

        <el-button link type="danger" @click="handleRevoke(share)">
          撤销
        </el-button>
      </div>
    </div>

    <template #footer>
      <el-button @click="visible = false">关闭</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.share-meeting {
  margin-bottom: 16px;
  padding: 10px 12px;
  border-radius: 8px;
  background: #f5f7fa;
  font-size: 13px;
}

.share-label {
  color: #909399;
}

.share-title {
  color: #303133;
  font-weight: 600;
}

.share-form {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 18px;
}

.no-pick-tip {
  margin-bottom: 18px;
}

.share-list {
  min-height: 80px;
  max-height: 320px;
  overflow-y: auto;
}

.share-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 4px;
  border-bottom: 1px solid #f0f2f5;
}

.share-item:last-child {
  border-bottom: none;
}

.share-user {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
}

.share-avatar {
  width: 28px;
  height: 28px;
  flex-shrink: 0;

  display: flex;
  align-items: center;
  justify-content: center;

  border-radius: 50%;
  background: #ecf5ff;
  color: #409eff;
  font-size: 13px;
  font-weight: 600;
}

.share-user-meta {
  min-width: 0;
}

.share-user-name {
  color: #303133;
  font-size: 13px;
  font-weight: 600;
}

.share-user-email {
  color: #909399;
  font-size: 12px;

  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
