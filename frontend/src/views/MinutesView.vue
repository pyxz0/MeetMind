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
  <div class="page">
    <div class="page-narrow">
      <header class="page-head">
        <div>
          <h1>智能纪要</h1>

          <p class="page-desc">
            临时会议立即开始；正式会议可预约时间，参会人员会在开会前收到提醒
          </p>
        </div>
      </header>

      <div class="modes sheet">
        <!-- 临时会议 -->
        <section class="mode">
          <div class="mode-head">
            <span class="mode-t">临时会议</span>
            <span class="mode-k">现在开始</span>
          </div>

          <p class="prose mode-desc">
            现在就开会。点开始后直接进入实时转写与录音，边开会边记录，结束后一键生成纪要。
          </p>

          <ul class="mode-points">
            <li>实时语音转写，可暂停／继续</li>
            <li>同步录音，会后可回听</li>
            <li>散会即出摘要、决策与待办</li>
          </ul>

          <el-button type="primary" size="large" class="mode-action" @click="startInstant">
            开始临时会议
          </el-button>
        </section>

        <!-- 正式会议 -->
        <section class="mode mode-form">
          <div class="mode-head">
            <span class="mode-t">正式会议</span>
            <span class="mode-k">预约</span>
          </div>

          <p class="mode-desc text">
            预约开会时间并指定参会人员。距离开会不足 20 分钟时，
            参会人员（含负责人）会在收件箱收到提醒。
          </p>

          <el-form label-position="top" class="mode-fields">
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

          <p class="mode-hint">
            创建后可到会议详情继续补充成员或调整负责人
          </p>
        </section>
      </div>

      <section class="upload-entry">
        <div class="upload-copy">
          <div class="upload-t">已有录音？上传转写</div>
          <p class="upload-d">
            把手机录音或会议软件的录制文件传上来，服务端转成文字，再一键生成摘要、决策与待办。
          </p>
        </div>

        <el-button @click="router.push('/minutes/upload')">上传录音</el-button>
      </section>
    </div>
  </div>
</template>

<style scoped>
.upload-entry {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin-top: 18px;
  padding: 18px 22px;
  border: 1px solid var(--rule);
  background: var(--paper);
  flex-wrap: wrap;
}

.upload-t {
  font-size: 14px;
  color: var(--ink);
}

.upload-d {
  margin: 6px 0 0;
  font-size: 12.5px;
  line-height: 1.8;
  color: var(--ink-2);
}

.modes {
  display: grid;
  grid-template-columns: minmax(0, 0.82fr) minmax(0, 1.18fr);
  align-items: stretch;
}

.mode {
  display: flex;
  flex-direction: column;
  padding: 28px 30px 30px;
}

.mode-form {
  border-left: 1px solid var(--rule);
  background: var(--paper);
}

.mode-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--rule);
}

.mode-t {
  font-family: var(--song);
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 0.1em;
}

.mode-k {
  margin-left: auto;
  font-size: 11px;
  letter-spacing: 0.06em;
  color: var(--ink-3);
}

.mode-desc {
  margin-top: 16px;
}

.mode-points {
  margin: 18px 0 0;
  padding: 0;
  list-style: none;

  display: flex;
  flex-direction: column;
  gap: 9px;

  font-size: 12.5px;
  color: var(--ink-2);
}

.mode-points li {
  display: flex;
  gap: 9px;
  align-items: baseline;
}

.mode-points li::before {
  content: "—";
  color: var(--rule);
  flex-shrink: 0;
}

.mode-fields {
  margin-top: 18px;
}

.mode-action {
  margin-top: auto;
  width: 100%;
  height: 40px;
}

.mode-hint {
  margin-top: 10px;
  font-size: 11.5px;
  color: var(--ink-3);
  text-align: center;
}

@media (max-width: 900px) {
  .modes {
    grid-template-columns: minmax(0, 1fr);
  }

  .mode-form {
    border-left: none;
    border-top: 1px solid var(--rule);
  }

  .mode-action {
    margin-top: 18px;
  }
}

@media (max-width: 640px) {
  .page {
    padding: 22px 14px 48px;
  }

  .mode {
    padding: 22px 18px 24px;
  }
}
</style>
