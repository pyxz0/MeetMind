import { Injectable } from '@nestjs/common';
import type {
  CreatePlatformMeetingInput,
  MeetingPlatformProvider,
  PlatformMeeting,
  PlatformRecording,
} from '../platform-provider';

/**
 * 未接入任何会议平台时的占位实现。
 *
 * 存在的意义是让依赖注入始终有东西可注入，业务层只需判断 `enabled`
 * 就能给出「还没配置腾讯会议」的提示，而不用到处写可选注入。
 */
@Injectable()
export class DisabledPlatformProvider implements MeetingPlatformProvider {
  readonly name = 'off';
  readonly enabled = false;

  private reject(): never {
    throw new Error('尚未接入会议平台，请在环境变量中配置 MEETING_PLATFORM');
  }

  async createMeeting(
    _input: CreatePlatformMeetingInput,
  ): Promise<PlatformMeeting> {
    return this.reject();
  }

  async getMeeting(_externalId: string): Promise<PlatformMeeting | null> {
    return this.reject();
  }

  async cancelMeeting(_externalId: string): Promise<void> {
    return this.reject();
  }

  async listRecordings(_externalId: string): Promise<PlatformRecording[]> {
    return this.reject();
  }
}
