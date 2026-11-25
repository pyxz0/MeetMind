<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { authStore } from '../stores/auth'
import { fetchMe } from '../api/auth'
import {
  createTenant,
  listMyTenants,
  switchTenant,
  type MyTenant,
} from '../api/tenants'
import { recordingStatus } from '../composables/recordingStatus'

/**
 * 空间切换器。
 *
 * 放在侧栏品牌行下面：它决定「接下来看到的所有数据属于哪个空间」，
 * 层级比导航更高 —— 换空间等于换了一套会议、待办和成员。
 */

const tenants = ref<MyTenant[]>([])
const busy = ref(false)

const current = computed(() => tenants.value.find((item) => item.isActive) ?? null)

const typeLabel = (type?: string) => (type === 'COMPANY' ? '企业' : '个人')

/** 从 axios 错误里取后端的中文提示 */
const extractMessage = (error: unknown): string | undefined => {
  const anyError = error as { response?: { data?: { message?: string } } }

  return anyError?.response?.data?.message
}

const load = async () => {
  if (!authStore.isAuthenticated.value) return

  try {
    tenants.value = await listMyTenants()
  } catch {
    // 空间列表属于辅助信息，拉取失败不该让整个侧栏报错
    tenants.value = []
  }
}

onMounted(load)

/**
 * 切换空间后必须重新拉 /auth/me。
 *
 * 后端会把新的 tenantRole 与 permissions 算好返回，前端不能自己按
 * 旧角色推 —— 从企业管理员切到个人空间时，菜单要立刻收起。
 */
const refreshMe = async () => {
  const me = await fetchMe()

  authStore.setUser(me)
}

const handleCommand = async (command: string) => {
  if (busy.value) return

  if (command === 'create') {
    await handleCreate()
    return
  }

  const tenantId = command.replace('switch:', '')
  const target = tenants.value.find((item) => item.id === tenantId)

  if (!target || target.isActive) return

  /**
   * 录音中不许切。
   *
   * 会议的归属在开始录音那一刻就定了，中途切空间会让这场会的纪要
   * 落到另一个空间里去 —— 用户不会意识到，事后也很难解释。
   */
  if (recordingStatus.recording) {
    ElMessage.warning('录音进行中，请先结束当前会议再切换空间')
    return
  }

  busy.value = true

  try {
    const result = await switchTenant(target.id)

    await refreshMe()
    await load()

    ElMessage.success(`已切换到「${result.tenantName}」`)
  } catch (error: unknown) {
    ElMessage.error(extractMessage(error) ?? '切换失败，请重试')
  } finally {
    busy.value = false
  }
}

const handleCreate = async () => {
  let name = ''

  try {
    const result = await ElMessageBox.prompt(
      '创建后可以邀请同事加入，会议纪要归企业持有。',
      '创建企业空间',
      {
        confirmButtonText: '创建',
        cancelButtonText: '取消',
        inputPlaceholder: '企业名称（2-40 字）',
        inputPattern: /^.{2,40}$/,
        inputErrorMessage: '企业名称需要 2-40 个字',
      },
    )

    name = (result.value ?? '').trim()
  } catch {
    // 用户点了取消，不是错误
    return
  }

  if (!name) return

  busy.value = true

  try {
    const created = await createTenant(name)

    /** 后端建完会自动把当前空间切过去，这里同步前端状态 */
    await refreshMe()
    await load()

    ElMessage.success(`「${created.name}」已创建，你是所有者`)
  } catch (error: unknown) {
    ElMessage.error(extractMessage(error) ?? '创建失败，请重试')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <el-dropdown
    class="space"
    trigger="click"
    placement="bottom-start"
    :disabled="busy"
    @command="handleCommand"
  >
    <button class="space-btn" type="button" :disabled="busy">
      <span class="space-icon" :class="current?.type === 'COMPANY' ? 'is-company' : 'is-personal'">
        {{ current?.type === 'COMPANY' ? '企' : '私' }}
      </span>

      <span class="space-text">
        <span class="space-name">{{ current?.name ?? '我的空间' }}</span>
        <span class="space-meta">
          {{ typeLabel(current?.type) }}
          <template v-if="current"> · {{ current.memberCount }} 人</template>
        </span>
      </span>

      <span class="space-caret">▾</span>
    </button>

    <template #dropdown>
      <el-dropdown-menu class="space-menu">
        <el-dropdown-item
          v-for="item in tenants"
          :key="item.id"
          :command="`switch:${item.id}`"
          :disabled="item.isActive"
        >
          <span class="opt">
            <span class="opt-name">
              {{ item.name }}
              <em v-if="item.isActive" class="opt-now">当前</em>
            </span>

            <span class="opt-meta">
              {{ typeLabel(item.type) }} · {{ item.memberCount }} 人
              <template v-if="item.role === 'OWNER'"> · 所有者</template>
              <template v-else-if="item.role === 'ADMIN'"> · 管理员</template>
            </span>
          </span>
        </el-dropdown-item>

        <el-dropdown-item divided command="create">
          ＋ 创建企业空间
        </el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<style scoped>
.space {
  display: block;
  padding: 10px 12px;
  border-bottom: 1px solid var(--rule);
}

.space :deep(.el-dropdown) {
  width: 100%;
}

.space-btn {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;

  padding: 8px 10px;

  background: var(--paper);
  border: 1px solid var(--rule);
  border-radius: 8px;

  cursor: pointer;
  text-align: left;

  transition: border-color 0.15s ease, background 0.15s ease;
}

.space-btn:hover {
  background: var(--brand-wash);
  border-color: var(--brand-line);
}

.space-btn:disabled {
  cursor: progress;
  opacity: 0.7;
}

.space-icon {
  flex-shrink: 0;
  width: 26px;
  height: 26px;

  display: flex;
  align-items: center;
  justify-content: center;

  border-radius: 6px;
  font-size: 12px;
  font-weight: 700;
  line-height: 1;
}

.space-icon.is-company {
  color: #fff;
  background: var(--brand);
}

.space-icon.is-personal {
  color: var(--brand-deep);
  background: var(--brand-wash);
  border: 1px solid var(--brand-line);
}

.space-text {
  flex: 1;
  min-width: 0;

  display: flex;
  flex-direction: column;
  gap: 1px;
}

.space-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);

  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.space-meta {
  font-size: 11px;
  color: var(--ink-3);
}

.space-caret {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--ink-3);
}

/* 下拉项：两行排版，名字在上、类型与人数在下 */
.opt {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 2px 0;
}

.opt-name {
  font-size: 13px;
  color: var(--ink);
}

.opt-now {
  margin-left: 6px;
  padding: 0 5px;

  font-size: 10px;
  font-style: normal;
  color: var(--brand-deep);

  background: var(--brand-wash);
  border-radius: 3px;
}

.opt-meta {
  font-size: 11px;
  color: var(--ink-3);
}
</style>
