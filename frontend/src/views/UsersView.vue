<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  type ManagedUser
} from '../api/auth'
import { authStore, type Role } from '../stores/auth'

const users = ref<ManagedUser[]>([])
const loading = ref(false)
const keyword = ref('')

const currentUser = computed(() => authStore.user)

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
  <div class="users-page">
    <div class="page-container">
      <div class="page-header">
        <div>
          <h1>用户管理</h1>
          <p>管理账号与角色分级；超级管理员全局唯一，不可新建、提升或移除</p>
        </div>

        <div class="header-actions">
          <el-input v-model="keyword" placeholder="搜索手机号或姓名" clearable style="width: 200px"
            @keyup.enter="loadUsers" @clear="loadUsers" />

          <el-button :loading="loading" @click="loadUsers">
            查询
          </el-button>

          <el-button v-if="grantableRoles.length" type="primary" @click="openCreate">
            新建账号
          </el-button>
        </div>
      </div>

      <el-card shadow="never" class="table-card">
        <el-table v-loading="loading" :data="users" style="width: 100%">
          <el-table-column prop="name" label="姓名" min-width="120" />

          <el-table-column prop="phone" label="手机号" min-width="150" />

          <el-table-column label="角色" width="170">
            <template #default="{ row }">
              <!-- 唯一超管：角色固定，不提供修改入口 -->
              <el-tooltip v-if="isSoleSuperAdmin(row)" content="超级管理员全局唯一，角色不可修改" placement="top">
                <el-tag :type="ROLE_TAG[row.role as Role]">
                  {{ ROLE_LABEL[row.role as Role] }}
                </el-tag>
              </el-tooltip>

              <el-select v-else-if="canManage(row)" :model-value="row.role" size="small"
                :loading="changingRoleId === row.id" @change="(role: Role) => changeRole(row, role)">
                <el-option v-for="role in grantableRoles" :key="role" :label="ROLE_LABEL[role]" :value="role" />
              </el-select>

              <el-tag v-else :type="ROLE_TAG[row.role as Role]">
                {{ ROLE_LABEL[row.role as Role] }}
              </el-tag>
            </template>
          </el-table-column>

          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <el-tag :type="row.isActive ? 'success' : 'info'">
                {{ row.isActive ? '正常' : '已停用' }}
              </el-tag>
            </template>
          </el-table-column>

          <el-table-column label="操作" width="200" fixed="right">
            <template #default="{ row }">
              <!-- 自己：只能改密码 -->
              <span v-if="isSelf(row)" class="self-actions">
                <el-button link type="primary" @click="openPasswordDialog">
                  修改密码
                </el-button>

                <span class="no-permission">当前账号</span>
              </span>

              <span v-else-if="isSoleSuperAdmin(row)" class="no-permission">系统唯一超管</span>

              <template v-else-if="canManage(row)">
                <el-button link type="primary" :loading="togglingId === row.id" @click="toggleActive(row)">
                  {{ row.isActive ? '停用' : '启用' }}
                </el-button>

                <el-button link type="danger" @click="handleDelete(row)">
                  删除
                </el-button>
              </template>

              <span v-else class="no-permission">无管理权限</span>
            </template>
          </el-table-column>
        </el-table>

        <el-empty v-if="!loading && users.length === 0" description="没有匹配的账号" />
      </el-card>

      <!-- 新建账号 -->
      <el-dialog v-model="dialogVisible" title="新建账号" width="420px">
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
.users-page {
  min-height: 100%;
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
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 22px;
  flex-wrap: wrap;
}

.page-header h1 {
  margin: 0 0 6px;
  font-size: 30px;
  font-weight: 600;
  color: #303133;
}

.page-header p {
  margin: 0;
  color: #909399;
  font-size: 14px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.table-card {
  border-radius: 12px;
}

.no-permission {
  color: #c0c4cc;
  font-size: 13px;
}

.self-actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
</style>
