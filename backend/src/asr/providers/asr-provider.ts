/** 转写通道的统一接口。 */
export interface AsrSubmitResult {
  /** 服务商侧任务 id，用于后续轮询 */
  taskId: string;
}

export interface AsrPollResult {
  status: 'running' | 'done' | 'failed';
  /** 成功时的转写文本 */
  text?: string;
  /** 音频时长（秒） */
  durationSec?: number;
  /** 失败原因 */
  error?: string;
}

/**
 * 转写服务商适配层。
 *
 * 业务层只认这个接口：换阿里 / 讯飞 / 自建 Whisper 时不用改 service，
 * 也不用在数据库里区分「这场会议是哪个厂商转的」之外的东西。
 */
export interface AsrProvider {
  /** 记录到 asr_jobs.provider，便于排查是哪条通道出的结果 */
  readonly name: string;

  /** 提交一个可公网访问的音频地址 */
  submit(url: string, format: string): Promise<AsrSubmitResult>;

  /** 轮询结果；服务商报错时返回 failed 而不是抛异常，避免任务卡在 RUNNING */
  poll(taskId: string): Promise<AsrPollResult>;
}
