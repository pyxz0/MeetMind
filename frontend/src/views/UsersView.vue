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

/** 可授予的角色：不能高于自己 */
const grantableRoles = computed<Role[]>(() => {
  const role = currentUser.value?.role ?? 'USER'

  if (role === 'SUPER_ADMIN') return ['USER', 'ADMIN', 'SUPER_ADMIN']
  if (role === 'ADMIN') return ['USER', 'ADMIN']
  return []
})

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
  email: '',
  password: '',
  name: '',
  role: 'USER' as Role
})

const openCreate = () => {
  form.email = ''
  form.password = ''
  form.name = ''
  form.role = 'USER'
  dialogVisible.value = true
}

const submitCreate = async () => {
  if (!form.email.trim() || !form.password || !form.name.trim()) {
    ElMessage.warning('请填写完整信息')
    return
  }

  submitting.value = true

  try {
    await createUser({
      email: form.email.trim(),
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
      `确定删除账号「${user.name}（${user.email}）」吗？该用户名下的会议也会一并删除，且无法恢复。`,
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

onMounted(loadUsers)
</script>

<template>
  <div class="users-page">
    <div class="page-container">
      <div class="page-header">
        <div>
          <h1>用户管理</h1>
          <p>管理账号与角色分级，权限收回会立即生效</p>
        </div>

        <div class="header-actions">
          <el-input v-model="keyword" placeholder="搜索邮箱或姓名" clearable style="width: 200px"
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

          <el-table-column prop="email" label="邮箱" min-width="200" />

          <el-table-column label="角色" width="170">
            <template #default="{ row }">
              <el-select v-if="canManage(row)" :model-value="row.role" size="small" :loading="changingRoleId === row.id"
                @change="(role: Role) => changeRole(row, role)">
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
              <template v-if="canManage(row)">
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

          <el-form-item label="邮箱">
            <el-input v-model="form.email" maxlength="160" />
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
</style>
