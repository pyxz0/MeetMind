<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  impersonateUser,
  type ManagedUser
} from '../api/auth'
import { authStore, type Role } from '../stores/auth'

const router = useRouter()

const users = ref<ManagedUser[]>([])
const loading = ref(false)
const keyword = ref('')

const currentUser = computed(() => authStore.user)

/**
 * 返回上一级：用户管理不占侧边栏导航，唯一入口是个人中心。
 *
 * 这里直接 push('/profile')，不用 router.back()——用户可能是
 * 从收藏、刷新或外链直接进来的，没有历史栈可退，back() 会原地不动。
 */
const goBackProfile = () => {
  void router.push('/profile')
}

/** 只有超级管理员能切换身份（后端同样只放行超管） */
const canImpersonate = computed(
  () => currentUser.value?.role === 'SUPER_ADMIN'
)

/** 当前会话是否已经是代登状态（代登会话不允许再切） */
const isImpersonating = computed(() => authStore.isImpersonating.value)

/** 当前用户能否管理某个目标账号：必须严格高于对方 */
const ROLE_RANK: Record<Role, number> = {
  USER: 1,
  ADMIN: 2,
  SUPER_ADMIN: 3
}

const canManage = (user: ManagedUser) =>
  ROLE_RANK[currentUser.value?.role ?? 'USER'] > ROLE_RANK[user.role]

/**
 * 可授予的角色。
 *
 * 超级管理员全局唯一，因此这个下拉永远不提供 SUPER_ADMIN ——
 * 连超管本人也不能再授予第二个人。后端同样会拒绝，这里只是
 * 不让用户点到注定失败的选项。
 */
const grantableRoles = computed<Role[]>(() => {
  const role = currentUser.value?.role ?? 'USER'

  if (role === 'SUPER_ADMIN') return ['USER', 'ADMIN']
  if (role === 'ADMIN') return ['USER', 'ADMIN']
  return []
})

/** 超管账号的角色不可被下拉修改，单独提示原因 */
const isSoleSuperAdmin = (user: ManagedUser) => user.role === 'SUPER_ADMIN'

/** 是否是当前登录账号自己 */
const isSelf = (user: ManagedUser) => user.id === currentUser.value?.id

const ROLE_LABEL: Record<Role, string> = {
  USER: '用户',
  ADMIN: '管理员',
  SUPER_ADMIN: '超级管理员'
}

const ROLE_TAG: Record<Role, 'info' | 'warning' | 'danger'> = {
  USER: 'info',
  ADMIN: 'warning',
  SUPER_ADMIN: 'danger'
}

/** 开户时间：列表里只到分钟 */
const formatDateTime = (value?: string) => {
  if (!value) return '—'

  const date = new Date(value)

  if (Number.isNaN(date.getTime())) return value

  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

const loadUsers = async () => {
  loading.value = true

  try {
    users.value = await listUsers({
      keyword: keyword.value.trim() || undefined
    })
  } catch (error: any) {
    ElMessage.error(
      error?.response?.data?.message ?? '用户列表加载失败'
    )
  } finally {
    loading.value = false
  }
}

/** ───── 新建账号 ───── */
const dialogVisible = ref(false)
const submitting = ref(false)

const form = reactive({
  phone: '',
  password: '',
  name: '',
  role: 'USER' as Role
})

const openCreate = () => {
  form.phone = ''
  form.password = ''
  form.name = ''
  form.role = 'USER'
  dialogVisible.value = true
}

const submitCreate = async () => {
  if (!form.phone.trim() || !form.password || !form.name.trim()) {
    ElMessage.warning('请填写完整信息')
    return
  }

  if (!/^1[3-9]\d{9}$/.test(form.phone.trim())) {
    ElMessage.warning('手机号格式不正确，请填写 11 位中国大陆手机号')
    return
  }

  submitting.value = true

  try {
    await createUser({
      phone: form.phone.trim(),
      password: form.password,
      name: form.name.trim(),
      role: form.role
    })

    ElMessage.success('账号已创建')
    dialogVisible.value = false
    await loadUsers()
  } catch (error: any) {
    const message = error?.response?.data?.message ?? '创建失败'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  } finally {
    submitting.value = false
  }
}

/** ───── 启用 / 停用 ───── */
const togglingId = ref<number | null>(null)

const toggleActive = async (user: ManagedUser) => {
  togglingId.value = user.id

  try {
    await updateUser(user.id, { isActive: !user.isActive })

    user.isActive = !user.isActive

    ElMessage.success(user.isActive ? '已启用' : '已停用')
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.message ?? '操作失败')
  } finally {
    togglingId.value = null
  }
}

/** ───── 修改角色 ───── */
const changingRoleId = ref<number | null>(null)

const changeRole = async (user: ManagedUser, role: Role) => {
  if (role === user.role) return

  const previous = user.role
  changingRoleId.value = user.id
  user.role = role

  try {
    await updateUser(user.id, { role })

    ElMessage.success('角色已更新')
  } catch (error: any) {
    user.role = previous
    ElMessage.error(
      error?.response?.data?.message ?? '角色修改失败'
    )
  } finally {
    changingRoleId.value = null
  }
}

/** ───── 切换身份（以该账号浏览） ───── */

/** 某个账号是否可以切换进去 */
const canImpersonateRow = (user: ManagedUser) =>
  canImpersonate.value &&
  !isImpersonating.value &&
  user.id !== currentUser.value?.id &&
  user.isActive &&
  user.role !== 'SUPER_ADMIN'

const impersonatingId = ref<number | null>(null)

const handleImpersonate = async (user: ManagedUser) => {
  try {
    await ElMessageBox.confirm(
      `将以「${user.name}（${user.phone}）」的身份浏览系统，看到的会议与操作权限都与该账号一致。页面顶部会显示提示条，可随时返回自己的账号。`,
      '切换身份',
      {
        confirmButtonText: '切换并进入',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )
  } catch {
    return
  }

  impersonatingId.value = user.id

  try {
    const result = await impersonateUser(user.id)

    authStore.startImpersonation(result.token, result.user)

    ElMessage.success(`已切换为「${result.user.name}」`)

    // 回到首页，用对方的视角重新加载数据
    await router.push('/')
  } catch (error: any) {
    const message = error?.response?.data?.message ?? '切换失败'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  } finally {
    impersonatingId.value = null
  }
}

/** ───── 删除 ───── */
const handleDelete = async (user: ManagedUser) => {
  try {
    await ElMessageBox.confirm(
      `确定删除账号「${user.name}（${user.phone}）」吗？该用户名下的会议也会一并删除，且无法恢复。`,
      '删除账号',
      {
        confirmButtonText: '确定删除',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )
  } catch {
    return
  }

  try {
    await deleteUser(user.id)

    ElMessage.success('账号已删除')
    await loadUsers()
  } catch (error: any) {
    ElMessage.error(error?.response?.data?.message ?? '删除失败')
  }
}

/** ───── 修改自己的密码 ───── */
const passwordDialogVisible = ref(false)
const passwordSubmitting = ref(false)

const passwordForm = reactive({
  password: '',
  confirm: ''
})

const openPasswordDialog = () => {
  passwordForm.password = ''
  passwordForm.confirm = ''
  passwordDialogVisible.value = true
}

const submitPassword = async () => {
  if (!currentUser.value) return

  if (passwordForm.password.length < 8) {
    ElMessage.warning('密码至少 8 位')
    return
  }

  if (passwordForm.password !== passwordForm.confirm) {
    ElMessage.warning('两次输入的密码不一致')
    return
  }

  passwordSubmitting.value = true

  try {
    await updateUser(currentUser.value.id, {
      password: passwordForm.password
    })

    ElMessage.success('密码已修改，请用新密码重新登录')
    passwordDialogVisible.value = false
  } catch (error: any) {
    const message = error?.response?.data?.message ?? '密码修改失败'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  } finally {
    passwordSubmitting.value = false
  }
}

onMounted(loadUsers)
</script>

<template>
  <div class="page">
    <div class="page-inner">
      <header class="page-head">
        <div>
          <h1>用户管理</h1>

          <p class="page-desc">
            按角色分级管理账号。超级管理员全局唯一，不可新建或移除。
          </p>
        </div>

        <div class="page-head-actions">
          <!-- 用户管理不占导航栏，入口在个人中心，这里提供原路返回 -->
          <el-button @click="goBackProfile">
            返回个人中心
          </el-button>

          <el-button v-if="grantableRoles.length" type="primary" @click="openCreate">
            新增用户
          </el-button>
        </div>
      </header>

      <!-- 检索条 -->
      <div class="filter-bar">
        <el-input v-model="keyword" class="f-search" placeholder="搜索手机号或姓名" clearable
          @keyup.enter="loadUsers" @clear="loadUsers" />

        <el-button :loading="loading" @click="loadUsers">
          查询
        </el-button>

        <span class="filter-count">
          共 {{ users.length }} 个账号
        </span>
      </div>

      <!-- 账号台账 -->
      <div class="sheet">
        <div class="table-scroll">
          <el-table v-if="loading || users.length" v-loading="loading" :data="users" class="users-table"
            style="width: 100%">
            <el-table-column label="姓名" min-width="150">
              <template #default="{ row }">
                <span class="user-cell">
                  <img v-if="row.avatar" :src="row.avatar" alt="" class="user-avatar" />
                  <span v-else class="user-initial">{{ (row.name || '?').slice(0, 1) }}</span>

                  <span class="user-name">{{ row.name }}</span>
                </span>
              </template>
            </el-table-column>

            <el-table-column label="手机号" min-width="150">
              <template #default="{ row }">
                <span class="num">{{ row.phone }}</span>
              </template>
            </el-table-column>

            <el-table-column label="角色" width="170">
              <template #default="{ row }">
                <!-- 唯一超管：角色固定，不提供修改入口 -->
                <el-tooltip v-if="isSoleSuperAdmin(row)" content="超级管理员全局唯一，角色不可修改" placement="top">
                  <el-tag :type="ROLE_TAG[row.role as Role]" size="small">
                    {{ ROLE_LABEL[row.role as Role] }}
                  </el-tag>
                </el-tooltip>

                <el-select v-else-if="canManage(row)" :model-value="row.role" size="small"
                  :loading="changingRoleId === row.id" @change="(role: Role) => changeRole(row, role)">
                  <el-option v-for="role in grantableRoles" :key="role" :label="ROLE_LABEL[role]" :value="role" />
                </el-select>

                <el-tag v-else :type="ROLE_TAG[row.role as Role]" size="small">
                  {{ ROLE_LABEL[row.role as Role] }}
                </el-tag>
              </template>
            </el-table-column>

            <el-table-column label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="row.isActive ? 'success' : 'info'" size="small">
                  {{ row.isActive ? '正常' : '已停用' }}
                </el-tag>
              </template>
            </el-table-column>

            <el-table-column label="创建时间" width="160">
              <template #default="{ row }">
                <span class="num">{{ formatDateTime(row.createdAt) }}</span>
              </template>
            </el-table-column>

            <el-table-column label="操作" width="300" fixed="right">
              <template #default="{ row }">
                <span class="ops">
                  <!-- 自己：只能改密码 -->
                  <template v-if="isSelf(row)">
                    <el-button link @click="openPasswordDialog">
                      修改密码
                    </el-button>

                    <span class="muted">当前账号</span>
                  </template>

                  <span v-else-if="isSoleSuperAdmin(row)" class="muted">系统唯一超管</span>

                  <template v-else>
                    <!-- 切换身份：超管专用，直接以该账号视角进入系统 -->
                    <el-button v-if="canImpersonateRow(row)" link :loading="impersonatingId === row.id"
                      @click="handleImpersonate(row)">
                      切换身份
                    </el-button>

                    <template v-if="canManage(row)">
                      <el-button link :loading="togglingId === row.id" @click="toggleActive(row)">
                        {{ row.isActive ? '停用' : '启用' }}
                      </el-button>

                      <el-button link class="act-del" @click="handleDelete(row)">
                        删除
                      </el-button>
                    </template>

                    <span v-else-if="!canImpersonateRow(row)" class="muted">无管理权限</span>
                  </template>
                </span>
              </template>
            </el-table-column>
          </el-table>

          <el-empty v-else description="没有匹配的账号" />
        </div>
      </div>

      <!-- 新增用户 -->
      <el-dialog v-model="dialogVisible" title="新增用户" width="420px">
        <el-form label-width="72px">
          <el-form-item label="姓名">
            <el-input v-model="form.name" maxlength="80" />
          </el-form-item>

          <el-form-item label="手机号">
            <el-input v-model="form.phone" maxlength="20" placeholder="11 位中国大陆手机号" />
          </el-form-item>

          <el-form-item label="密码">
            <el-input v-model="form.password" type="password" show-password maxlength="72"
              placeholder="至少 8 位，需含字母和数字" />
          </el-form-item>

          <el-form-item label="角色">
            <el-select v-model="form.role" style="width: 100%">
              <el-option v-for="role in grantableRoles" :key="role" :label="ROLE_LABEL[role]" :value="role" />
            </el-select>
          </el-form-item>
        </el-form>

        <template #footer>
          <el-button @click="dialogVisible = false">取消</el-button>
          <el-button type="primary" :loading="submitting" @click="submitCreate">
            创建
          </el-button>
        </template>
      </el-dialog>

      <!-- 修改自己的密码 -->
      <el-dialog v-model="passwordDialogVisible" title="修改密码" width="400px">
        <el-form label-width="90px">
          <el-form-item label="新密码">
            <el-input v-model="passwordForm.password" type="password" show-password maxlength="72"
              placeholder="至少 8 位，需含字母和数字" />
          </el-form-item>

          <el-form-item label="确认密码">
            <el-input v-model="passwordForm.confirm" type="password" show-password maxlength="72"
              placeholder="再次输入新密码" />
          </el-form-item>
        </el-form>

        <template #footer>
          <el-button @click="passwordDialogVisible = false">取消</el-button>
          <el-button type="primary" :loading="passwordSubmitting" @click="submitPassword">
            确认修改
          </el-button>
        </template>
      </el-dialog>
    </div>
  </div>
</template>

<style scoped>
/* 姓名列：头像（没有就用首字）+ 名字 */
.user-cell {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.user-avatar,
.user-initial {
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  object-fit: cover;
  display: flex;
  align-items: center;
  justify-content: center;

  border: 1px solid var(--rule);
  background: var(--paper-2);
  font-family: var(--song);
  font-size: 12px;
  color: var(--ink-2);
}

.user-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* ---------- 检索条 ---------- */
.filter-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 18px;
}

.f-search {
  width: 260px;
}

.filter-count {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--ink-3);
  white-space: nowrap;
}

/* ---------- 账号台账 ---------- */
.table-scroll {
  overflow-x: auto;
}

.ops {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

/* 链接按钮之间用 gap 排开，不再叠加默认的相邻外边距 */
.ops :deep(.el-button + .el-button) {
  margin-left: 0;
}

/* 删除是破坏性操作，用朱色标注 */
.ops .act-del {
  --el-button-text-color: var(--vermilion);
}

@media (max-width: 640px) {
  .page {
    padding: 22px 14px 48px;
  }

  .f-search {
    width: 100%;
  }

  .filter-count {
    margin-left: 0;
    width: 100%;
  }

  .table-scroll {
    overflow-x: auto;
  }

  .users-table {
    min-width: 860px;
  }
}
</style>
