import { Inject, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../common/prisma.service';
import { MeetingAudioService } from '../meetings/meeting-audio.service';
import {
  PLATFORM_PROVIDER,
} from './platform-core.module';
import type { MeetingPlatformProvider } from './platform-provider';

/** 单段录制的大小上限，与手动上传保持同一口径 */
const MAX_RECORDING_BYTES = 200 * 1024 * 1024;

/** 平台事件在库里的状态 */
type EventStatus = 'PROCESSED' | 'IGNORED' | 'FAILED';

interface DispatchResult {
  status: EventStatus;
  meetingId: number | null;
}

/**
 * 平台回调事件的处理。
 *
 * 分两步走：
 * 1. 收到就落库，立刻返回 200（腾讯要求 3 秒内响应，拉录制要几十秒）
 * 2. 后台按事件类型处理，失败写回 error，可以手动重放
 */
@Injectable()
export class PlatformEventService {
  private readonly logger = new Logger(PlatformEventService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audio: MeetingAudioService,
    @Inject(PLATFORM_PROVIDER)
    private readonly platform: MeetingPlatformProvider,
  ) {}

  /**
   * 入库并触发处理。
   *
   * 返回 duplicated=true 表示这条事件之前推过（腾讯没收到 200 会重推），
   * 直接忽略即可 —— 幂等靠 (platform, external_event_id) 唯一索引。
   */
  async ingest(input: {
    platform: string;
    eventType: string;
    externalEventId: string;
    payload: unknown;
  }): Promise<{ id: number; duplicated: boolean }> {
    try {
      const created = await this.prisma.platformEvent.create({
        data: {
          platform: input.platform,
          eventType: input.eventType,
          externalEventId: input.externalEventId,
          payload: input.payload as object,
        },
        select: { id: true },
      });

      // 不 await：处理耗时不能拖住回调响应
      void this.process(created.id).catch((error) => {
        this.logger.error(
          `事件 ${created.id} 后台处理异常`,
          error instanceof Error ? error.stack : String(error),
        );
      });

      return { id: created.id, duplicated: false };
    } catch (error) {
      if (this.isDuplicate(error)) {
        this.logger.debug(
          `重复推送已忽略：${input.platform}/${input.externalEventId}`,
        );

        return { id: 0, duplicated: true };
      }

      throw error;
    }
  }

  /** 处理单条事件；失败只标记自己，不影响其它事件 */
  async process(eventId: number) {
    const event = await this.prisma.platformEvent.findUnique({
      where: { id: eventId },
      select: { id: true, eventType: true, payload: true, status: true },
    });

    if (!event || event.status !== 'RECEIVED') {
      return;
    }

    try {
      const result = await this.dispatch(
        event.eventType,
        event.payload as Record<string, unknown>,
      );

      await this.prisma.platformEvent.update({
        where: { id: eventId },
        data: {
          status: result.status,
          meetingId: result.meetingId,
          error: null,
          processedAt: new Date(),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.warn(`事件 ${eventId}（${event.eventType}）处理失败：${message}`);

      await this.prisma.platformEvent.update({
        where: { id: eventId },
        data: {
          status: 'FAILED',
          error: message.slice(0, 2000),
          processedAt: new Date(),
        },
      });
    }
  }

  private async dispatch(
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<DispatchResult> {
    switch (eventType) {
      case 'meeting.created':
      case 'meeting.updated':
        return this.upsertMeeting(payload);

      case 'meeting.canceled':
        return this.markCanceled(payload);

      /**
       * 会议结束与录制完成都去拉一次录制。
       *
       * 云录制通常比会议结束晚几分钟才可用，所以两个事件都试一次；
       * 已下载过的会议会因为 audioUrl 已存在而跳过，不会重复下载。
       */
      case 'meeting.end':
      case 'recording.completed':
        return this.syncRecordings(payload);

      default:
        // 入会/离会这类事件暂不关心，记下来但不处理
        return { status: 'IGNORED', meetingId: null };
    }
  }

  /** 会议创建/更新：能找到就补信息，找不到按配置决定是否新建 */
  private async upsertMeeting(
    payload: Record<string, unknown>,
  ): Promise<DispatchResult> {
    const externalId = this.readString(payload, ['meeting_id', 'meetingId']);

    if (!externalId) {
      return { status: 'IGNORED', meetingId: null };
    }

    const title = this.readString(payload, ['subject', 'title']);
    const joinUrl = this.readString(payload, ['join_url', 'joinUrl']);
    const code = this.readString(payload, ['meeting_number', 'meetingNumber']);
    const startAt = this.readDate(payload, ['start_time', 'startTime']);

    /**
     * 按平台会议 ID 反查本地会议。
     *
     * 不限制 sourcePlatform：externalId 由平台侧生成（腾讯是十几位数字），
     * 跨平台撞号概率极低；而限制来源会把「mock 建的会」和「真实回调」
     * 割裂开，本地联调时永远匹配不上。
     */
    const existing = await this.prisma.meeting.findFirst({
      where: { externalId },
      select: { id: true },
    });

    if (existing) {
      await this.prisma.meeting.update({
        where: { id: existing.id },
        data: {
          ...(joinUrl && { externalJoinUrl: joinUrl }),
          ...(code && { externalCode: code }),
          // 标题只在本地还是默认值时覆盖，避免冲掉用户改过的名字
          ...(title && { title }),
          ...(startAt && { scheduledAt: startAt }),
        },
      });

      return { status: 'PROCESSED', meetingId: existing.id };
    }

    /**
     * 直接在腾讯会议里开的会，本地没有对应记录。
     *
     * 新建需要归属人；没配置归属人就不新建 ——
     * 否则会冒出一堆「没有负责人、没有成员」的孤儿会议，
     * 谁都看不到（数据隔离按 owner 判），只是白白占库。
     */
    const ownerId = await this.resolveOwnerId();

    if (!ownerId) {
      this.logger.warn(
        `收到未关联的腾讯会议 ${externalId}，但未配置 TENCENT_MEETING_OWNER_PHONE，跳过新建`,
      );

      return { status: 'IGNORED', meetingId: null };
    }

    const created = await this.prisma.meeting.create({
      data: {
        title: title || '腾讯会议',
        content: '',
        summary: null,
        status: 'DRAFT',
        ownerId,
        leaders: { create: [{ userId: ownerId }] },
        sourcePlatform: 'tencent',
        externalId,
        externalJoinUrl: joinUrl || null,
        externalCode: code || null,
        scheduledAt: startAt ?? null,
      },
      select: { id: true },
    });

    this.logger.log(`已从腾讯会议新建会议 ${created.id}（${externalId}）`);

    return { status: 'PROCESSED', meetingId: created.id };
  }

  private async markCanceled(
    payload: Record<string, unknown>,
  ): Promise<DispatchResult> {
    const meetingId = await this.findMeetingId(payload);

    if (!meetingId) {
      return { status: 'IGNORED', meetingId: null };
    }

    await this.prisma.meeting.update({
      where: { id: meetingId },
      data: { completionStatus: 'CANCELLED' },
    });

    return { status: 'PROCESSED', meetingId };
  }

  /** 拉云录制并落到本地，复用现有的录音存储与鉴权播放 */
  private async syncRecordings(
    payload: Record<string, unknown>,
  ): Promise<DispatchResult> {
    const meetingId = await this.findMeetingId(payload);

    if (!meetingId) {
      return { status: 'IGNORED', meetingId: null };
    }

    if (!this.platform.enabled) {
      // 没有凭据时无法调 API 拿下载地址，事件保留下来等配置好再重放
      return { status: 'IGNORED', meetingId };
    }

    const meeting = await this.prisma.meeting.findUnique({
      where: { id: meetingId },
      select: { externalId: true, audioUrl: true },
    });

    if (!meeting?.externalId) {
      return { status: 'IGNORED', meetingId };
    }

    // 已经存过录音就不再覆盖：可能是用户手动传了更好的版本
    if (meeting.audioUrl) {
      return { status: 'PROCESSED', meetingId };
    }

    const recordings = await this.platform.listRecordings(meeting.externalId);

    if (!recordings.length) {
      this.logger.log(`会议 ${meetingId} 暂无云录制`);
      return { status: 'PROCESSED', meetingId };
    }

    // 多段录制时取最大的一段：整段拼接需要转码，不在这一版的范围内
    const target = recordings.reduce((max, item) =>
      item.size > max.size ? item : max,
    );

    if (target.size > MAX_RECORDING_BYTES) {
      this.logger.warn(
        `会议 ${meetingId} 的录制 ${target.size} 字节超过上限，跳过下载`,
      );

      return { status: 'IGNORED', meetingId };
    }

    const response = await axios.get<ArrayBuffer>(target.downloadUrl, {
      responseType: 'arraybuffer',
      timeout: 5 * 60 * 1000,
      maxContentLength: MAX_RECORDING_BYTES,
    });

    await this.audio.saveAudio(
      meetingId,
      {
        buffer: Buffer.from(response.data),
        // 腾讯云录制一般是 mp4（含音轨），浏览器 <audio> 可直接播放
        mimetype: 'video/mp4',
        originalname: 'tencent-recording.mp4',
      },
      target.durationSec,
    );

    this.logger.log(`会议 ${meetingId} 已保存云录制（${target.size} 字节）`);

    return { status: 'PROCESSED', meetingId };
  }

  /* =========================================================
     小工具
     ========================================================= */

  private async findMeetingId(
    payload: Record<string, unknown>,
  ): Promise<number | null> {
    const externalId = this.readString(payload, ['meeting_id', 'meetingId']);

    if (!externalId) {
      return null;
    }

    const meeting = await this.prisma.meeting.findFirst({
      where: { externalId },
      select: { id: true },
    });

    return meeting?.id ?? null;
  }

  /** 归属人：配置的手机号；用于接收「直接在腾讯会议开的会」 */
  private async resolveOwnerId(): Promise<number | null> {
    const phone = process.env.TENCENT_MEETING_OWNER_PHONE?.trim();

    if (!phone) {
      return null;
    }

    const user = await this.prisma.user.findUnique({
      where: { phone },
      select: { id: true, isActive: true },
    });

    return user?.isActive ? user.id : null;
  }

  /** 不同事件的字段名不完全一致，按候选列表取第一个有效值 */
  private readString(
    payload: Record<string, unknown>,
    keys: string[],
  ): string {
    for (const key of keys) {
      const value = payload[key];

      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }

      if (typeof value === 'number') {
        return String(value);
      }
    }

    return '';
  }

  private readDate(
    payload: Record<string, unknown>,
    keys: string[],
  ): Date | null {
    const raw = this.readString(payload, keys);

    if (!raw) {
      return null;
    }

    const parsed = new Date(raw);

    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private isDuplicate(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: string }).code === 'P2002'
    );
  }
}
