import type {
  MeetingAccess,
  MeetingCapabilities,
} from './meetings.access';

/** 负责人 / 成员的简要信息 */
export interface UserBrief {
  id: number;
  name: string;
  phone: string;
}

/** 列表条目需要的字段（不含决策、待办明细） */
export interface MeetingSummarySource {
  id: number;
  title: string;
  summary: string | null;
  completionStatus: string;
  status: string;
  scheduledAt: Date | null;
  pinnedAt: Date | null;
  createdAt: Date;
  ownerId: number;
  audioOpen: boolean;
  /** 来源平台；为空表示 MeetMind 自建 */
  sourcePlatform?: string | null;
  /** 平台侧会议 ID */
  externalId?: string | null;
  /** 入会链接 */
  externalJoinUrl?: string | null;
  /** 会议号 */
  externalCode?: string | null;
  leaders?: Array<{ user: UserBrief }>;
  members?: Array<{ user: UserBrief }>;
  shares?: Array<{ permission: 'READ' | 'EDIT' }>;
  _count?: { decisions: number; todos: number };
}

/**
 * 列表项：只带渲染列表所需的信息。
 *
 * 明确不返回 decisions / todos 明细 —— 列表页不展示它们，
 * 一次性查出所有会议的决策与待办会让负载随数据量线性膨胀。
 * 明细由详情接口 GET /meetings/:id 提供。
 */
export function mapMeetingSummary(
  meeting: MeetingSummarySource,
  access: MeetingAccess,
  capabilities: MeetingCapabilities,
) {
  return {
    id: meeting.id,
    title: meeting.title,
    summary: meeting.summary ?? '',
    completionStatus: meeting.completionStatus,
    scheduledAt: meeting.scheduledAt?.toISOString() ?? null,
    pinnedAt: meeting.pinnedAt?.toISOString() ?? null,
    isDraft: meeting.status === 'FAILED' || meeting.status === 'DRAFT',
    createdAt: meeting.createdAt.toISOString(),

    // 会议来源：前端据此显示「腾讯会议」标识与入会链接
    sourcePlatform: meeting.sourcePlatform ?? null,
    externalId: meeting.externalId ?? null,
    externalJoinUrl: meeting.externalJoinUrl ?? null,
    externalCode: meeting.externalCode ?? null,

    // 数量代替明细，前端列表只需展示"3 条待办"这类信息
    todoCount: meeting._count?.todos ?? 0,
    decisionCount: meeting._count?.decisions ?? 0,

    ownerId: meeting.ownerId,
    access,
    ...capabilities,
  };
}