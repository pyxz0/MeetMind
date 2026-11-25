<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { acceptInvite, inspectInvite, type InviteInfo } from '../api/tenants'
import { fetchMe } from '../api/auth'
import { authStore, type TenantRole } from '../stores/auth'

/**
 * 接受邀请页（`/join/:token`）。
 *
 * 未登录也能打开 —— 先让人看到"你被邀请加入某某公司"，
 * 再引导登录/注册。否则用户要先注册才能知道这个链接是干什么的，
 * 那一步会流失掉大半。
 */

const route = useRoute()
const router = useRouter()

const token = computed(() => String(route.params.token ?? ''))

const loading = ref(true)
const joining = ref(false)
const info = ref<InviteInfo | null>(null)
const errorText = ref('')

const isLoggedIn = computed(() => authStore.isAuthenticated.value)

const ROLE_LABEL: Record<TenantRole, string> = {
  OWNER: '所有者',
  ADMIN: '管理员',
  MEMBER: '成员',
}

const load = async () => {
  loading.value = true
  errorText.value = ''

  try {
    info.value = await inspectInvite(token.value)
  } catch (error: unknown) {
    const anyError = error as { response?: { data?: { message?: string } } }

    errorText.value = anyError?.response?.data?.message ?? '邀请链接无效'
    info.value = null
  } finally {
    loading.value = false
  }
}

onMounted(load)

/** 未登录：带上回跳地址去登录页，登录/注册完自动回来 */
const goLogin = () => {
  router.push({ path: '/login', query: { redirect: route.fullPath } })
}

const join = async () => {
  joining.value = true

  try {
    const result = await acceptInvite(token.value)

    /** 当前空间已被后端切到该企业，前端要重新拉一次权限位 */
    const me = await fetchMe()
    authStore.setUser(me)

    if (result.alreadyMember) {
      ElMessage.success(`你已经是「${result.tenantName}」的成员`)
    } else {
      ElMessage.success(`已加入「${result.tenantName}」`)
    }

    router.push('/')
  } catch (error: unknown) {
    const anyError = error as { response?: { data?: { message?: string } } }

    ElMessage.error(anyError?.response?.data?.message ?? '加入失败，请重试')
  } finally {
    joining.value = false
  }
}
</script>

<template>
  <div class="join-page">
    <div class="join-card">
      <div v-if="loading" class="join-body">
        <p class="join-muted">正在校验邀请链接…</p>
      </div>

      <div v-else-if="errorText" class="join-body">
        <h1 class="join-title">链接不可用</h1>
        <p class="join-muted">{{ errorText }}</p>

        <el-button class="join-action" @click="router.push('/login')">
          去登录
        </el-button>
      </div>

      <div v-else-if="info && !info.valid" class="join-body">
        <h1 class="join-title">邀请已失效</h1>

        <p class="join-muted">
          {{ info.expired ? '这条邀请链接已经过期。' : '这条邀请链接已经被使用过。' }}
          请联系「{{ info.tenantName }}」的管理员重新发一个。
        </p>
      </div>

      <div v-else-if="info" class="join-body">
        <p class="join-eyebrow">你被邀请加入</p>

        <h1 class="join-title">{{ info.tenantName }}</h1>

        <p class="join-muted">
          加入后你的角色是<strong>{{ ROLE_LABEL[info.role] }}</strong>。
          <template v-if="info.phoneMasked">
            这条邀请是指定给 {{ info.phoneMasked }} 的，请用该手机号登录。
          </template>
        </p>

        <template v-if="isLoggedIn">
          <el-button
            type="primary"
            size="large"
            class="join-action"
            :loading="joining"
            @click="join"
          >
            加入「{{ info.tenantName }}」
          </el-button>
        </template>

        <template v-else>
          <el-button type="primary" size="large" class="join-action" @click="goLogin">
            登录后加入
          </el-button>

          <p class="join-tip">还没有账号？登录页可以直接注册，注册完会回到这里。</p>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.join-page {
  min-height: 100vh;

  display: flex;
  align-items: center;
  justify-content: center;

  padding: 24px;

  background: var(--desk);
}

.join-card {
  width: 100%;
  max-width: 420px;

  background: var(--paper);
  border: 1px solid var(--rule-soft);
  border-radius: 14px;

  box-shadow: 0 10px 30px rgba(21, 26, 46, 0.06);
}

.join-body {
  padding: 36px 32px;
  text-align: center;
}

.join-eyebrow {
  margin: 0 0 6px;

  font-size: 12px;
  letter-spacing: 0.08em;
  color: var(--ink-3);
}

.join-title {
  margin: 0 0 14px;

  font-size: 22px;
  font-weight: 700;
  line-height: 1.35;
  color: var(--ink);
}

.join-muted {
  margin: 0;

  font-size: 13px;
  line-height: 1.8;
  color: var(--ink-3);
}

.join-muted strong {
  color: var(--ink);
}

.join-action {
  width: 100%;
  margin-top: 24px;
}

.join-tip {
  margin: 12px 0 0;

  font-size: 12px;
  color: var(--ink-3);
}
</style>
