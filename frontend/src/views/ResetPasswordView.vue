<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  confirmPasswordReset,
  inspectPasswordReset,
  type PasswordResetInfo
} from '../api/auth'

const route = useRoute()
const router = useRouter()

/** 链接里的令牌；管理员生成后通过微信/企微发给本人 */
const token = computed(() => String(route.query.token ?? ''))

const inspecting = ref(true)
const submitting = ref(false)
const info = ref<PasswordResetInfo | null>(null)
const failure = ref('')
const done = ref(false)

const form = reactive({
  password: '',
  confirm: ''
})

/** 与后端 AuthService.assertPasswordStrength 同一套规则，先在前端拦一次 */
const PASSWORD_RULE = /^(?=.*[A-Za-z])(?=.*\d).{8,72}$/

const load = async () => {
  if (!token.value) {
    failure.value = '链接不完整，请向管理员重新索取'
    inspecting.value = false
    return
  }

  try {
    info.value = await inspectPasswordReset(token.value)
  } catch (error: any) {
    failure.value =
      error?.response?.data?.message ?? '链接无效或已过期，请向管理员重新索取'
  } finally {
    inspecting.value = false
  }
}

const submit = async () => {
  if (!PASSWORD_RULE.test(form.password)) {
    ElMessage.warning('密码需 8–72 位，并同时包含字母和数字')
    return
  }

  if (form.password !== form.confirm) {
    ElMessage.warning('两次输入的密码不一致')
    return
  }

  submitting.value = true

  try {
    await confirmPasswordReset(token.value, form.password)
    done.value = true
  } catch (error: any) {
    ElMessage.error(
      error?.response?.data?.message ?? '重置失败，请重新索取链接'
    )
  } finally {
    submitting.value = false
  }
}

const goLogin = () => router.push('/login')

onMounted(load)
</script>

<template>
  <div class="reset-page">
    <div class="reset-sheet">
      <header class="sheet-head">
        <h1 class="sheet-title">重置密码</h1>
        <p class="sheet-sub">
          这是管理员发出的一次性链接，设置新密码后立即失效
        </p>
      </header>

      <div v-if="inspecting" class="sheet-body">
        <p class="hint">正在校验链接…</p>
      </div>

      <div v-else-if="failure" class="sheet-body">
        <p class="hint hint-error">{{ failure }}</p>

        <el-button class="sheet-action" @click="goLogin">返回登录</el-button>
      </div>

      <div v-else-if="done" class="sheet-body">
        <p class="hint hint-ok">
          密码已重置。该账号此前登录的页面都已失效，请用新密码重新登录。
        </p>

        <el-button class="sheet-action" type="primary" @click="goLogin">
          去登录
        </el-button>
      </div>

      <div v-else class="sheet-body">
        <p class="who">
          正在为 <strong>{{ info?.name }}</strong>
          <span class="who-phone">{{ info?.phone }}</span> 设置新密码
        </p>

        <el-form class="sheet-form" @submit.prevent="submit">
          <el-form-item>
            <el-input
              v-model="form.password"
              size="large"
              type="password"
              show-password
              maxlength="72"
              placeholder="新密码（8–72 位，含字母和数字）"
              autocomplete="new-password"
            />
          </el-form-item>

          <el-form-item>
            <el-input
              v-model="form.confirm"
              size="large"
              type="password"
              show-password
              maxlength="72"
              placeholder="再输入一次"
              autocomplete="new-password"
              @keyup.enter="submit"
            />
          </el-form-item>

          <el-button
            class="sheet-action"
            type="primary"
            size="large"
            :loading="submitting"
            @click="submit"
          >
            设置新密码
          </el-button>
        </el-form>

        <p class="sheet-foot">
          设置成功后，这个链接不能再用；如果失效了，请让管理员重新发一个。
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.reset-page {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 28px 20px;
  background: var(--desk);
}

.reset-sheet {
  width: 100%;
  max-width: 460px;
  background: var(--paper);
  border: 1px solid var(--rule);
  padding: 34px 36px 30px;
}

.sheet-head {
  border-bottom: 1px solid var(--rule);
  padding-bottom: 18px;
  margin-bottom: 22px;
}

.sheet-title {
  margin: 0;
  font-family: var(--font-serif, inherit);
  font-size: 24px;
  font-weight: 500;
  letter-spacing: 0.04em;
  color: var(--ink);
}

.sheet-sub {
  margin: 8px 0 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--ink-2);
}

.sheet-body {
  display: block;
}

.hint {
  margin: 0 0 18px;
  font-size: 14px;
  line-height: 1.8;
  color: var(--ink-2);
}

.hint-error {
  color: var(--vermilion, #b5342a);
}

.hint-ok {
  color: var(--ink);
}

.who {
  margin: 0 0 18px;
  font-size: 13px;
  color: var(--ink-2);
}

.who strong {
  color: var(--ink);
  font-weight: 500;
}

.who-phone {
  margin-left: 8px;
  font-family: var(--font-mono, monospace);
  color: var(--ink-3);
}

.sheet-action {
  width: 100%;
}

.sheet-foot {
  margin: 18px 0 0;
  font-size: 12px;
  line-height: 1.8;
  color: var(--ink-3);
}

@media (max-width: 520px) {
  .reset-sheet {
    padding: 26px 22px 24px;
  }
}
</style>
