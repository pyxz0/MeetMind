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
  <el-dialog v-model="visible" title="共享会议" width="min(560px, 92vw)">
    <!-- 这扇门开给哪份纪要 -->
    <p class="share-target">
      <span class="share-target-k">会议</span>

      <span class="share-target-v" :title="meetingTitle">{{ meetingTitle }}</span>
    </p>

    <!-- 添加成员：选人 + 选权限 -->
    <section class="share-sec">
      <div class="sec-h">
        <span class="sec-t">添加成员</span>
        <span class="sec-x">选人，再选只读或可编辑</span>
      </div>

      <div v-if="canPickUsers" class="share-form">
        <el-select v-model="selectedUserId" class="share-pick" placeholder="选择同事" filterable :disabled="submitting">
          <el-option v-for="user in candidates" :key="user.id" :label="`${user.name}（${user.phone}）`"
            :value="user.id" />
        </el-select>

        <el-select v-model="permission" class="share-perm" :disabled="submitting">
          <el-option label="只读" value="READ" />
          <el-option label="可编辑" value="EDIT" />
        </el-select>

        <el-button type="primary" :loading="submitting" :disabled="!selectedUserId" @click="handleShare">
          共享
        </el-button>
      </div>

      <p v-else class="share-note">
        当前角色看不到用户列表。共享需要管理员及以上角色；已有的名单仍可在下面查看。
      </p>
    </section>

    <!-- 已共享给谁：台账行 -->
    <section class="share-sec">
      <div class="sec-h">
        <span class="sec-t">已共享给</span>
        <span class="sec-x num">{{ shares.length }} 人</span>
      </div>

      <div v-loading="loading" class="share-list">
        <p v-if="!loading && shares.length === 0" class="share-empty">
          还没有共享给任何人。选一位同事，给他只读权限。
        </p>

        <div v-for="share in shares" :key="share.id" class="reg-row share-row">
          <span class="share-name">{{ share.name }}</span>

          <span class="share-phone num">{{ share.phone }}</span>

          <el-select :model-value="share.permission" size="small" class="share-perm share-perm-row"
            :loading="changingUserId === share.userId"
            @change="(v: SharePermission) => changePermission(share, v)">
            <el-option label="只读" value="READ" />
            <el-option label="可编辑" value="EDIT" />
          </el-select>

          <el-button link class="share-revoke" @click="handleRevoke(share)">
            撤销
          </el-button>
        </div>
      </div>
    </section>

    <template #footer>
      <el-button @click="visible = false">关闭</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
/* ---------- 会议 ---------- */
.share-target {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin: 0;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--rule);
}

.share-target-k {
  flex-shrink: 0;
  font-size: 10.5px;
  color: var(--ink-3);
  letter-spacing: 0.06em;
}

.share-target-v {
  min-width: 0;

  font-family: var(--song);
  font-size: 15px;
  font-weight: 700;
  line-height: 1.4;
  letter-spacing: 0.05em;
  color: var(--ink);

  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---------- 两节 ---------- */
.share-sec {
  margin-top: 20px;
}

.share-sec .sec-x {
  margin-left: auto;
}

/* ---------- 添加成员 ---------- */
.share-form {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}

.share-pick {
  flex: 1;
  min-width: 0;
}

.share-perm {
  flex-shrink: 0;
  width: 104px;
}

.share-note {
  margin: 12px 0 0;
  padding: 10px 12px;
  border-left: 2px solid var(--rule);
  background: var(--paper-2);

  font-size: 12.5px;
  line-height: 1.8;
  color: var(--ink-2);
}

/* ---------- 已共享给 ---------- */
.share-list {
  min-height: 56px;
  max-height: 300px;
  overflow-y: auto;
}

.share-empty {
  padding: 16px 0;
  font-size: 12.5px;
  line-height: 1.85;
  color: var(--ink-3);
}

.share-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 0;
}

.share-name {
  flex-shrink: 0;

  font-family: var(--song);
  font-size: 13.5px;
  letter-spacing: 0.04em;
  color: var(--ink);
}

.share-phone {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--ink-3);

  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.share-perm-row {
  width: 96px;
}

.share-revoke {
  flex-shrink: 0;
}

@media (max-width: 640px) {
  .share-form {
    flex-wrap: wrap;
  }

  .share-pick {
    flex: 1 1 100%;
  }

  .share-form .share-perm {
    width: 100%;
  }

  .share-form .el-button {
    width: 100%;
    margin-left: 0;
  }

  .share-row {
    flex-wrap: wrap;
    gap: 6px 12px;
  }
}
</style>
