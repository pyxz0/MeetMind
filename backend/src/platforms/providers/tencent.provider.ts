import { Injectable, Logger } from '@nestjs/common';
import axios, { type AxiosInstance } from 'axios';
import { buildAuthHeaders } from '../tencent-signature';
import type {
  CreatePlatformMeetingInput,
  MeetingPlatformProvider,
  PlatformMeeting,
  PlatformRecording,
} from '../platform-provider';

/** 腾讯会议 API 基址 */
const BASE_URL = 'https://api.meeting.qq.com';

/**
 * 接口路径。
 *
 * 集中放在这里、标明来源，是因为拿到凭据联调时最可能改的就是它们：
 * 字段名和路径一旦对不上，表现是「签名成功但 400 参数错误」，
 * 分散在方法里很难快速定位。
 *
 * ⚠️ 以下路径按官方文档整理，尚未与真实环境联调过（本项目目前没有凭据）。
 * 联调时请对照 https://meeting.tencent.com/support-doc-detail/ 核对。
 */
const PATHS = {
  createMeeting: '/v1/meetings',
  getMeeting: (meetingId: string) => `/v1/meetings/${meetingId}`,
  cancelMeeting: (meetingId: string) => `/v1/meetings/${meetingId}/cancel`,
  listRecords: '/v1/records',
} as const;

/** 腾讯要求 ISO8601 带时区；统一按 UTC+8 输出，避免服务器时区影响 */
const toTencentTime = (value: Date): string => {
  const shifted = new Date(value.getTime() + 8 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');

  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}+08:00`
  );
};

/**
 * 把响应里的 unknown 收窄成字符串。
 *
 * 不能直接 `String(value)`：接口字段是 unknown，万一返回对象，
 * `String({})` 会得到 "[object Object]" 然后被当成会议 ID 存进库，
 * 排查起来非常费劲。只认字符串与有限数字，其它一律当空。
 */
const asText = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return '';
};

interface TencentEnvelope {
  error_info?: { error_code?: number; message?: string };
  [key: string]: unknown;
}

/**
 * 腾讯会议企业自建应用（AK/SK）。
 *
 * 签名细节见 `tencent-signature.ts`：那里是纯函数、有单测；
 * 这里只负责把签名塞进请求头、把厂商字段映射成统一视图。
 */
@Injectable()
export class TencentPlatformProvider implements MeetingPlatformProvider {
  readonly name = 'tencent';

  private readonly logger = new Logger(TencentPlatformProvider.name);
  private readonly http: AxiosInstance;
  private readonly appId: string;
  private readonly sdkId?: string;
  private readonly secretId: string;
  private readonly secretKey: string;
  /** 默认主持人：企业内的一个 userid，应用代它建会 */
  private readonly hostUserId: string;

  constructor() {
    this.appId = process.env.TENCENT_MEETING_APP_ID?.trim() ?? '';
    this.sdkId = process.env.TENCENT_MEETING_SDK_ID?.trim();
    this.secretId = process.env.TENCENT_MEETING_SECRET_ID?.trim() ?? '';
    this.secretKey = process.env.TENCENT_MEETING_SECRET_KEY?.trim() ?? '';
    this.hostUserId = process.env.TENCENT_MEETING_USER_ID?.trim() ?? '';

    this.http = axios.create({ baseURL: BASE_URL, timeout: 15_000 });
  }

  /** 四个配置缺一不可：没有主持人就建不了会 */
  get enabled(): boolean {
    return Boolean(
      this.appId && this.secretId && this.secretKey && this.hostUserId,
    );
  }

  async createMeeting(
    input: CreatePlatformMeetingInput,
  ): Promise<PlatformMeeting> {
    const data = await this.request<TencentEnvelope>(
      'POST',
      PATHS.createMeeting,
      {
        userid: input.hostUserId ?? this.hostUserId,
        instanceid: 1,
        subject: input.title,
        type: 0,
        start_time: toTencentTime(input.startAt),
        end_time: toTencentTime(input.endAt),
        /**
         * 云录制默认开启。
         * 会后自动成纪要依赖录制文件，让用户每次手动点「录制」不现实。
         */
        settings: { auto_record_type: 'cloud' },
      },
    );

    const meetingId = asText(data.meeting_id);
    const meetingCode = asText(data.meeting_number);

    if (!meetingId) {
      throw new Error('腾讯会议未返回 meeting_id，请检查应用权限');
    }

    return {
      externalId: meetingId,
      code: meetingCode,
      joinUrl: asText(data.join_url),
      title: asText(data.subject) || input.title,
      startAt: input.startAt,
      endAt: input.endAt,
      hostUserId: asText(data.userid) || this.hostUserId,
    };
  }

  async getMeeting(externalId: string): Promise<PlatformMeeting | null> {
    try {
      const data = await this.request<TencentEnvelope>(
        'GET',
        `${PATHS.getMeeting(externalId)}?userid=${encodeURIComponent(
          this.hostUserId,
        )}&instanceid=1`,
      );

      if (!data.meeting_number && !data.meeting_id) {
        return null;
      }

      return {
        externalId: asText(data.meeting_id) || externalId,
        code: asText(data.meeting_number),
        joinUrl: asText(data.join_url),
        title: asText(data.subject),
        startAt: new Date(asText(data.start_time) || Date.now()),
        endAt: new Date(asText(data.end_time) || Date.now()),
        hostUserId: asText(data.userid) || this.hostUserId,
      };
    } catch (error) {
      // 会议被删掉是正常情况，不当成故障
      if (this.isNotFound(error)) {
        return null;
      }

      throw error;
    }
  }

  async cancelMeeting(externalId: string): Promise<void> {
    await this.request('POST', PATHS.cancelMeeting(externalId), {
      userid: this.hostUserId,
      instanceid: 1,
      // 1 = 取消会议（腾讯的 reason_code 枚举）
      reason_code: 1,
      reason_detail: '在 MeetMind 中取消了这场会议',
    });
  }

  async listRecordings(externalId: string): Promise<PlatformRecording[]> {
    const data = await this.request<TencentEnvelope>(
      'GET',
      `${PATHS.listRecords}?userid=${encodeURIComponent(
        this.hostUserId,
      )}&instanceid=1&meeting_id=${encodeURIComponent(externalId)}`,
    );

    /**
     * 腾讯把录制挂在「一场会议」下面，一个会议可能有多段文件。
     * 这里摊平成数组，业务层只关心「有哪些文件可下载」。
     */
    const meetings = (data.record_meetings ?? []) as Array<{
      recording_files?: Array<{
        record_file_id?: string;
        download_url?: string;
        file_size?: number;
        record_start_time?: string;
      }>;
    }>;

    const files = meetings.flatMap((meeting) => meeting.recording_files ?? []);

    return files
      .filter((file) => !!file.download_url)
      .map((file) => ({
        externalId: asText(file.record_file_id),
        downloadUrl: asText(file.download_url),
        size: typeof file.file_size === 'number' ? file.file_size : 0,
        startAt: file.record_start_time
          ? new Date(file.record_start_time)
          : undefined,
      }));
  }

  /* =========================================================
     内部
     ========================================================= */

  private async request<T>(
    method: 'GET' | 'POST',
    uri: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    /**
     * 参与签名的 body 必须是**实际发送的那串字符**。
     * 交给 axios 序列化 object 会得到无法预知的顺序，签名就对不上，
     * 所以这里手动 stringify 并把字符串作为 data 发出去。
     */
    const payload = body ? JSON.stringify(body) : '';

    const headers = buildAuthHeaders({
      secretId: this.secretId,
      secretKey: this.secretKey,
      appId: this.appId,
      sdkId: this.sdkId,
      method,
      uri,
      body: payload,
    });

    const response = await this.http.request<T>({
      method,
      url: uri,
      headers,
      data: payload || undefined,
    });

    const data = response.data as TencentEnvelope;
    const code = data?.error_info?.error_code;

    if (code && code !== 0) {
      const message = data.error_info?.message ?? '未知错误';

      this.logger.error(`腾讯会议 API 失败 ${code}: ${message}`);

      throw new Error(`腾讯会议接口返回错误 ${code}：${message}`);
    }

    return response.data;
  }

  private isNotFound(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);

    return /错误\s*90\d+|not\s*found|meeting.*not.*exist/i.test(message);
  }
}
