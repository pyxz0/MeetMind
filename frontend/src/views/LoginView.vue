<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { login, register } from '../api/auth'
import { authStore } from '../stores/auth'

const router = useRouter()
const route = useRoute()

/** 当前是登录还是注册 */
const mode = ref<'login' | 'register'>('login')
const loading = ref(false)

const form = reactive({
  phone: '',
  password: '',
  name: ''
})

/** 中国大陆手机号：1 开头、第二位 3-9、共 11 位 */
const PHONE_PATTERN = /^1[3-9]\d{9}$/

/** 去掉空格、短横线等分隔符，后端也会做一次同样的归一化 */
const normalizePhone = (value: string) =>
  value.replace(/[\s\-()]/g, '').replace(/^\+?86/, '')

const switchMode = () => {
  mode.value = mode.value === 'login' ? 'register' : 'login'
}

const submit = async () => {
  const phone = normalizePhone(form.phone)

  if (!phone || !form.password) {
    ElMessage.warning('请填写手机号和密码')
    return
  }

  // 前端先校验一次，避免明显错误的号码白跑一趟请求
  if (!PHONE_PATTERN.test(phone)) {
    ElMessage.warning('手机号格式不正确，请填写 11 位中国大陆手机号')
    return
  }

  if (mode.value === 'register' && !form.name.trim()) {
    ElMessage.warning('请填写姓名')
    return
  }

  loading.value = true

  try {
    const result =
      mode.value === 'login'
        ? await login(phone, form.password)
        : await register({
          phone,
          password: form.password,
          name: form.name.trim()
        })

    authStore.setSession(result.token, result.user)

    ElMessage.success(
      mode.value === 'login' ? '登录成功' : '注册成功，已自动登录'
    )

    // 登录后回到最初想去的页面（被守卫拦下时记录在 query.redirect）
    const redirect = route.query.redirect

    await router.replace(
      typeof redirect === 'string' && redirect.startsWith('/')
        ? redirect
        : '/'
    )
  } catch (error: any) {
    const message =
      error?.response?.data?.message ?? '操作失败，请稍后重试'

    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="auth-page">
    <div class="auth-card">
      <div class="brand">
        <span class="brand-icon">🧠</span>
        <h1>MeetMind</h1>
        <p>AI 智能会议纪要</p>
      </div>

      <el-form class="auth-form" @submit.prevent="submit">
        <el-form-item v-if="mode === 'register'">
          <el-input v-model="form.name" size="large" placeholder="姓名" maxlength="80" />
        </el-form-item>

        <el-form-item>
          <el-input v-model="form.phone" size="large" placeholder="手机号" type="tel" inputmode="numeric"
            autocomplete="tel" maxlength="20" @keyup.enter="submit" />
        </el-form-item>

        <el-form-item>
          <el-input v-model="form.password" size="large" placeholder="密码（至少 8 位，需含字母和数字）" type="password"
            :autocomplete="mode === 'login' ? 'current-password' : 'new-password'" show-password maxlength="72"
            @keyup.enter="submit" />
        </el-form-item>

        <el-button class="submit-button" type="primary" size="large" :loading="loading" @click="submit">
          {{ mode === 'login' ? '登录' : '注册并登录' }}
        </el-button>
      </el-form>

      <div class="switch-row">
        <span v-if="mode === 'login'">
          还没有账号？
          <el-button link type="primary" @click="switchMode">注册一个</el-button>
        </span>

        <span v-else>
          已有账号？
          <el-button link type="primary" @click="switchMode">去登录</el-button>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.auth-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: linear-gradient(160deg, #eef4ff 0%, #f5f7fa 55%, #eaf6ef 100%);
}

.auth-card {
  width: 100%;
  max-width: 380px;
  padding: 36px 32px 28px;
  border-radius: 16px;
  background: #ffffff;
  border: 1px solid #ebeef5;
  box-shadow: 0 12px 32px rgba(31, 45, 61, 0.08);
}

.brand {
  text-align: center;
  margin-bottom: 26px;
}

.brand-icon {
  font-size: 34px;
}

.brand h1 {
  margin: 8px 0 4px;
  font-size: 22px;
  font-weight: 700;
  color: #303133;
}

.brand p {
  margin: 0;
  color: #909399;
  font-size: 13px;
}

.auth-form {
  margin-top: 4px;
}

.submit-button {
  width: 100%;
  margin-top: 4px;
}

.switch-row {
  margin-top: 18px;
  text-align: center;
  font-size: 13px;
  color: #909399;
}
</style>
