<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { createScheduledMeeting } from '../api/meeting'
import { listContacts, type Contact } from '../api/auth'

const router = useRouter()

const contacts = ref<Contact[]>([])
const contactsLoading = ref(false)

const loadContacts = async () => {
  if (contacts.value.length) return

  contactsLoading.value = true

  try {
    contacts.value = await listContacts()
  } catch {
    contacts.value = []
  } finally {
    contactsLoading.value = false
  }
}

/* ---------- 临时会议 ---------- */

/** 临时会议：直接进入即时纪要流程（转写 + 生成） */
const startInstant = () => {
  router.push('/minutes/instant')
}

/* ---------- 正式会议 ---------- */

const form = reactive({
  title: '',
  scheduledAt: '' as string | number | Date | '',
  leaderIds: [] as number[],
  memberIds: [] as number[]
})

const submitting = ref(false)

/** 时间与参会人都选好后才能提交 */
const canSubmit = computed(
  () => !!form.scheduledAt && !submitting.value
)

const submit = async () => {
  if (!form.scheduledAt) {
    ElMessage.warning('请选择开会时间')
    return
  }

  const when = new Date(form.scheduledAt)

  if (Number.isNaN(when.getTime())) {
    ElMessage.warning('开会时间格式不正确')
    return
  }

  submitting.value = true

  try {
    const meeting = await createScheduledMeeting({
      title: form.title.trim() || undefined,
      scheduledAt: when.toISOString(),
      leaderIds: form.leaderIds,
      memberIds: form.memberIds
    })

    ElMessage.success('正式会议已创建，参会人员会在开会前 20 分钟收到提醒')

    router.push(`/history/${meeting.id}`)
  } catch (error: any) {
    const message = error?.response?.data?.message ?? '创建失败'
    ElMessage.error(Array.isArray(message) ? message.join('；') : message)
  } finally {
    submitting.value = false
  }
}

onMounted(loadContacts)
</script>

<template>
  <div class="minutes-page">
    <div class="page-container">
      <div class="page-header">
        <h1>智能纪要</h1>
        <p>临时会议立即开始；正式会议可预约时间，参会人员会在开会前收到提醒</p>
      </div>

      <div class="mode-grid">
        <!-- 临时会议 -->
        <el-card class="mode-card" shadow="hover">
          <div class="mode-head">
            <span class="mode-icon">⚡</span>
            <h2>临时会议</h2>
          </div>

          <p class="mode-desc">
            现在就开会。点击开始后直接进入实时转写与录音页面，边开会边记录，
            结束后一键生成纪要。
          </p>

          <ul class="mode-points">
            <li>实时语音转写，可暂停/继续</li>
            <li>同步录音，会后可回听</li>
            <li>会议结束后生成摘要、决策与待办</li>
          </ul>

          <el-button type="primary" size="large" class="mode-action" @click="startInstant">
            开始临时会议
          </el-button>
        </el-card>

        <!-- 正式会议 -->
        <el-card class="mode-card" shadow="hover">
          <div class="mode-head">
            <span class="mode-icon">📅</span>
            <h2>正式会议</h2>
          </div>

          <p class="mode-desc">
            预约开会时间并指定参会人员。距离开会不足 20 分钟时，
            所有参会人员（含负责人）会在收件箱收到提醒。
          </p>

          <el-form label-position="top" class="mode-form">
            <el-form-item label="会议主题">
              <el-input v-model="form.title" maxlength="200" placeholder="不填则使用「未命名会议」" />
            </el-form-item>

            <el-form-item label="开会时间">
              <el-date-picker v-model="form.scheduledAt" type="datetime" placeholder="选择开会时间"
                format="YYYY-MM-DD HH:mm" :disabled-date="(d: Date) => d.getTime() < Date.now() - 86400000"
                style="width: 100%" />
            </el-form-item>

            <el-form-item label="负责人（不选则默认是你）">
              <el-select v-model="form.leaderIds" multiple filterable placeholder="选择负责人"
                :loading="contactsLoading" style="width: 100%">
                <el-option v-for="c in contacts" :key="c.id" :label="`${c.name}（${c.phone}）`" :value="c.id" />
              </el-select>
            </el-form-item>

            <el-form-item label="参会成员">
              <el-select v-model="form.memberIds" multiple filterable placeholder="选择参会成员"
                :loading="contactsLoading" style="width: 100%">
                <el-option v-for="c in contacts" :key="c.id" :label="`${c.name}（${c.phone}）`" :value="c.id" />
              </el-select>
            </el-form-item>
          </el-form>

          <el-button type="primary" size="large" class="mode-action" :loading="submitting" :disabled="!canSubmit"
            @click="submit">
            创建正式会议
          </el-button>

          <p class="mode-hint">创建后可到会议详情继续补充成员或调整负责人</p>
        </el-card>
      </div>
    </div>
  </div>
</template>

<style scoped>
.minutes-page {
  min-height: 100%;
  background: #f5f7fa;
  padding: 40px 20px 60px;
}

.page-container {
  max-width: 1000px;
  margin: 0 auto;
}

.page-header {
  margin-bottom: 24px;
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

.mode-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
  align-items: start;
}

.mode-card {
  border-radius: 12px;
  height: 100%;
}

.mode-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.mode-icon {
  width: 38px;
  height: 38px;

  display: flex;
  align-items: center;
  justify-content: center;

  border-radius: 10px;
  background: #f0f7ff;
  font-size: 19px;
}

.mode-head h2 {
  margin: 0;
  font-size: 18px;
  color: #303133;
}

.mode-desc {
  margin: 0 0 12px;
  color: #606266;
  font-size: 13px;
  line-height: 1.7;
}

.mode-points {
  margin: 0 0 18px;
  padding-left: 18px;
  color: #909399;
  font-size: 13px;
  line-height: 1.9;
}

.mode-form {
  margin-bottom: 4px;
}

.mode-action {
  width: 100%;
  margin-top: 8px;
}

.mode-hint {
  margin: 10px 0 0;
  color: #c0c4cc;
  font-size: 12px;
  text-align: center;
}

@media (max-width: 900px) {
  .mode-grid {
    grid-template-columns: 1fr;
  }
}
</style>
