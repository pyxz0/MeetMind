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
    <div class="auth-sheet">
      <!-- 书口题字：竖排一行，登录页唯一的装饰 -->
      <aside class="auth-aside" aria-hidden="true">
        <p class="aside-motto">会议有痕　纪要成卷</p>
      </aside>

      <div class="auth-body">
        <header class="auth-head">
          <h1 class="auth-logo">
            <img src="/meetmind-logo.svg" alt="MeetMind" width="166" height="45" />
          </h1>

          <p>
            {{
              mode === 'login'
                ? '登录后继续记录你的会议'
                : '注册一个账号，开始记录会议'
            }}
          </p>
        </header>

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

        <p class="auth-foot">
          会议原文进，摘要、决策与待办出。纪要会留下文号与时间码。
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.auth-page {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 28px 20px;
  background: var(--desk);
}

.auth-sheet {
  position: relative;
  width: 100%;
  max-width: 720px;
  display: flex;
  align-items: stretch;

  background: var(--paper);
  border: 1px solid var(--rule);
}

/* 与侧栏同一条品牌线，登录页只在上沿留一道 */
.auth-sheet::before {
  content: '';
  position: absolute;
  left: -1px;
  right: -1px;
  top: -1px;
  height: 3px;
  background: var(--brand-stripe);
}

/* 书口题字 */
.auth-aside {
  width: 150px;
  flex-shrink: 0;
  display: flex;
  align-items: flex-start;
  justify-content: center;

  padding: 46px 0 36px;
  border-right: 1px solid var(--rule);
  background: var(--brand-wash);
}

.aside-motto {
  writing-mode: vertical-rl;
  font-family: var(--song);
  font-size: 15px;
  line-height: 2.4;
  letter-spacing: 0.34em;
  color: var(--ink);
}

.auth-body {
  flex: 1;
  min-width: 0;
  padding: 42px 46px 34px;
}

/* 品牌标识：登录页是唯一可以放大展示它地方 */
.auth-logo {
  margin: 0;
  line-height: 0;
}

.auth-logo img {
  display: block;
  height: 56px;
  width: auto;
}

.auth-head p {
  margin-top: 14px;
  font-size: 12.5px;
  color: var(--ink-3);
  letter-spacing: 0.02em;
}

.auth-form {
  margin-top: 28px;
}

.auth-form :deep(.el-form-item) {
  margin-bottom: 14px;
}

.submit-button {
  width: 100%;
  height: 40px;
  margin-top: 4px;
}

.switch-row {
  margin-top: 20px;
  padding-top: 14px;
  border-top: 1px solid var(--rule-soft);

  font-size: 12.5px;
  color: var(--ink-3);
}

.auth-foot {
  margin-top: 18px;
  font-family: var(--fang);
  font-size: 12.5px;
  line-height: 1.9;
  color: var(--ink-3);
}

@media (max-width: 640px) {
  .auth-aside {
    display: none;
  }

  .auth-body {
    padding: 32px 24px 26px;
  }

  .auth-logo img {
    height: 38px;
  }
}
</style>
