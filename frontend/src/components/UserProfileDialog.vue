<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { getUserProfile, type UserProfile } from '../api/auth'
import { openConversation } from '../api/message'

const props = defineProps<{
  modelValue: boolean
  userId: number | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
}>()

const router = useRouter()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
})

const profile = ref<UserProfile | null>(null)
const loading = ref(false)
const opening = ref(false)

/** 加载名片；失败时清空，避免弹窗里残留上一个人的信息 */
const load = async () => {
  const id = props.userId

  if (!id) {
    profile.value = null
    return
  }

  loading.value = true
  profile.value = null

  try {
    profile.value = await getUserProfile(id)
  } catch (error: any) {
    const message = error?.response?.data?.message ?? '名片加载失败'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  } finally {
    loading.value = false
  }
}

watch(
  () => [props.modelValue, props.userId],
  ([open]) => {
    if (open) void load()
  }
)

const initial = computed(() => profile.value?.name?.slice(0, 1) ?? '·')

const formatDate = (iso: string) => {
  const date = new Date(iso)

  if (Number.isNaN(date.getTime())) return ''

  const pad = (n: number) => String(n).padStart(2, '0')

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 从名片直接进入共同会议 */
const openMeeting = (id: number) => {
  visible.value = false
  void router.push(`/history/${id}`)
}

/** 从名片直接发起私信 */
const startChat = async () => {
  if (!profile.value) return

  opening.value = true

  try {
    const { conversationId } = await openConversation(profile.value.id)
    visible.value = false
    void router.push(`/messages/${conversationId}`)
  } catch (error: any) {
    const message = error?.response?.data?.message ?? '打开会话失败'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  } finally {
    opening.value = false
  }
}
</script>

<template>
  <el-dialog v-model="visible" title="个人主页" width="min(480px, 92vw)" append-to-body>
    <div v-loading="loading" class="profile">
      <template v-if="profile">
        <header class="profile-head">
          <span class="profile-avatar">
            <img v-if="profile.avatar" :src="profile.avatar" alt="" class="profile-avatar-img" />
            <template v-else>{{ initial }}</template>
          </span>

          <div class="profile-id">
            <h3 class="profile-name">
              {{ profile.name }}
              <el-tag v-if="profile.isSelf" size="small" effect="plain">你自己</el-tag>
              <el-tag v-else-if="!profile.isActive" size="small" type="info" effect="plain">已停用</el-tag>
            </h3>

            <p class="profile-phone num">{{ profile.phone }}</p>

            <p class="profile-meta">
              <span>{{ profile.roleLabel }}</span>
              <span class="profile-dot">·</span>
              <span>{{ formatDate(profile.createdAt) }} 加入</span>
            </p>
          </div>
        </header>

        <div class="profile-stats">
          <div class="stat">
            <span class="stat-v num">{{ profile.sharedMeetingCount }}</span>
            <span class="stat-k">共同会议</span>
          </div>

          <div class="stat">
            <span class="stat-v num">{{ profile.openTodoCount }}</span>
            <span class="stat-k">未完成待办</span>
          </div>
        </div>

        <section class="profile-sec">
          <h4 class="profile-label">最近共同会议</h4>

          <p v-if="!profile.sharedMeetings.length" class="profile-empty">
            还没有共同参与的会议。
          </p>

          <ul v-else class="profile-meetings">
            <li v-for="row in profile.sharedMeetings" :key="row.id">
              <button type="button" class="profile-meeting" @click="openMeeting(row.id)">
                <span class="profile-meeting-no num">{{ String(row.id).padStart(3, '0') }}</span>
                <span class="profile-meeting-title">{{ row.title || `会议 #${row.id}` }}</span>
                <span class="profile-meeting-date num">{{ formatDate(row.createdAt) }}</span>
              </button>
            </li>
          </ul>
        </section>
      </template>

      <el-empty v-else-if="!loading" description="看不到这位同事的名片" :image-size="72" />
    </div>

    <template #footer>
      <el-button @click="visible = false">关闭</el-button>

      <el-button v-if="profile && !profile.isSelf" type="primary" :loading="opening" @click="startChat">
        发私信
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.profile {
  min-height: 120px;
}

.profile-head {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--rule);
}

.profile-avatar {
  flex-shrink: 0;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: var(--paper-3);
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--song);
  font-size: 22px;
  color: var(--ink-2);
  overflow: hidden;
}

.profile-avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.profile-id {
  min-width: 0;
  flex: 1;
}

.profile-name {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 4px;
  font-family: var(--song);
  font-size: 17px;
  letter-spacing: 0.04em;
  color: var(--ink);
}

.profile-phone {
  margin: 0 0 4px;
  font-size: 12.5px;
  color: var(--ink-2);
}

.profile-meta {
  margin: 0;
  font-size: 11.5px;
  color: var(--ink-3);
}

.profile-dot {
  margin: 0 6px;
}

.profile-stats {
  display: flex;
  margin: 16px 0 4px;
  border: 1px solid var(--rule);
}

.stat {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 16px;
  border-left: 1px solid var(--rule);
}

.stat:first-child {
  border-left: none;
}

.stat-v {
  font-family: var(--song);
  font-size: 22px;
  line-height: 1;
  color: var(--ink);
}

.stat-k {
  font-size: 11px;
  color: var(--ink-3);
}

.profile-sec {
  margin-top: 18px;
}

.profile-label {
  margin: 0 0 8px;
  font-size: 11.5px;
  font-weight: 400;
  letter-spacing: 0.04em;
  color: var(--ink-3);
}

.profile-empty {
  margin: 0;
  padding: 10px 0;
  font-size: 12.5px;
  color: var(--ink-3);
}

.profile-meetings {
  margin: 0;
  padding: 0;
  list-style: none;
}

.profile-meeting {
  display: flex;
  align-items: baseline;
  gap: 10px;
  width: 100%;
  padding: 8px 2px;
  border: none;
  border-bottom: 1px solid var(--rule-soft);
  background: transparent;
  cursor: pointer;
  text-align: left;
}

.profile-meeting:hover .profile-meeting-title {
  color: var(--brand);
}

.profile-meeting-no {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--ink-3);
}

.profile-meeting-title {
  flex: 1;
  min-width: 0;
  font-family: var(--song);
  font-size: 13.5px;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: color 0.15s;
}

.profile-meeting-date {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--ink-3);
}
</style>
