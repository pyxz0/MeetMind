<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { updateProfile } from '../api/auth'
import { authStore } from '../stores/auth'

const router = useRouter()

const user = computed(() => authStore.user)

/** 管理员及以上才有「用户管理」入口 */
const canManageUsers = computed(() => authStore.can('user:read'))

/** 审计日志入口：需要 audit:read（管理员及以上） */
const canViewAudit = computed(() => authStore.can('audit:read'))

/** 该账号是否就是系统唯一超管 */
const isSoleSuperAdmin = computed(
  () => user.value?.role === 'SUPER_ADMIN'
)

/** 头像用姓名首字，和左下角保持一致 */
const avatarText = computed(() => (user.value?.name ?? '?').slice(0, 1))

const formatDate = (value?: string) => {
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

/* =========================
   修改姓名
   ========================= */

const nameForm = reactive({
  name: user.value?.name ?? ''
})

const nameSaving = ref(false)

const saveName = async () => {
  const name = nameForm.name.trim()

  if (!name) {
    ElMessage.warning('姓名不能为空')
    return
  }

  if (name === user.value?.name) {
    ElMessage.info('姓名没有变化')
    return
  }

  nameSaving.value = true

  try {
    const updated = await updateProfile({ name })

    // 同步全局登录态，左下角用户名会立即跟着变
    authStore.setUser(updated)

    nameForm.name = updated.name

    ElMessage.success('姓名已更新')
  } catch (error: any) {
    const message = error?.response?.data?.message ?? '修改失败'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  } finally {
    nameSaving.value = false
  }
}

/* =========================
   修改密码
   ========================= */

const passwordForm = reactive({
  currentPassword: '',
  newPassword: '',
  confirmPassword: ''
})

const passwordSaving = ref(false)

const savePassword = async () => {
  if (!passwordForm.currentPassword) {
    ElMessage.warning('请输入原密码')
    return
  }

  if (passwordForm.newPassword.length < 8) {
    ElMessage.warning('新密码至少 8 位')
    return
  }

  if (
    !/[A-Za-z]/.test(passwordForm.newPassword) ||
    !/[0-9]/.test(passwordForm.newPassword)
  ) {
    ElMessage.warning('新密码需同时包含字母和数字')
    return
  }

  if (passwordForm.newPassword !== passwordForm.confirmPassword) {
    ElMessage.warning('两次输入的新密码不一致')
    return
  }

  if (passwordForm.newPassword === passwordForm.currentPassword) {
    ElMessage.warning('新密码不能与原密码相同')
    return
  }

  passwordSaving.value = true

  try {
    await updateProfile({
      currentPassword: passwordForm.currentPassword,
      newPassword: passwordForm.newPassword
    })

    passwordForm.currentPassword = ''
    passwordForm.newPassword = ''
    passwordForm.confirmPassword = ''

    ElMessage.success('密码已修改，下次登录请使用新密码')
  } catch (error: any) {
    const message = error?.response?.data?.message ?? '密码修改失败'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  } finally {
    passwordSaving.value = false
  }
}

/* =========================
   退出登录
   ========================= */

/**
 * 退出登录。
 *
 * 从侧边栏移到这里：与账号相关的操作集中在个人中心，
 * 同时也避免在导航区域误触退出。
 */
const handleLogout = async () => {
  try {
    await ElMessageBox.confirm('确定要退出登录吗？', '退出登录', {
      confirmButtonText: '退出',
      cancelButtonText: '取消',
      type: 'warning'
    })
  } catch {
    // 用户取消
    return
  }

  authStore.clear()
  await router.replace('/login')
}
</script>

<template>
  <div class="profile-page">
    <div class="page-container">
      <div class="page-header">
        <div>
          <h1>个人中心</h1>
          <p>管理自己的账号信息与登录密码</p>
        </div>
      </div>

      <el-card v-if="user" class="section-card" shadow="never">
        <template #header>
          <span>账号信息</span>
        </template>

        <div class="identity">
          <div class="identity-avatar">{{ avatarText }}</div>

          <div class="identity-main">
            <div class="identity-name">{{ user.name }}</div>

            <div class="identity-tags">
              <el-tag :type="isSoleSuperAdmin ? 'danger' : user.role === 'ADMIN' ? 'warning' : 'info'" size="small">
                {{ user.roleLabel }}
              </el-tag>

              <el-tag v-if="isSoleSuperAdmin" type="danger" effect="plain" size="small">
                系统唯一超管
              </el-tag>
            </div>
          </div>
        </div>

        <el-descriptions class="info-list" :column="1" border>
          <el-descriptions-item label="手机号">
            {{ user.phone }}
          </el-descriptions-item>

          <el-descriptions-item label="角色">
            {{ user.roleLabel }}
          </el-descriptions-item>

          <el-descriptions-item label="注册时间">
            {{ formatDate(user.createdAt) }}
          </el-descriptions-item>
        </el-descriptions>

        <el-alert class="phone-tip" type="info" :closable="false" show-icon
          title="手机号是登录账号，需由管理员修改" description="为避免误操作把自己锁在系统外，手机号不支持自助修改。" />
      </el-card>

      <el-card class="section-card" shadow="never">
        <template #header>
          <span>修改姓名</span>
        </template>

        <div class="form-row">
          <el-input v-model="nameForm.name" maxlength="80" placeholder="请输入姓名" style="max-width: 280px"
            @keyup.enter="saveName" />

          <el-button type="primary" :loading="nameSaving" @click="saveName">
            保存
          </el-button>
        </div>
      </el-card>

      <el-card class="section-card" shadow="never">
        <template #header>
          <span>修改密码</span>
        </template>

        <el-form label-width="90px" class="password-form">
          <el-form-item label="原密码">
            <el-input v-model="passwordForm.currentPassword" type="password" show-password maxlength="72"
              autocomplete="current-password" placeholder="请输入当前密码" />
          </el-form-item>

          <el-form-item label="新密码">
            <el-input v-model="passwordForm.newPassword" type="password" show-password maxlength="72"
              autocomplete="new-password" placeholder="至少 8 位，需含字母和数字" />
          </el-form-item>

          <el-form-item label="确认新密码">
            <el-input v-model="passwordForm.confirmPassword" type="password" show-password maxlength="72"
              autocomplete="new-password" placeholder="再次输入新密码" />
          </el-form-item>

          <el-form-item>
            <el-button type="primary" :loading="passwordSaving" @click="savePassword">
              修改密码
            </el-button>
          </el-form-item>
        </el-form>
      </el-card>

      <!-- 管理员入口：不再占用侧边栏导航 -->
      <el-card v-if="canManageUsers" class="section-card" shadow="never">
        <template #header>
          <span>管理</span>
        </template>

        <div class="manage-row">
          <div class="manage-main">
            <div class="manage-title">用户管理</div>
            <div class="manage-desc">
              查看全部账号、分配角色、启用停用与删除账号
            </div>
          </div>

          <el-button type="primary" plain @click="router.push('/users')">
            进入用户管理
          </el-button>
        </div>

        <div v-if="canViewAudit" class="manage-row manage-row--divided">
          <div class="manage-main">
            <div class="manage-title">审计日志</div>
            <div class="manage-desc">
              登录、账号变更、会议删除、共享与切换身份的操作留痕
            </div>
          </div>

          <el-button type="primary" plain @click="router.push('/audit')">
            查看审计日志
          </el-button>
        </div>
      </el-card>

      <!-- 退出登录放在个人中心，与账号相关操作集中在一起 -->
      <el-card class="section-card logout-card" shadow="never">
        <div class="manage-row">
          <div class="manage-main">
            <div class="manage-title">退出登录</div>
            <div class="manage-desc">
              退出后需要重新输入手机号与密码才能继续使用
            </div>
          </div>

          <el-button type="danger" plain @click="handleLogout">
            退出登录
          </el-button>
        </div>
      </el-card>
    </div>
  </div>
</template>

<style scoped>
.profile-page {
  min-height: 100%;
  background: #f5f7fa;
  padding: 40px 20px 60px;
}

.page-container {
  max-width: 900px;
  margin: 0 auto;
}

.page-header {
  margin-bottom: 22px;
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

.section-card {
  border-radius: 12px;
  margin-bottom: 18px;
}

.identity {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 20px;
}

.identity-avatar {
  width: 56px;
  height: 56px;
  flex-shrink: 0;

  display: flex;
  align-items: center;
  justify-content: center;

  border-radius: 50%;
  background: #ecf5ff;
  color: #409eff;

  font-size: 24px;
  font-weight: 600;
}

.identity-name {
  margin-bottom: 8px;
  color: #303133;
  font-size: 18px;
  font-weight: 600;
}

.identity-tags {
  display: flex;
  align-items: center;
  gap: 8px;
}

.info-list {
  margin-bottom: 16px;
}

.phone-tip {
  border-radius: 8px;
}

.form-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.password-form {
  max-width: 420px;
}

.manage-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.manage-title {
  color: #303133;
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 4px;
}

.manage-desc {
  color: #909399;
  font-size: 13px;
}

/* 同一张卡片里的第二个入口，用细分隔线区分 */
.manage-row--divided {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid #f5f7fa;
}

/* 退出登录是破坏性操作，用克制一点的边框区分 */
.logout-card {
  border-color: #fbc4c4;
}

@media (max-width: 768px) {
  .profile-page {
    padding: 24px 12px 40px;
  }

  .page-header h1 {
    font-size: 24px;
  }

  .form-row {
    flex-direction: column;
    align-items: stretch;
  }

  .manage-row {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
