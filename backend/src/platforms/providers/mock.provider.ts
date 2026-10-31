import { Injectable, Logger } from '@nestjs/common';
import type {
  CreatePlatformMeetingInput,
  MeetingPlatformProvider,
  PlatformMeeting,
  PlatformRecording,
} from '../platform-provider';

/**
 * 假平台，用于没有腾讯会议凭据时把链路跑通。
 *
 * 只有显式设置 `MEETING_PLATFORM=mock` 才会启用 ——
 * 绝不作为「没配置时的默认值」，否则线上会建出一堆假会议，
 * 用户以为约好了会，实际什么都没有。
 */
@Injectable()
export class MockPlatformProvider implements MeetingPlatformProvider {
  readonly name = 'mock';
  readonly enabled = true;

  private readonly logger = new Logger(MockPlatformProvider.name);
  private readonly meetings = new Map<string, PlatformMeeting>();
  private readonly recordings = new Map<string, PlatformRecording[]>();
  private seq = 100_000_000;

  async createMeeting(
    input: CreatePlatformMeetingInput,
  ): Promise<PlatformMeeting> {
    this.seq += 1;

    const meeting: PlatformMeeting = {
      externalId: String(this.seq),
      code: String(this.seq).slice(0, 9),
      // 带 MOCK 前缀，界面上一眼能看出这是假的
      joinUrl: `https://meeting.tencent.com/dm/MOCK-${this.seq}`,
      title: input.title,
      startAt: input.startAt,
      endAt: input.endAt,
      hostUserId: input.hostUserId ?? 'mock-host',
    };

    this.meetings.set(meeting.externalId, meeting);

    this.logger.log(
      `[mock] 创建会议 ${meeting.externalId}「${meeting.title}」`,
    );

    return meeting;
  }

  async getMeeting(externalId: string): Promise<PlatformMeeting | null> {
    return this.meetings.get(externalId) ?? null;
  }

  async cancelMeeting(externalId: string): Promise<void> {
    this.meetings.delete(externalId);
  }

  async listRecordings(externalId: string): Promise<PlatformRecording[]> {
    return this.recordings.get(externalId) ?? [];
  }

  /** 仅测试用：给某场会议挂一条假录制 */
  attachRecording(externalId: string, recording: PlatformRecording) {
    const list = this.recordings.get(externalId) ?? [];

    list.push(recording);
    this.recordings.set(externalId, list);
  }
}
