import api from './http'

/** 转写任务状态 */
export type AsrStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'

export interface AsrJob {
  id: number
  filename: string
  sizeBytes: number
  status: AsrStatus
  transcript: string | null
  durationSec: number | null
  error: string | null
  /** mock 表示当前用的是本地占位通道，不是真实转写 */
  provider: string
  /** 带签名的文件地址，可直接试听；一小时后过期 */
  fileUrl: string | null
  createdAt: string
}

/**
 * 上传录音 / 会议文件，创建转写任务。
 *
 * 用 FormData 直传：文件走 multipart，后端落盘后立刻返回任务，
 * 转写在服务端后台跑，前端轮询 getAsrJob。
 */
export const uploadAsrJob = async (
  file: File,
  onProgress?: (percent: number) => void
): Promise<AsrJob> => {
  const form = new FormData()
  form.append('file', file)

  const response = await api.post<AsrJob>('/asr/jobs', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    // 大文件上传慢，给足 10 分钟；服务端本身是异步转写，不等结果
    timeout: 10 * 60 * 1000,
    onUploadProgress: (event) => {
      if (!onProgress || !event.total) return
      onProgress(Math.round((event.loaded / event.total) * 100))
    }
  })

  return response.data
}

export const listAsrJobs = async (): Promise<AsrJob[]> => {
  const response = await api.get<AsrJob[]>('/asr/jobs')

  return response.data
}

export const getAsrJob = async (id: number): Promise<AsrJob> => {
  const response = await api.get<AsrJob>(`/asr/jobs/${id}`)

  return response.data
}

export const deleteAsrJob = async (id: number): Promise<void> => {
  await api.delete(`/asr/jobs/${id}`)
}
