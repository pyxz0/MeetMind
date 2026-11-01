import api from './http'

/**
 * 后台任务概况。
 *
 * 这四个任务都在进程内定时器里跑，失败只写日志 ——
 * 这个接口是把「到底有没有在干活」暴露出来的唯一途径。
 */
export interface JobOverview {
  key: string
  label: string
  /** 人类可读的频率，例如「每分钟」 */
  interval: string
  /** 最后一次执行时间；服务刚启动时为空 */
  lastRunAt: string | null
  lastStatus: 'OK' | 'FAILED' | null
  /** 上次实际处理了多少条 */
  lastAffected: number
  lastDurationMs: number
  lastError: string | null
  /** 上次是主动跳过的（例如未配置 SMTP），与「没执行」不是一回事 */
  skipped: boolean
  /** 近 24 小时有动作的次数 / 失败次数 */
  runs24h: number
  failures24h: number
  lastFailureAt: string | null
  /** 超过预期周期没有执行，定时器可能停了 */
  stale: boolean
}

export const getSystemJobs = async (): Promise<JobOverview[]> => {
  const response = await api.get<{ jobs: JobOverview[] }>('/system/jobs')

  return response.data.jobs
}
