<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  generateMeeting,
  type MeetingResult,
} from '../api/meeting'
import MeetingResultComponent from '../components/MeetingResult.vue'

// 输入框、当前纪要结果和提交状态共同驱动生成页的交互反馈。
const meetingContent = ref('')

const result = ref<MeetingResult | null>(null)

const loading = ref(false)

/** 校验文本后调用生成接口，并将请求状态和结果反馈到页面。 */
const handleGenerate = async () => {
  if (!meetingContent.value.trim()) {
    ElMessage.warning('请输入会议内容')
    return
  }

  loading.value = true

  try {
    result.value = await generateMeeting({
      content: meetingContent.value,
    })

    ElMessage.success('会议纪要生成成功')
  } catch (error) {
    console.error(error)

    ElMessage.error(
      '会议纪要生成失败，请检查后端服务是否启动'
    )
  } finally {
    loading.value = false
  }
}

/** 清空输入和当前结果，恢复初始页面状态。 */
const handleClear = () => {
  meetingContent.value = ''
  result.value = null
}
</script>

<template>
  <div class="home-page">
    <div class="page-container">

      <!-- 页面标题 -->
      <div class="page-header">
        <div>
          <h1>智能会议纪要</h1>

          <p>
            输入会议内容，让 AI 自动提取摘要、决策和待办事项
          </p>
        </div>
      </div>

      <!-- 输入区域 -->
      <el-card
        class="input-card"
        shadow="never"
      >
        <template #header>
          <div class="card-header">
            <span>会议内容</span>

            <el-button
              text
              :disabled="loading"
              @click="handleClear"
            >
              清空
            </el-button>
          </div>
        </template>

        <el-input
          v-model="meetingContent"
          type="textarea"
          :rows="12"
          resize="none"
          placeholder="请输入会议内容，例如：

今天下午召开产品需求讨论会。

张三负责完成首页 UI 设计，本周五之前提交。
李四负责开发用户登录接口，下周一完成。
大家决定第一版产品先支持邮箱登录。
产品经理要求下周三进行第一次内部测试。"
          maxlength="10000"
          show-word-limit
        />

        <div class="input-footer">
          <span class="tip">
            AI 将自动分析会议内容并生成结构化纪要
          </span>

          <el-button
            type="primary"
            size="large"
            :loading="loading"
            @click="handleGenerate"
          >
            <span v-if="!loading">
              生成会议纪要
            </span>

            <span v-else>
              AI 正在分析...
            </span>
          </el-button>
        </div>
      </el-card>

      <!-- AI 结果 -->
      <div
        v-if="result"
        class="result-wrapper"
      >
        <div class="result-header">
          <div>
            <h2>AI 分析结果</h2>

            <p>
              以下内容由 AI 根据会议记录自动整理
            </p>
          </div>
        </div>

        <MeetingResultComponent
          :result="result"
        />
      </div>

      <!-- 空状态 -->
      <div
        v-else-if="!loading"
        class="empty-state"
      >
        <div class="empty-icon">
          AI
        </div>

        <h3>
          等待生成会议纪要
        </h3>

        <p>
          在上方输入会议内容，然后点击生成按钮
        </p>
      </div>

    </div>
  </div>
</template>

<style scoped>
.home-page {
  min-height: calc(100vh - 64px);
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
  margin: 0 0 8px;
  font-size: 30px;
  font-weight: 600;
  color: #303133;
}

.page-header p {
  margin: 0;
  color: #909399;
  font-size: 14px;
}

.input-card {
  border-radius: 12px;
  border: 1px solid #ebeef5;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 600;
}

.input-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 18px;
}

.tip {
  color: #909399;
  font-size: 13px;
}

.result-wrapper {
  margin-top: 32px;
}

.result-header {
  margin-bottom: 18px;
}

.result-header h2 {
  margin: 0 0 6px;
  font-size: 22px;
  color: #303133;
}

.result-header p {
  margin: 0;
  color: #909399;
  font-size: 14px;
}

.empty-state {
  margin-top: 30px;
  padding: 60px 20px;
  background: #ffffff;
  border-radius: 12px;
  text-align: center;
  border: 1px solid #ebeef5;
}

.empty-icon {
  font-size: 48px;
  margin-bottom: 16px;
  font-weight: 700;
}

.empty-state h3 {
  margin: 0 0 8px;
  color: #606266;
}

.empty-state p {
  margin: 0;
  color: #909399;
}

@media (max-width: 768px) {
  .home-page {
    padding: 24px 12px 40px;
  }

  .page-header h1 {
    font-size: 24px;
  }

  .input-footer {
    flex-direction: column;
    align-items: stretch;
    gap: 14px;
  }

  .input-footer .el-button {
    width: 100%;
  }
}
</style>
