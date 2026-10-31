/**
 * 会议平台适配层。
 *
 * 业务层（meetings.service / webhook 处理）只依赖这个接口：
 * 以后接飞书、钉钉、Zoom 时新增一个实现即可，不用改业务代码，
 * 也不用在数据库里区分厂商 —— `meetings.source_platform` 已经记了来源。
 *
 * 照项目里 asr/providers 的做法：接口 + 多实现 + 工厂，而不是在 service 里 if/else。
 */

/** 平台会议的统一视图（各厂商字段差异在实现里抹平） */
export interface PlatformMeeting {
  /** 平台侧会议 ID，存进 meetings.external_id */
  externalId: string;
  /** 会议号：给人念的那串数字 */
  code: string;
  /** 入会链接 */
  joinUrl: string;
  title: string;
  startAt: Date;
  endAt: Date;
  /** 平台侧主持人 ID（腾讯的 userid） */
  hostUserId?: string;
}

/** 云录制文件 */
export interface PlatformRecording {
  /** 平台侧录制 ID，用于去重 */
  externalId: string;
  /** 带时效签名的下载地址；拿到后应尽快下载，不要长期保存这个 URL */
  downloadUrl: string;
  /** 字节数，用来做容量保护 */
  size: number;
  durationSec?: number;
  startAt?: Date;
}

export interface CreatePlatformMeetingInput {
  title: string;
  startAt: Date;
  endAt: Date;
  /** 平台侧主持人；不传时用配置里的默认主持人 */
  hostUserId?: string;
}

/**
 * 会议平台能力。
 *
 * 刻意只包含「双向接入真正用到」的四个动作：
 * 建会、查会、取消、拉录制。参与者管理、会中控制不在这里 ——
 * 没有明确业务场景的接口先不定义，避免做成一层永远没人调的抽象。
 */
export interface MeetingPlatformProvider {
  /** 写进 meetings.source_platform，例如 tencent */
  readonly name: string;

  /**
   * 凭据是否就绪。
   *
   * 未就绪时业务层直接跳过同步并给出提示，而不是抛异常 ——
   * 「还没配腾讯会议」是正常状态，不该让用户建会失败。
   */
  readonly enabled: boolean;

  createMeeting(input: CreatePlatformMeetingInput): Promise<PlatformMeeting>;

  /** 查不到时返回 null，而不是抛异常（会议可能已被删） */
  getMeeting(externalId: string): Promise<PlatformMeeting | null>;

  cancelMeeting(externalId: string): Promise<void>;

  /** 没有录制时返回空数组 */
  listRecordings(externalId: string): Promise<PlatformRecording[]>;
}
