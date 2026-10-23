<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowDown } from '@element-plus/icons-vue'

import {
  getDraftMeetings,
  deleteMeeting,
  regenerateMeeting,
  type MeetingRecord
} from '../api/meeting'

import { useDraftStore } from '../composables/draftStore'

const router = useRouter()
const draftStore = useDraftStore()

const drafts = ref<MeetingRecord[]>([])
const loading = ref(false)
const regeneratingId = ref<number | null>(null)

/**
 * 已被用户手动折叠的草稿 ID 集合。
 *
 * 与历史会议页一致：记录「折叠项」，因此草稿默认展开，
 * 用户手动折叠后以用户操作为准。
 */
const collapsedIds = ref<Set<number>>(new Set())

const isExpanded = (id: number) => !collapsedIds.value.has(id)

const toggleExpanded = (id: number) => {
  const next = new Set(collapsedIds.value)

  if (next.has(id)) {
    next.delete(id)
  } else {
    next.add(id)
  }

  collapsedIds.value = next
}

/** 加载草稿箱 */
const loadDrafts = async () => {
  loading.value = true

  try {
    drafts.value = await getDraftMeetings()

    // 与顶部徽标同步
    await draftStore.refresh()
  } catch (error) {
    console.error('草稿箱加载失败：', error)

    ElMessage.error(
      '草稿箱加载失败，请检查后端服务是否启动'
    )
  } finally {
    loading.value = false
  }
}

/** 查看草稿会议详情 */
const handleView = (id: number) => {
  router.push(`/history/${id}`)
}

/** 重新生成会议纪要 */
const handleRegenerate = async (
  meeting: MeetingRecord
) => {
  try {
    await ElMessageBox.confirm(
      '将根据当前保存的会议原文重新生成纪要，是否继续？',
      '重新生成确认',
      {
        confirmButtonText: '重新生成',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )

    regeneratingId.value = meeting.id

    const updatedMeeting = await regenerateMeeting(
      meeting.id
    )

    // 从草稿列表移除
    drafts.value = drafts.value.filter(
      item => item.id !== meeting.id
    )

    // 顶部徽标立即 -1
    draftStore.decrement()

    ElMessage.success(
      '会议纪要重新生成成功'
    )

    // 跳转到正常会议详情
    router.push(
      `/history/${updatedMeeting.id}`
    )
  } catch (error: any) {
    if (
      error !== 'cancel' &&
      error !== 'close'
    ) {
      console.error(
        '重新生成失败：',
        error
      )

      ElMessage.error(
        '重新生成失败，请稍后重试'
      )
    }
  } finally {
    regeneratingId.value = null
  }
}

/** 删除草稿 */
const handleDelete = async (
  id: number
) => {
  try {
    await ElMessageBox.confirm(
      '确定删除这条草稿吗？删除后无法恢复。',
      '删除确认',
      {
        confirmButtonText: '确定删除',
        cancelButtonText: '取消',
        type: 'warning'
      }
    )

    await deleteMeeting(id)

    // 从当前列表移除
    drafts.value = drafts.value.filter(
      meeting => meeting.id !== id
    )

    // 顶部徽标立即 -1
    draftStore.decrement()

    ElMessage.success(
      '草稿删除成功'
    )
  } catch (error: any) {
    if (
      error !== 'cancel' &&
      error !== 'close'
    ) {
      console.error(
        '删除草稿失败：',
        error
      )

      ElMessage.error(
        '删除草稿失败'
      )
    }
  }
}

/** 格式化时间 */
const formatDate = (
  date?: string
) => {
  if (!date) {
    return '时间未知'
  }

  const value = new Date(date)

  if (Number.isNaN(value.getTime())) {
    return date
  }

  return value.toLocaleString(
    'zh-CN',
    {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }
  )
}

onMounted(loadDrafts)
</script>

<template>
  <div class="page">
    <div class="page-inner">
      <header class="page-head">
        <div>
          <h1>草稿箱</h1>

          <p class="page-desc">
            暂存了原文但还没生成纪要的会议。可以重新生成，也可以删掉。
          </p>
        </div>

        <div class="page-head-actions">
          <el-button :loading="loading" @click="loadDrafts">
            刷新
          </el-button>
        </div>
      </header>

      <div v-loading="loading" class="register sheet">
        <div class="register-head">
          <span class="register-title">草稿登记</span>

          <span class="register-meta">
            {{ drafts.length }} 份待处理
          </span>
        </div>

        <!-- 空状态 -->
        <el-empty v-if="!loading && drafts.length === 0" description="草稿箱是空的" />

        <template v-else>
          <article v-for="meeting in drafts" :key="meeting.id" class="reg-row"
            :class="{ 'reg-open': isExpanded(meeting.id) }">
            <header class="reg-head" role="button" tabindex="0" :aria-expanded="isExpanded(meeting.id)"
              @click="toggleExpanded(meeting.id)" @keydown.enter.prevent="toggleExpanded(meeting.id)"
              @keydown.space.prevent="toggleExpanded(meeting.id)">
              <span class="reg-no">{{ String(meeting.id).padStart(3, '0') }}</span>

              <div class="reg-main">
                <h2 class="reg-title">
                  <router-link :to="`/history/${meeting.id}`" @click.stop>
                    {{ meeting.title || `会议 #${meeting.id}` }}
                  </router-link>
                </h2>

                <span class="reg-sub">{{ formatDate(meeting.createdAt) }}</span>
              </div>

              <el-tag size="small" type="warning">
                草稿
              </el-tag>

              <span class="reg-toggle" :title="isExpanded(meeting.id) ? '收起' : '展开'"
                :aria-label="isExpanded(meeting.id) ? '收起' : '展开'">
                <el-icon :class="{ rotated: isExpanded(meeting.id) }">
                  <ArrowDown />
                </el-icon>
              </span>
            </header>

            <div v-show="isExpanded(meeting.id)" class="reg-body">
              <div class="sec">
                <div class="sec-h">
                  <span class="sec-n">原</span>
                  <span class="sec-t">会议原文</span>
                  <span class="sec-x">生成纪要后这份原文会留在纪要里</span>
                </div>

                <p class="prose draft-text">
                  {{ meeting.content || '暂无会议原文' }}
                </p>
              </div>

              <div class="reg-actions">
                <el-button @click="handleView(meeting.id)">
                  查看详情
                </el-button>

                <el-button type="primary" :loading="regeneratingId === meeting.id" @click="handleRegenerate(meeting)">
                  重新生成纪要
                </el-button>

                <el-button type="danger" plain :disabled="regeneratingId === meeting.id"
                  @click="handleDelete(meeting.id)">
                  删除
                </el-button>
              </div>
            </div>
          </article>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.draft-text {
  margin-top: 14px;
  max-height: 260px;
  overflow-y: auto;

  padding-right: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}

@media (max-width: 640px) {
  .page {
    padding: 22px 14px 48px;
  }
}
</style>
