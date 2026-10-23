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

/* =========================
   头像
   ========================= */

const avatarInput = ref<HTMLInputElement | null>(null)
const avatarSaving = ref(false)

const pickAvatar = () => {
  avatarInput.value?.click()
}

/**
 * 把选中的图片裁成正方形、缩到 256px，再转成 JPEG data URL。
 *
 * 在浏览器里压完再上传，后端只存结果：一张 256px 的头像约 15–30KB，
 * 既不会撑大用户接口，也不用再维护一套静态资源目录与鉴权。
 */
const fileToAvatar = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()

    reader.onerror = () => reject(new Error('图片读取失败，请重试'))

    reader.onload = () => {
      const image = new Image()

      image.onerror = () => reject(new Error('这张图无法识别，请换一张'))

      image.onload = () => {
        const side = Math.min(image.width, image.height)
        const canvas = document.createElement('canvas')

        canvas.width = 256
        canvas.height = 256

        const context = canvas.getContext('2d')

        if (!context) {
          reject(new Error('当前浏览器不支持图片处理'))
          return
        }

        context.imageSmoothingQuality = 'high'
        context.drawImage(
          image,
          (image.width - side) / 2,
          (image.height - side) / 2,
          side,
          side,
          0,
          0,
          256,
          256
        )

        resolve(canvas.toDataURL('image/jpeg', 0.85))
      }

      image.src = String(reader.result)
    }

    reader.readAsDataURL(file)
  })

const onAvatarChange = async (event: Event) => {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]

  // 清空 value：同一张图重新选择时也要能触发 change
  input.value = ''

  if (!file) return

  if (!file.type.startsWith('image/')) {
    ElMessage.warning('请选择图片文件（PNG / JPEG / WebP）')
    return
  }

  if (file.size > 8 * 1024 * 1024) {
    ElMessage.warning('图片超过 8MB，请换一张小一点的')
    return
  }

  avatarSaving.value = true

  try {
    const avatar = await fileToAvatar(file)
    const updated = await updateProfile({ avatar })

    authStore.setUser(updated)

    ElMessage.success('头像已更新')
  } catch (error: any) {
    const message =
      error?.response?.data?.message ?? error?.message ?? '头像上传失败，请重试'

    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  } finally {
    avatarSaving.value = false
  }
}

const removeAvatar = async () => {
  avatarSaving.value = true

  try {
    const updated = await updateProfile({ avatar: '' })

    authStore.setUser(updated)

    ElMessage.success('已移除头像')
  } catch (error: any) {
    const message =
      error?.response?.data?.message ?? '移除失败，请重试'

    ElMessage.error(message)
  } finally {
    avatarSaving.value = false
  }
}

/* =========================
   放大查看
   ========================= */

const avatarDialogVisible = ref(false)

const openAvatarDialog = () => {
  avatarDialogVisible.value = true
}

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
    const updated = await updateProfile({
      currentPassword: passwordForm.currentPassword,
      newPassword: passwordForm.newPassword
    })

    // 改密后旧令牌已失效，用后端补发的新令牌续上当前会话
    if (updated.token) {
      const { token, ...rest } = updated
      authStore.setSession(token, rest)
    }

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
  <div class="page">
    <div class="page-inner">
      <header class="page-head">
        <div>
          <h1>个人中心</h1>

          <p class="page-desc">
            账号信息与登录密码在这里维护，手机号需由管理员修改。
          </p>
        </div>
      </header>

      <div class="account sheet">
        <!-- 左栏：身份与入口 -->
        <aside class="side">
          <div class="ident">
            <!-- 点头像：放大查看，并在弹窗里更换 / 移除 -->
            <button type="button" class="ident-avatar" :aria-label="user?.avatar ? '查看或更换头像' : '添加头像'"
              @click="openAvatarDialog">
              <img v-if="user?.avatar" :src="user.avatar" alt="" class="ident-avatar-img" />
              <span v-else class="ident-mark">{{ avatarText }}</span>

              <span class="ident-avatar-hint">点击查看</span>
            </button>

            <div class="ident-main">
              <h2 class="ident-name">{{ user?.name }}</h2>

              <p class="ident-role">
                {{ user?.roleLabel }}

                <span v-if="isSoleSuperAdmin" class="ident-sole">系统唯一超管</span>
              </p>

              <p class="ident-phone num">{{ user?.phone }}</p>
            </div>
          </div>

          <dl class="ident-rows">
            <div v-if="user?.roleLabel" class="ident-row">
              <dt>角色</dt>
              <dd>{{ user?.roleLabel }}</dd>
            </div>

            <div v-if="user?.phone" class="ident-row">
              <dt>手机号</dt>
              <dd class="num">{{ user?.phone }}</dd>
            </div>

            <div v-if="user?.createdAt" class="ident-row">
              <dt>注册时间</dt>
              <dd class="num">{{ formatDate(user?.createdAt) }}</dd>
            </div>
          </dl>

          <nav v-if="canManageUsers" class="entries">
            <div class="entries-k">管理入口</div>

            <el-button link class="entry" @click="router.push('/users')">
              用户管理
            </el-button>

            <el-button v-if="canViewAudit" link class="entry" @click="router.push('/audit')">
              审计日志
            </el-button>
          </nav>
        </aside>

        <!-- 右栏：资料、密码、退出 -->
        <div class="main">
          <section class="sec">
            <div class="sec-h">
              <span class="sec-n">一</span>
              <span class="sec-t">修改资料</span>
              <span class="sec-x">姓名显示在顶栏与纪要里</span>
            </div>

            <el-form label-position="top" class="fields">
              <el-form-item label="姓名">
                <el-input v-model="nameForm.name" maxlength="80" placeholder="请输入姓名" @keyup.enter="saveName" />
              </el-form-item>
            </el-form>

            <el-button type="primary" :loading="nameSaving" @click="saveName">
              保存
            </el-button>
          </section>

          <section class="sec">
            <div class="sec-h">
              <span class="sec-n">二</span>
              <span class="sec-t">修改密码</span>
              <span class="sec-x">下次登录使用新密码</span>
            </div>

            <el-form label-position="top" class="fields">
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
            </el-form>

            <el-button type="primary" :loading="passwordSaving" @click="savePassword">
              修改密码
            </el-button>
          </section>

          <div class="reg-actions">
            <div class="logout-main">
              <div class="logout-t">退出登录</div>
              <p class="logout-x">退出后需重新输入手机号与密码。</p>
            </div>

            <el-button type="danger" plain @click="handleLogout">
              退出登录
            </el-button>
          </div>
        </div>

        <!-- 头像：放大查看，同时提供更换与移除 -->
        <el-dialog v-model="avatarDialogVisible" title="头像" width="min(420px, 92vw)" append-to-body>
          <div class="avatar-view">
            <img v-if="user?.avatar" :src="user.avatar" alt="" class="avatar-view-img" />
            <span v-else class="avatar-view-mark">{{ avatarText }}</span>
          </div>

          <p class="avatar-view-hint">
            图片会按正方形居中裁切并缩到 256px 后保存。支持 PNG / JPEG / WebP，单张不超过 8MB。
          </p>

          <input ref="avatarInput" type="file" accept="image/png,image/jpeg,image/webp" class="avatar-file"
            @change="onAvatarChange" />

          <template #footer>
            <div class="avatar-foot">
              <el-button v-if="user?.avatar" type="danger" plain :disabled="avatarSaving" @click="removeAvatar">
                移除头像
              </el-button>

              <span class="avatar-foot-gap" />

              <el-button :disabled="avatarSaving" @click="avatarDialogVisible = false">
                关闭
              </el-button>

              <el-button type="primary" :loading="avatarSaving" @click="pickAvatar">
                {{ user?.avatar ? '更换头像' : '上传头像' }}
              </el-button>
            </div>
          </template>
        </el-dialog>
      </div>
    </div>
  </div>
</template>

<style scoped>
.account {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
}

/* ---------- 左栏：身份 ---------- */
.side {
  padding: 26px 24px 28px;
  border-right: 1px solid var(--rule);
}

.ident {
  display: flex;
  gap: 14px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--rule);
}

/* 头像：方形、2px 直角，和整站的纸面一致；整块可点，点开看大图 */
.ident-avatar {
  width: 68px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;

  padding: 0;
  border: none;
  background: none;
  font-family: inherit;
  cursor: pointer;
}

.ident-avatar-img {
  width: 68px;
  height: 68px;
  object-fit: cover;
  display: block;

  border: 1px solid var(--rule);
  background: var(--paper-2);
  transition: border-color 0.16s;
}

.ident-avatar:hover .ident-avatar-img,
.ident-avatar:hover .ident-mark {
  border-color: var(--brand);
}

.ident-avatar-hint {
  font-size: 10.5px;
  color: var(--ink-3);
  letter-spacing: 0.02em;
}

.ident-avatar:hover .ident-avatar-hint {
  color: var(--brand-strong);
}

.ident-mark {
  width: 68px;
  height: 68px;
  display: flex;
  align-items: center;
  justify-content: center;

  background: var(--ink);
  color: var(--paper);
  font-family: var(--song);
  font-size: 28px;
}

/* ---------- 头像弹窗：放大 + 更换 ---------- */
.avatar-view {
  display: flex;
  justify-content: center;
  padding: 4px 0 18px;
}

.avatar-view-img,
.avatar-view-mark {
  width: min(280px, 100%);
  aspect-ratio: 1 / 1;
  display: flex;
  align-items: center;
  justify-content: center;

  border: 1px solid var(--rule);
  background: var(--paper-2);
}

.avatar-view-img {
  object-fit: cover;
}

.avatar-view-mark {
  background: var(--ink);
  color: var(--paper);
  font-family: var(--song);
  font-size: 120px;
}

@media (max-width: 480px) {
  .avatar-view-mark {
    font-size: 84px;
  }
}

.avatar-view-hint {
  font-size: 12px;
  line-height: 1.8;
  color: var(--ink-3);
  text-align: center;
}

.avatar-file {
  display: none;
}

.avatar-foot {
  display: flex;
  align-items: center;
  gap: 10px;
}

.avatar-foot-gap {
  flex: 1;
}

.ident-main {
  min-width: 0;
}

.ident-name {
  font-size: 20px;
  letter-spacing: 0.06em;
}

.ident-role,
.ident-phone {
  margin-top: 4px;
  font-size: 12px;
  color: var(--ink-3);
}

.ident-sole {
  margin-left: 6px;
  color: var(--vermilion);
}

.ident-rows {
  margin: 0;
  padding: 0;
}

.ident-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 9px 0;
  border-bottom: 1px solid var(--rule-soft);
  font-size: 12.5px;
}

.ident-row dt {
  flex-shrink: 0;
  color: var(--ink-3);
}

.ident-row dd {
  margin: 0;
  color: var(--ink);
  text-align: right;
}

/* ---------- 左栏：管理入口 ---------- */
.entries {
  display: flex;
  flex-direction: column;
  margin-top: 22px;
}

.entries-k {
  margin-bottom: 4px;
  font-family: var(--song);
  letter-spacing: 0.1em;
}

.entries .entry {
  justify-content: flex-start;
  width: 100%;
  padding: 8px 0;
  font-size: 13px;
}

/* ---------- 右栏 ---------- */
.main {
  padding: 28px 36px 30px;
}

.fields {
  max-width: 380px;
  margin-top: 16px;
}

.logout-main {
  flex: 1;
  min-width: 0;
}

.logout-t {
  font-family: var(--song);
  font-size: 15px;
  letter-spacing: 0.08em;
}

.logout-x {
  margin-top: 3px;
  font-size: 11.5px;
  color: var(--ink-3);
}

@media (max-width: 640px) {
  .page { padding: 22px 14px 48px; }
  .account { grid-template-columns: minmax(0, 1fr); }
  .main { padding: 20px 18px 24px; }
  .fields { max-width: none; }

  .side {
    padding: 20px 18px 22px;
    border-right: none;
    border-bottom: 1px solid var(--rule);
  }
}
</style>
