<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { authStore, type TenantRole } from '../stores/auth'
import {
  createInvite,
  listInvites,
  listTenantMembers,
  removeTenantMember,
  revokeInvite,
  type CreatedInvite,
  type InviteRecord,
  type TenantMember,
} from '../api/tenants'

/**
 * 成员管理。
 *
 * 和「用户管理」(/users) 是两件事，故意分开：
 * - 用户管理：管**账号**（建号、改密码、停用、代登）
 * - 成员管理：管**谁在这个空间里**（角色、移出）
 *
 * 混在一张表格里，用户分不清「删除」是删账号还是移出企业 —— 那是不可逆的误操作。
 */

const currentUser = computed(() => authStore.user)
const tenantId = computed(() => authStore.user?.activeTenantId ?? '')

/** 只有 OWNER / ADMIN 能看这份列表 */
const canManage = computed(() => {
  const role = currentUser.value?.tenantRole

  return role === 'OWNER' || role === 'ADMIN'
})

const isOwner = computed(() => currentUser.value?.tenantRole === 'OWNER')

const members = ref<TenantMember[]>([])
const loading = ref(false)
const removing = ref<number | null>(null)

const ROLE_LABEL: Record<TenantRole, string> = {
  OWNER: '所有者',
  ADMIN: '管理员',
  MEMBER: '成员',
}

const ROLE_TAG: Record<TenantRole, 'info' | 'warning' | 'success'> = {
  OWNER: 'warning',
  ADMIN: 'success',
  MEMBER: 'info',
}

const isSelf = (member: TenantMember) => member.id === currentUser.value?.id

/**
 * 能不能移出这个人。
 *
 * 三条规则与后端一致，前端提前隐藏按钮只是为了少一次点击：
 * 不能移自己、不能移所有者、只有所有者能移管理员。
 */
const canRemove = (member: TenantMember) => {
  if (isSelf(member)) return false
  if (member.role === 'OWNER') return false
  if (member.role === 'ADMIN' && !isOwner.value) return false

  return true
}

const formatDate = (value?: string) => {
  if (!value) return '—'

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) return '—'

  const pad = (n: number) => String(n).padStart(2, '0')

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const load = async () => {
  if (!canManage.value || !tenantId.value) return

  loading.value = true

  try {
    members.value = await listTenantMembers(tenantId.value)
  } catch (error: unknown) {
    const anyError = error as { response?: { data?: { message?: string } } }

    ElMessage.error(anyError?.response?.data?.message ?? '成员列表加载失败')
    members.value = []
  } finally {
    loading.value = false
  }
}

const handleRemove = async (member: TenantMember) => {
  try {
    await ElMessageBox.confirm(
      `移出后，${member.name} 将无法再访问这个空间。他创建过的会议会留在企业里，不会跟着人走。`,
      `移出「${member.name}」`,
      {
        confirmButtonText: '移出',
        cancelButtonText: '取消',
        type: 'warning',
      },
    )
  } catch {
    return
  }

  removing.value = member.id

  try {
    await removeTenantMember(tenantId.value, member.id)

    ElMessage.success(`已把 ${member.name} 移出空间`)
    await load()
  } catch (error: unknown) {
    const anyError = error as { response?: { data?: { message?: string } } }

    ElMessage.error(anyError?.response?.data?.message ?? '移出失败，请重试')
  } finally {
    removing.value = null
  }
}

onMounted(load)

/* =========================
   邀请链接
   ========================= */

const inviteVisible = ref(false)
const inviteCreating = ref(false)
const createdInvite = ref<CreatedInvite | null>(null)

const inviteForm = reactive({
  role: 'MEMBER' as 'ADMIN' | 'MEMBER',
  phone: '',
  maxUses: 1,
})

const invites = ref<InviteRecord[]>([])
const revoking = ref<number | null>(null)

/** 邀请链接指向接受页；用当前 origin，本地和线上都能直接用 */
const inviteLink = computed(() =>
  createdInvite.value
    ? `${window.location.origin}/join/${createdInvite.value.token}`
    : '',
)

const openInvite = () => {
  createdInvite.value = null
  inviteForm.role = 'MEMBER'
  inviteForm.phone = ''
  inviteForm.maxUses = 1
  inviteVisible.value = true
}

const submitInvite = async () => {
  inviteCreating.value = true

  try {
    createdInvite.value = await createInvite(tenantId.value, {
      role: inviteForm.role,
      phone: inviteForm.phone.trim() || undefined,
      maxUses: inviteForm.maxUses,
    })

    await loadInvites()
  } catch (error: unknown) {
    const anyError = error as { response?: { data?: { message?: string } } }

    ElMessage.error(anyError?.response?.data?.message ?? '生成邀请失败')
  } finally {
    inviteCreating.value = false
  }
}

const copyLink = async () => {
  try {
    await navigator.clipboard.writeText(inviteLink.value)
    ElMessage.success('链接已复制，发给对方即可')
  } catch {
    /** 非 https 或权限被拒时会失败，让用户手动选中 */
    ElMessage.warning('复制失败，请手动选中链接复制')
  }
}

const loadInvites = async () => {
  if (!canManage.value || !tenantId.value) return

  try {
    invites.value = await listInvites(tenantId.value)
  } catch {
    invites.value = []
  }
}

const handleRevoke = async (record: InviteRecord) => {
  try {
    await ElMessageBox.confirm(
      '撤销后这条链接立刻失效，已经加入的成员不受影响。',
      '撤销邀请',
      { confirmButtonText: '撤销', cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return
  }

  revoking.value = record.id

  try {
    await revokeInvite(tenantId.value, record.id)
    ElMessage.success('已撤销')
    await loadInvites()
  } catch (error: unknown) {
    const anyError = error as { response?: { data?: { message?: string } } }

    ElMessage.error(anyError?.response?.data?.message ?? '撤销失败')
  } finally {
    revoking.value = null
  }
}

const INVITE_STATUS: Record<InviteRecord['status'], string> = {
  ACTIVE: '可用',
  EXPIRED: '已过期',
  USED_UP: '已用完',
}

onMounted(async () => {
  await load()
  await loadInvites()
})
</script>

<template>
  <div class="page">
    <div class="page-narrow">
      <header class="page-head">
        <div>
          <h1>成员管理</h1>

          <p class="page-desc">
            管理谁可以访问这个空间。移出成员不会删除账号 ——
            对方仍能登录并使用自己的个人空间。
          </p>
        </div>
      </header>

      <div v-if="!canManage" class="notice">
        只有空间所有者与管理员可以管理成员。
      </div>

      <template v-else>
        <div class="toolbar">
          <span class="toolbar-text">
            共 <b>{{ members.length }}</b> 位成员
          </span>

          <div class="toolbar-actions">
            <el-button size="small" :loading="loading" @click="load">
              刷新
            </el-button>

            <el-button size="small" type="primary" @click="openInvite">
              邀请成员
            </el-button>
          </div>
        </div>

        <el-table :data="members" v-loading="loading" class="member-table">
          <el-table-column prop="name" label="姓名" min-width="140">
            <template #default="{ row }">
              <span class="name-cell">
                {{ row.name }}

                <em v-if="isSelf(row)" class="self-tag">我</em>
              </span>
            </template>
          </el-table-column>

          <el-table-column prop="phone" label="手机号" min-width="140" />

          <el-table-column label="角色" width="110">
            <template #default="{ row }">
              <el-tag size="small" :type="ROLE_TAG[row.role as TenantRole]">
                {{ ROLE_LABEL[row.role as TenantRole] }}
              </el-tag>
            </template>
          </el-table-column>

          <el-table-column label="加入时间" width="120">
            <template #default="{ row }">
              <span class="muted">{{ formatDate(row.joinedAt) }}</span>
            </template>
          </el-table-column>

          <el-table-column label="账号状态" width="100">
            <template #default="{ row }">
              <span :class="row.isActive ? 'state-on' : 'state-off'">
                {{ row.isActive ? '正常' : '已停用' }}
              </span>
            </template>
          </el-table-column>

          <el-table-column label="操作" width="110" align="right">
            <template #default="{ row }">
              <el-button
                v-if="canRemove(row)"
                size="small"
                type="danger"
                link
                :loading="removing === row.id"
                @click="handleRemove(row)"
              >
                移出
              </el-button>

              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
        </el-table>

        <section v-if="invites.length" class="invite-block">
          <h2 class="block-title">已发出的邀请</h2>

          <ul class="invite-list">
            <li v-for="item in invites" :key="item.id" class="invite-item">
              <span class="invite-main">
                {{ item.phone || '不限手机号' }} · {{ ROLE_LABEL[item.role] }}
              </span>

              <span class="invite-sub">
                {{ item.usedCount }}/{{ item.maxUses }} 次 · 至
                {{ formatDate(item.expiresAt) }}
              </span>

              <el-tag
                size="small"
                :type="item.status === 'ACTIVE' ? 'success' : 'info'"
              >
                {{ INVITE_STATUS[item.status] }}
              </el-tag>

              <el-button
                v-if="item.status === 'ACTIVE'"
                size="small"
                link
                type="danger"
                :loading="revoking === item.id"
                @click="handleRevoke(item)"
              >
                撤销
              </el-button>
            </li>
          </ul>
        </section>

        <p class="hint">
          也可以点「邀请成员」生成链接发给对方 —— 对方打开链接注册或登录后，
          会自动加入本企业并切到本企业空间。
        </p>
      </template>
    </div>

    <!-- 邀请弹窗 -->
    <el-dialog v-model="inviteVisible" title="邀请成员" width="470px">
      <template v-if="!createdInvite">
        <el-form label-position="top">
          <el-form-item label="加入后的角色">
            <el-select v-model="inviteForm.role" style="width: 100%">
              <el-option label="成员（只能看自己相关的内容）" value="MEMBER" />
              <el-option
                v-if="isOwner"
                label="管理员（可查看企业全部会议、管理成员）"
                value="ADMIN"
              />
            </el-select>
          </el-form-item>

          <el-form-item label="限定手机号（可选）">
            <el-input
              v-model="inviteForm.phone"
              maxlength="20"
              placeholder="留空表示拿到链接的人都能用"
            />
          </el-form-item>

          <el-form-item label="可用次数">
            <el-input-number v-model="inviteForm.maxUses" :min="1" :max="50" />
            <span class="field-hint">1 表示一人一链，转发出去也不会被第二个人用掉</span>
          </el-form-item>
        </el-form>
      </template>

      <template v-else>
        <p class="invite-tip">
          链接<strong>只显示这一次</strong>，库里只存哈希。请现在复制发给对方，
          关闭后想再要只能重新生成。
        </p>

        <el-input :model-value="inviteLink" readonly />

        <p class="invite-meta-line">
          有效期至 {{ formatDate(createdInvite.expiresAt) }} ·
          可用 {{ createdInvite.maxUses }} 次
          <template v-if="createdInvite.phone">
            · 仅限 {{ createdInvite.phone }}
          </template>
        </p>
      </template>

      <template #footer>
        <template v-if="!createdInvite">
          <el-button @click="inviteVisible = false">取消</el-button>
          <el-button type="primary" :loading="inviteCreating" @click="submitInvite">
            生成链接
          </el-button>
        </template>

        <template v-else>
          <el-button @click="inviteVisible = false">关闭</el-button>
          <el-button type="primary" @click="copyLink">复制链接</el-button>
        </template>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;

  margin-bottom: 12px;
}

.toolbar-actions {
  display: flex;
  gap: 8px;
}

.toolbar-text {
  font-size: 13px;
  color: var(--ink-3);
}

.toolbar-text b {
  color: var(--ink);
}

.member-table {
  border: 1px solid var(--rule-soft);
  border-radius: 8px;
}

.name-cell {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.self-tag {
  padding: 0 5px;

  font-size: 10px;
  font-style: normal;
  color: var(--brand-deep);

  background: var(--brand-wash);
  border-radius: 3px;
}

.muted {
  color: var(--ink-3);
}

.state-on {
  color: #2f9e5e;
}

.state-off {
  color: var(--ink-3);
}

.hint {
  margin-top: 14px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--ink-3);
}

/* ---------- 邀请 ---------- */

.invite-block {
  margin-top: 20px;
}

.block-title {
  margin: 0 0 8px;

  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
}

.invite-list {
  margin: 0;
  padding: 0;
  list-style: none;

  border: 1px solid var(--rule-soft);
  border-radius: 8px;
  overflow: hidden;
}

.invite-item {
  display: flex;
  align-items: center;
  gap: 10px;

  padding: 9px 12px;

  font-size: 12px;

  border-top: 1px solid var(--rule-soft);
}

.invite-item:first-child {
  border-top: none;
}

.invite-main {
  color: var(--ink);
}

.invite-sub {
  flex: 1;
  color: var(--ink-3);
}

.field-hint {
  margin-left: 8px;
  font-size: 11px;
  color: var(--ink-3);
}

.invite-tip {
  margin: 0 0 10px;

  font-size: 13px;
  line-height: 1.7;
  color: var(--ink-2);
}

.invite-meta-line {
  margin: 8px 0 0;

  font-size: 12px;
  color: var(--ink-3);
}

.notice {
  padding: 16px 18px;

  font-size: 13px;
  color: var(--ink-3);

  background: var(--paper-2);
  border: 1px solid var(--rule-soft);
  border-radius: 8px;
}
</style>
