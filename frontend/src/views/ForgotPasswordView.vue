<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { requestPasswordReset } from '../api/auth'

const router = useRouter()

const form = reactive({ email: '' })
const submitting = ref(false)
/** 已提交：后端统一回复，不告诉前端这个邮箱有没有绑账号 */
const sent = ref(false)
/** 邮件服务是否真的发出去了；false 时提示联系管理员 */
const delivered = ref(true)
const message = ref('')

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

const submit = async () => {
  const email = form.email.trim().toLowerCase()

  if (!EMAIL_PATTERN.test(email)) {
    ElMessage.warning('邮箱格式不正确')
    return
  }

  submitting.value = true

  try {
    const result = await requestPasswordReset(email)

    message.value = result.message
    delivered.value = result.delivered
    sent.value = true
  } catch (error: any) {
    ElMessage.error(
      error?.response?.data?.message ?? '发送失败，请稍后重试'
    )
  } finally {
    submitting.value = false
  }
}

const goLogin = () => router.push('/login')
</script>

<template>
  <div class="forgot-page">
    <div class="forgot-sheet">
      <header class="sheet-head">
        <h1 class="sheet-title">找回密码</h1>
        <p class="sheet-sub">
          输入你绑定过的邮箱，我们会发一条一次性链接过去
        </p>
      </header>

      <div v-if="!sent" class="sheet-body">
        <el-form class="sheet-form" @submit.prevent="submit">
          <el-form-item>
            <el-input
              v-model="form.email"
              size="large"
              type="email"
              maxlength="160"
              placeholder="绑定邮箱，例如 name@example.com"
              autocomplete="email"
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
            发送重置链接
          </el-button>
        </el-form>

        <div class="sheet-foot">
          <p>链接 30 分钟内有效，只能使用一次。</p>
          <p>
            没绑定邮箱或收不到信？联系管理员：TA 可以在「用户管理」里直接生成一条链接发给你。
          </p>
          <el-button link type="primary" @click="goLogin">返回登录</el-button>
        </div>
      </div>

      <div v-else class="sheet-body">
        <p class="sent-title">{{ message }}</p>

        <p v-if="!delivered" class="sent-warn">
          注意：本站暂未配置发信服务，邮件不会真的发出。请把这个情况告诉管理员，
          让 TA 直接在用户管理里生成链接，或先配置 SMTP。
        </p>

        <p class="sent-hint">
          收到邮件后点里面的「设置新密码」即可；若几分钟内没收到，先看垃圾邮件箱，
          再确认邮箱是否拼对。
        </p>

        <el-button class="sheet-action" type="primary" size="large" @click="goLogin">
          返回登录
        </el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.forgot-page {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 28px 20px;
  background: var(--desk);
}

.forgot-sheet {
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

.sheet-action {
  width: 100%;
}

.sheet-foot {
  margin-top: 18px;
  font-size: 12.5px;
  line-height: 1.8;
  color: var(--ink-3);
}

.sheet-foot p {
  margin: 0 0 8px;
}

.sent-title {
  margin: 0 0 14px;
  font-size: 14px;
  line-height: 1.8;
  color: var(--ink);
}

.sent-warn {
  margin: 0 0 14px;
  padding: 10px 12px;
  font-size: 12.5px;
  line-height: 1.8;
  color: var(--vermilion);
  background: var(--vermilion-wash);
  border-left: 2px solid var(--vermilion);
}

.sent-hint {
  margin: 0 0 20px;
  font-size: 12.5px;
  line-height: 1.8;
  color: var(--ink-3);
}

@media (max-width: 520px) {
  .forgot-sheet {
    padding: 26px 22px 24px;
  }
}
</style>
