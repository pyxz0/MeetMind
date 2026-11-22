import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Inject,
  Logger,
} from '@nestjs/common';
import {
  Meeting,
  Prisma,
  TodoStatus,
  MeetingCompletionStatus,
} from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { isOverdue, parseDeadlineAt } from './deadline';
import { resolveCompletionStatus } from './todo-completion';
import { visibleMeetingScope } from './meetings.scope';
import { TodosService } from './todos.service';
import { collectHits, type SearchHit } from './search';
import {
  normalizeJoinUrl,
  normalizeMeetingCode,
  parseJoinInput,
} from './link';
import { mapMeetingSummary } from './meeting.mapper';
import { buildMeetingMarkdown, markdownFilename } from './meeting-markdown';
import { MeetingAudioService } from './meeting-audio.service';
import { AuditService } from '../audit/audit.service';
import { PLATFORM_PROVIDER } from '../platforms/platform-core.module';
import type { MeetingPlatformProvider } from '../platforms/platform-provider';
import type { AuthenticatedUser } from '../auth/auth.decorators';
import { PERMISSIONS, roleHasPermission } from '../auth/permissions';
import {
  assertCanManageMembers,
  assertCanOwn,
  assertCanRead,
  assertCanToggleAudio,
  assertCanWrite,
  computeMeetingCapabilities,
  hasGlobalMeetingAccess,
  type MeetingAccess,
  type MeetingCapabilities,
} from './meetings.access';

/** 是否具备「编辑任意会议」的全局权限 */
const roleHasUpdateAll = (role: AuthenticatedUser['role']) =>
  roleHasPermission(role, PERMISSIONS.MEETING_UPDATE_ALL);

/** 前端保存纪要时允许提交的字段；标题、决策和待办均可省略。 */
export interface CreateMeetingInput {
  title?: string;
  content: string;
  summary?: string | null;
  decisions?: string[];
  todos?: Array<{
    content: string;
    assignee?: string | null;
    /** 结构化负责人；AI 只给姓名，落库前按「唯一同名」解析 */
    assigneeUserId?: number | null;
    reviewerId?: number | null;
    deadline?: string | null;
    /** ISO 日期；解析不了的自然语言只保留 deadline 文本 */
    deadlineAt?: string | null;
  }>;
}

/** 截止日期解析放在 deadline.ts（纯函数、可单测），这里只负责调用 */

/**
 * 把「姓名文本」解析成唯一用户 ID。
 *
 * 只认唯一同名：重名一律返回 null，交人工指定 —— 现在的 includes 匹配
 * 会把「张三丰」认成「张三」，这是要修掉的核心问题，不能用同样的猜法替代。
 */
async function resolveUniqueUserIds(
  prisma: PrismaService,
  names: string[],
): Promise<Map<string, number>> {
  const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))];

  if (!unique.length) return new Map();

  const users = await prisma.user.findMany({
    where: { name: { in: unique }, isActive: true },
    select: { id: true, name: true },
  });

  const counts = new Map<string, number>();

  for (const user of users) {
    counts.set(user.name, (counts.get(user.name) ?? 0) + 1);
  }

  const result = new Map<string, number>();

  for (const user of users) {
    if (counts.get(user.name) === 1) {
      result.set(user.name, user.id);
    }
  }

  return result;
}

// 所有读取接口都按录入顺序返回决策和待办，避免数据库默认顺序不确定。
const meetingInclude = {
  decisions: { orderBy: { sortOrder: 'asc' as const } },
  todos: {
    orderBy: { sortOrder: 'asc' as const },
    include: {
      assigneeUser: { select: { id: true, name: true } },
      reviewer: { select: { id: true, name: true } },
      // 验收要点：勾选进度随待办一起返回，详情页不用再发一次请求
      checkItems: {
        orderBy: { sortOrder: 'asc' as const },
        select: {
          id: true,
          content: true,
          done: true,
          doneById: true,
          doneAt: true,
          doneBy: { select: { id: true, name: true } },
        },
      },
      /**
       * 只带最近一次提交。
       * 详情页只需要展示「待验收 / 被打回」，完整时间线走独立接口，
       * 否则每场会议的待办都会把全部历史提交查出来。
       */
      submissions: {
        orderBy: { createdAt: 'desc' as const },
        take: 1,
        select: {
          id: true,
          status: true,
          note: true,
          attemptNo: true,
          submitterId: true,
          reviewerId: true,
          rejectReason: true,
          reviewedAt: true,
          createdAt: true,
          submitter: { select: { id: true, name: true } },
          _count: { select: { attachments: true } },
        },
      },
    },
  },
  // 负责人（可多位）与成员随会议一起返回
  leaders: {
    select: { user: { select: { id: true, name: true, phone: true } } },
    orderBy: { createdAt: 'asc' as const },
  },
  members: {
    select: { user: { select: { id: true, name: true, phone: true } } },
    orderBy: { createdAt: 'asc' as const },
  },
};

/**
 * 生成「只包含当前用户本人共享记录」的 include。
 *
 * 不能统一 include 全部 shares：那会把别人的授权也查出来，
 * 既浪费又容易误判当前用户的权限级别。
 */
const meetingIncludeFor = (userId: number) => ({
  ...meetingInclude,
  shares: {
    where: { userId },
    select: { permission: true },
  },
});

/** 负责人/成员统一取这三个字段 */
const USER_BRIEF_SELECT = { id: true, name: true, phone: true } as const;

/** 列表查询参数 */
export interface MeetingListQuery {
  page?: number;
  pageSize?: number;
  keyword?: string;
  status?: string;
  /** 起始日期 YYYY-MM-DD（按创建时间） */
  from?: string;
  /** 结束日期 YYYY-MM-DD（含当天） */
  to?: string;
  /** 只看置顶 */
  pinned?: boolean;
  /** 只看未开始的预约会议 */
  upcoming?: boolean;
  /** 创建时间排序方向 */
  sort?: 'newest' | 'oldest';
}

@Injectable()
export class MeetingsService {
  private readonly logger = new Logger(MeetingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audioService: MeetingAudioService,
    private readonly audit: AuditService,
    /** 待办逻辑已经拆到独立 service；删除会议时要清掉它的附件 */
    private readonly todos: TodosService,
    /** 会议平台适配层；未接入时是 DisabledPlatformProvider（enabled=false） */
    @Inject(PLATFORM_PROVIDER)
    private readonly platform: MeetingPlatformProvider,
  ) { }

  /** 创建会议并通过嵌套写入原文、摘要、决策和待办，保证一次提交完成。 */
  async create(input: CreateMeetingInput, user: AuthenticatedUser) {
    const todos = input.todos ?? [];

    /**
     * AI 只给「负责人姓名」，这里按唯一同名解析成 userId。
     * 重名不猜，留空由人工指定 —— 猜错比留空更难发现。
     */
    const nameToId = await resolveUniqueUserIds(
      this.prisma,
      todos.map((todo) => todo.assignee ?? ''),
    );

    const meeting = await this.prisma.meeting.create({
      data: {
        title: input.title?.trim() || '未命名会议',
        content: input.content,
        summary: input.summary ?? null,
        status: 'READY',
        // 归属者为当前登录用户，是数据隔离的依据
        ownerId: user.id,
        // 「每场会议至少一位负责人」：创建者默认成为首位负责人，后续可追加
        leaders: { create: [{ userId: user.id }] },
        audioOpen: true,
        decisions: {
          create: (input.decisions ?? []).map((content, sortOrder) => ({
            content,
            sortOrder,
          })),
        },
        todos: {
          create: todos.map((todo, sortOrder) => ({
            content: todo.content,
            /**
             * 姓名统一 trim 后落库。
             *
             * 收件箱的兜底匹配（assigneeUserId 为空时按姓名精确比对）
             * 依赖这个干净值；AI 提取时多一个空格，那条待办就永远
             * 不会出现在负责人的收件箱里。
             */
            assignee: todo.assignee?.trim() || null,
            assigneeUserId:
              todo.assigneeUserId ??
              (todo.assignee ? nameToId.get(todo.assignee.trim()) ?? null : null),
            reviewerId: todo.reviewerId ?? null,
            deadline: todo.deadline ?? null,
            deadlineAt: todo.deadlineAt
              ? parseDeadlineAt(todo.deadlineAt)
              : parseDeadlineAt(todo.deadline),
            sortOrder,
          })),
        },
      },
      include: meetingInclude,
    });

    /**
     * 嵌套写入不经过 syncMeetingCompletionStatus，
     * 所以要在这里按刚写入的待办补一次状态推算，
     * 否则“带着待办一起创建的会议”会一直停在 NOT_STARTED。
     */
    const completionStatus = resolveCompletionStatus(
      meeting.completionStatus,
      meeting.todos.map((todo) => todo.status),
    );

    const finalMeeting =
      completionStatus === meeting.completionStatus
        ? meeting
        : await this.prisma.meeting.update({
          where: { id: meeting.id },
          data: { completionStatus },
          include: meetingInclude,
        });

    /**
     * 统一走 toApiRecord：创建响应也要带能力位与负责人/成员字段，
     * 否则前端拿到的是缺字段的裸记录，与其它接口不一致。
     */
    return this.toApiRecord(
      finalMeeting,
      'owner',
      user,
      computeMeetingCapabilities({
        user,
        access: 'owner',
        audioOpen: finalMeeting.audioOpen,
      }),
    );
  }

  /**
   * 创建正式会议（预约会议）。
   *
   * 与临时会议的区别：有 scheduledAt，开会时间前 20 分钟内
   * 参会人员会在收件箱收到提醒。
   * 会议原文此时为空，开会后再补充或直接生成纪要。
   */
  async createScheduled(
    input: {
      title?: string;
      scheduledAt: string;
      leaderIds?: number[];
      memberIds?: number[];
      platform?: 'tencent';
      externalCode?: string;
      externalJoinUrl?: string;
      joinText?: string;
    },
    user: AuthenticatedUser,
  ) {
    const when = new Date(input.scheduledAt);

    if (Number.isNaN(when.getTime())) {
      throw new BadRequestException('开会时间格式不正确');
    }

    // 允许 1 分钟误差，避免刚选完时间点提交就被判过期
    if (when.getTime() < Date.now() - 60_000) {
      throw new BadRequestException('开会时间不能早于当前时间');
    }

    const leaderIds = this.normalizeIds(input.leaderIds);
    const memberIds = this.normalizeIds(input.memberIds);

    // 没有指定负责人时由创建者担任，保证「至少一位负责人」
    const finalLeaderIds = leaderIds.length ? leaderIds : [user.id];

    await this.assertUsersUsable([...finalLeaderIds, ...memberIds]);

    const title = input.title?.trim() || '未命名会议';

    /**
     * 用户手填的会议号/链接。
     *
     * 放在同步之前解析：格式不对要立刻报错，而不是等建完会议才发现。
     * joinText 是「整段粘贴」入口（微信邀请文本），优先于两个分项字段。
     */
    const manual =
      input.joinText !== undefined
        ? parseJoinInput(input.joinText)
        : {
            code: normalizeMeetingCode(input.externalCode),
            joinUrl: normalizeJoinUrl(input.externalJoinUrl),
          };
    const manualCode = manual.code;
    const manualUrl = manual.joinUrl;

    /**
     * 会前同步到会议平台。
     *
     * 同步失败**不回滚**本地会议：时间和人已经定了，只是少一个入会入口，
     * 用户可以在腾讯会议里手动建。因为第三方挂了就把建会整个搞失败，
     * 是比「没有链接」更糟的体验。
     */
    let external: {
      externalId: string;
      externalJoinUrl: string;
      externalCode: string;
    } | null = null;
    let platformSyncError: string | undefined;

    if (input.platform === 'tencent') {
      if (!this.platform.enabled) {
        platformSyncError =
          '腾讯会议尚未配置，这场会只记在 MeetMind，没有入会链接';
      } else {
        try {
          const created = await this.platform.createMeeting({
            title,
            startAt: when,
            // 默认按 1 小时建会；会议表目前没有时长字段
            endAt: new Date(when.getTime() + 60 * 60 * 1000),
          });

          external = {
            externalId: created.externalId,
            externalJoinUrl: created.joinUrl,
            externalCode: created.code,
          };
        } catch (error) {
          platformSyncError =
            error instanceof Error ? error.message : '同步到腾讯会议失败';

          this.logger.warn(`会议同步失败：${platformSyncError}`);
        }
      }
    }

    const meeting = await this.prisma.meeting.create({
      data: {
        title,
        content: '',
        summary: null,
        status: 'READY',
        ownerId: user.id,
        scheduledAt: when,
        leaders: { create: finalLeaderIds.map((userId) => ({ userId })) },
        members: { create: memberIds.map((userId) => ({ userId })) },
        ...(external
          ? {
              // 只有接口建会才记来源与外部 ID；手填的不算「平台建的会议」
              sourcePlatform: this.platform.name,
              externalId: external.externalId,
              externalJoinUrl: external.externalJoinUrl,
              externalCode: external.externalCode,
            }
          : manualCode || manualUrl
            ? {
                externalJoinUrl: manualUrl,
                externalCode: manualCode,
              }
            : {}),
      },
      include: meetingInclude,
    });

    const record = this.toApiRecord(
      meeting,
      'owner',
      user,
      computeMeetingCapabilities({
        user,
        access: 'owner',
        audioOpen: meeting.audioOpen,
      }),
    );

    // 同步失败是「提示」不是「错误」：会议已经建好了
    return platformSyncError ? { ...record, platformSyncError } : record;
  }

  /**
   * 修改未开始会议的预约信息（标题、开会时间、负责人、成员）。
   *
   * 允许改全部内容的前提是「会议还没开始」：
   * 一旦到了开会时间，人员与时间再变会误导参会者，因此禁止。
   *
   * 修改成功后给「受影响的人 + 当前全部参会人员」发变更消息，
   * 被移出会议的人也会收到一条单独的告知。
   */
  async updateScheduled(
    id: number,
    input: {
      title?: string;
      scheduledAt?: string;
      leaderIds?: number[];
      memberIds?: number[];
      externalCode?: string;
      externalJoinUrl?: string;
      joinText?: string;
    },
    user: AuthenticatedUser,
  ) {
    await assertCanWrite(this.prisma, user, id);

    const current = await this.prisma.meeting.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        scheduledAt: true,
        externalCode: true,
        externalJoinUrl: true,
        leaders: { select: { userId: true } },
        members: { select: { userId: true } },
      },
    });

    if (!current) {
      throw new NotFoundException('会议记录不存在');
    }

    if (!current.scheduledAt) {
      throw new BadRequestException('只有预约的正式会议可以修改预约信息');
    }

    /**
     * 只补会议号/链接时不受「会议已开始」限制。
     *
     * 时间、人员开完就定了，改了会误导参会人；但入会信息是记录性的，
     * 会后补上一个会议号没有任何副作用 —— 而这恰恰是最常见的补填时机
     * （会开完了才想起来把会议号记进 MeetMind）。
     */
    const onlyJoinInfo =
      input.title === undefined &&
      input.scheduledAt === undefined &&
      input.leaderIds === undefined &&
      input.memberIds === undefined &&
      (input.joinText !== undefined ||
        input.externalCode !== undefined ||
        input.externalJoinUrl !== undefined);

    if (current.scheduledAt.getTime() <= Date.now() && !onlyJoinInfo) {
      throw new BadRequestException('会议已开始，不能再修改预约信息');
    }

    const data: Prisma.MeetingUpdateInput = {};

    if (input.title !== undefined) {
      const title = input.title.trim();

      if (!title) {
        throw new BadRequestException('会议标题不能为空');
      }

      if (title.length > 200) {
        throw new BadRequestException('会议标题不能超过200个字符');
      }

      data.title = title;
    }

    if (input.scheduledAt !== undefined) {
      const when = new Date(input.scheduledAt);

      if (Number.isNaN(when.getTime())) {
        throw new BadRequestException('开会时间格式不正确');
      }

      if (when.getTime() < Date.now() - 60_000) {
        throw new BadRequestException('开会时间不能早于当前时间');
      }

      data.scheduledAt = when;
    }

    // 补填或清空入会信息；传空串时 normalize 返回 null，等于清空
    if (input.joinText !== undefined) {
      // 整段文本是「整体替换」：解析出什么就是什么，解析不出就清空
      const parsed = parseJoinInput(input.joinText);
      data.externalCode = parsed.code;
      data.externalJoinUrl = parsed.joinUrl;
    } else {
      if (input.externalCode !== undefined) {
        data.externalCode = normalizeMeetingCode(input.externalCode);
      }

      if (input.externalJoinUrl !== undefined) {
        data.externalJoinUrl = normalizeJoinUrl(input.externalJoinUrl);
      }
    }

    const nextLeaderIds =
      input.leaderIds !== undefined
        ? this.normalizeIds(input.leaderIds)
        : current.leaders.map((l) => l.userId);

    const nextMemberIds =
      input.memberIds !== undefined
        ? this.normalizeIds(input.memberIds)
        : current.members.map((m) => m.userId);

    // 每场会议至少要有一位负责人
    if (!nextLeaderIds.length) {
      throw new BadRequestException('至少需要一位负责人');
    }

    await this.assertUsersUsable([...nextLeaderIds, ...nextMemberIds]);

    // ---- 变更摘要，用于消息正文 ----
    const changes: string[] = [];

    /**
     * 入会信息也要算一次「修改」。
     *
     * 不算的话，只填会议号保存会命中下面那句「没有需要修改的内容」——
     * 而补填会议号正是这个接口最常见的用法。
     */
    const touchedJoinInfo =
      input.joinText !== undefined ||
      input.externalCode !== undefined ||
      input.externalJoinUrl !== undefined;

    if (touchedJoinInfo) {
      const nextCode =
        data.externalCode === undefined
          ? (current.externalCode ?? null)
          : (data.externalCode as string | null);
      const nextUrl =
        data.externalJoinUrl === undefined
          ? (current.externalJoinUrl ?? null)
          : (data.externalJoinUrl as string | null);

      if (
        nextCode !== (current.externalCode ?? null) ||
        nextUrl !== (current.externalJoinUrl ?? null)
      ) {
        changes.push(nextCode || nextUrl ? '入会信息已更新' : '入会信息已清空');
      }
    }

    if (data.title && data.title !== current.title) {
      changes.push(`名称改为「${data.title as string}」`);
    }

    if (data.scheduledAt) {
      const when = data.scheduledAt as Date;

      if (when.getTime() !== current.scheduledAt.getTime()) {
        changes.push(`开会时间改为 ${this.formatDateTime(when)}`);
      }
    }

    const beforeLeaderIds = current.leaders.map((l) => l.userId);
    const beforeMemberIds = current.members.map((m) => m.userId);

    const leadersChanged = !this.sameIdSet(beforeLeaderIds, nextLeaderIds);
    const membersChanged = !this.sameIdSet(beforeMemberIds, nextMemberIds);

    if (leadersChanged || membersChanged) {
      const names = await this.userNames([
        ...nextLeaderIds,
        ...nextMemberIds,
      ]);

      if (leadersChanged) {
        changes.push(
          `负责人：${nextLeaderIds.map((x) => names.get(x) ?? `#${x}`).join('、')}`,
        );
      }

      if (membersChanged) {
        const memberText = nextMemberIds.length
          ? nextMemberIds.map((x) => names.get(x) ?? `#${x}`).join('、')
          : '暂无';

        changes.push(`参会成员：${memberText}`);
      }
    }

    if (!changes.length) {
      throw new BadRequestException('没有需要修改的内容');
    }

    // ---- 保存 ----
    await this.prisma.$transaction(async (tx) => {
      await tx.meeting.update({ where: { id }, data });

      if (input.leaderIds !== undefined) {
        await tx.meetingLeader.deleteMany({ where: { meetingId: id } });
        await tx.meetingLeader.createMany({
          data: nextLeaderIds.map((userId) => ({ meetingId: id, userId })),
          skipDuplicates: true,
        });
      }

      if (input.memberIds !== undefined) {
        await tx.meetingMember.deleteMany({ where: { meetingId: id } });
        await tx.meetingMember.createMany({
          data: nextMemberIds.map((userId) => ({ meetingId: id, userId })),
          skipDuplicates: true,
        });
      }
    });

    // ---- 发消息 ----
    const finalTitle =
      (data.title as string | undefined) ?? current.title;

    const recipients = new Set<number>([
      ...beforeLeaderIds,
      ...beforeMemberIds,
      ...nextLeaderIds,
      ...nextMemberIds,
    ]);

    // 自己改的自己不用再收一次消息
    recipients.delete(user.id);

    const stillParticipating = new Set<number>([
      ...nextLeaderIds,
      ...nextMemberIds,
    ]);

    const summary = changes.join('；');

    await this.prisma.meetingNotice.createMany({
      data: [...recipients].map((userId) => ({
        userId,
        meetingId: id,
        content: stillParticipating.has(userId)
          ? `会议「${finalTitle}」信息已更新：${summary}`
          : `你已被移出会议「${finalTitle}」`,
      })),
    });

    return this.findOne(id, user);
  }

  /** 两组 id 是否完全一致（顺序无关） */
  private sameIdSet(a: number[], b: number[]) {
    const sa = [...new Set(a)].sort((x, y) => x - y);
    const sb = [...new Set(b)].sort((x, y) => x - y);

    return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
  }

  /** 批量取用户姓名，供消息正文使用 */
  private async userNames(ids: number[]) {
    if (!ids.length) return new Map<number, string>();

    const users = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, name: true },
    });

    return new Map(users.map((u) => [u.id, u.name]));
  }

  /** 消息里用的时间格式：10/21 09:00 */
  private formatDateTime(date: Date) {
    const pad = (n: number) => String(n).padStart(2, '0');

    return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(
      date.getHours(),
    )}:${pad(date.getMinutes())}`;
  }

  /** 去重并过滤非法 id */
  private normalizeIds(ids?: number[]) {
    if (!Array.isArray(ids)) return [];

    return [...new Set(ids)].filter(
      (id) => typeof id === 'number' && Number.isInteger(id) && id > 0,
    );
  }

  /** 校验账号存在且未停用，避免把停用账号设为负责人/成员 */
  private async assertUsersUsable(ids: number[]) {
    if (!ids.length) return;

    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, isActive: true },
    });

    if (users.length !== ids.length) {
      throw new NotFoundException('指定的参会人员中有账号不存在');
    }

    if (users.some((u) => !u.isActive)) {
      throw new BadRequestException('指定的参会人员中有账号已被停用');
    }
  }

  /** 手动将会议内容保存到草稿箱 */  async createDraft(
    input: { title?: string; content: string },
    user: AuthenticatedUser,
  ) {
    if (!input.content?.trim()) {
      throw new BadRequestException('会议内容不能为空');
    }

    const draft = await this.prisma.meeting.create({
      data: {
        title: input.title?.trim() || '会议草稿',
        content: input.content.trim(),
        summary: null,
        status: 'DRAFT',
        completionStatus: 'NOT_STARTED',
        // 草稿同样有归属者，否则草稿箱会跨用户可见
        ownerId: user.id,
        // 草稿也要满足「至少一位负责人」
        leaders: { create: [{ userId: user.id }] },
      },
      include: meetingInclude,
    });

    return this.toApiRecord(
      draft,
      'owner',
      user,
      computeMeetingCapabilities({
        user,
        access: 'owner',
        audioOpen: draft.audioOpen,
      }),
    );
  }

  /** 手动修改会议完成状态 */
  async updateMeetingCompletionStatus(
    id: number,
    completionStatus: MeetingCompletionStatus,
    user: AuthenticatedUser,
  ) {
    const allowedStatuses: MeetingCompletionStatus[] = [
      'NOT_STARTED',
      'IN_PROGRESS',
      'COMPLETED',
      'CANCELLED',
    ];

    if (!allowedStatuses.includes(completionStatus)) {
      throw new BadRequestException('无效的会议完成状态');
    }

    await assertCanWrite(this.prisma, user, id);

    const current = await this.prisma.meeting.findUnique({
      where: { id },
      select: { completionStatus: true },
    })

    if (!current) {
      throw new NotFoundException('会议记录不存在')
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.meeting.update({
        where: { id },
        data: {
          completionStatus,
        },
        select: {
          id: true,
          title: true,
          completionStatus: true,
        },
      })

      /**
       * 状态真的变了才留痕：重复点同一个状态不该在记录里堆噪声。
       * 这条记录是「谁手动改的」，自动流转由 todo_events 说明来源。
       */
      if (current.completionStatus !== completionStatus) {
        await tx.meetingEvent.create({
          data: {
            meetingId: id,
            actorId: user.id,
            type: 'status_changed',
            fromStatus: current.completionStatus,
            toStatus: completionStatus,
          },
        })
      }

      return updated
    })
  }

  /** 会议状态变更记录：谁、何时、从什么状态改成了什么 */
  async listMeetingEvents(meetingId: number, user: AuthenticatedUser) {
    await assertCanRead(this.prisma, user, meetingId)

    const rows = await this.prisma.meetingEvent.findMany({
      where: { meetingId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        type: true,
        fromStatus: true,
        toStatus: true,
        createdAt: true,
        actor: { select: { id: true, name: true } },
      },
    })

    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      fromStatus: row.fromStatus,
      toStatus: row.toStatus,
      createdAt: row.createdAt.toISOString(),
      actor: row.actor,
    }))
  }

  /** 修改会议标题 */
  async updateMeeting(
    id: number,
    data: {
      title: string;
    },
    user: AuthenticatedUser,
  ) {
    await assertCanWrite(this.prisma, user, id);

    const title = data.title?.trim();

    if (!title) {
      throw new BadRequestException('会议标题不能为空');
    }

    if (title.length > 200) {
      throw new BadRequestException('会议标题不能超过200个字符');
    }

    return this.prisma.meeting.update({
      where: { id },
      data: { title }
    });
  }

  /**
   * 置顶 / 取消置顶会议。
   *
   * pinned 为 true 时记录置顶时间（多条置顶按“最近置顶优先”排序），
   * 为 false 时清空该时间。
   */
  async updatePinned(id: number, pinned: boolean, user: AuthenticatedUser) {
    await assertCanWrite(this.prisma, user, id);

    const meeting = await this.prisma.meeting.findUnique({
      where: { id },
      select: { id: true, pinnedAt: true },
    });

    if (!meeting) {
      throw new NotFoundException('会议记录不存在');
    }

    // 已经是目标状态时不刷新置顶时间，避免重复点击把顺序打乱。
    if (pinned && meeting.pinnedAt) {
      return {
        id: meeting.id,
        pinnedAt: meeting.pinnedAt.toISOString(),
      };
    }

    if (!pinned && !meeting.pinnedAt) {
      return {
        id: meeting.id,
        pinnedAt: null,
      };
    }

    const updated = await this.prisma.meeting.update({
      where: { id },
      data: {
        pinnedAt: pinned ? new Date() : null,
      },
      select: {
        id: true,
        pinnedAt: true,
      },
    });

    return {
      id: updated.id,
      pinnedAt: updated.pinnedAt?.toISOString() ?? null,
    };
  }

  /** 获取正式会议和草稿箱统计 */
  async getStats(user: AuthenticatedUser) {
    // 统计同样受数据隔离约束：只看自己可见范围内的数据
    const visible = this.visibleMeetingWhere(user);

    /**
     * 正式会议（历史口径）：排除手动草稿与 AI 失败，且排除「尚未开始的预约会议」。
     * 预约时间已过或未设预约时间的会议才算入历史。
     */
    const formalMeeting: Prisma.MeetingWhereInput = {
      AND: [
        visible,
        { status: { notIn: ['DRAFT', 'FAILED'] } },
        {
          OR: [{ scheduledAt: null }, { scheduledAt: { lte: new Date() } }],
        },
      ],
    };

    /** 尚未开始的预约会议：单独作为「未开始」分段统计，不计入历史会议总数 */
    const upcomingMeeting: Prisma.MeetingWhereInput = {
      AND: [
        visible,
        { status: { notIn: ['DRAFT', 'FAILED'] } },
        { scheduledAt: { gt: new Date() } },
      ],
    };

    const draftMeeting: Prisma.MeetingWhereInput = {
      AND: [visible, { status: { in: ['DRAFT', 'FAILED'] } }],
    };

    // 待办/决策没有归属字段，通过所属会议间接过滤
    const visibleTodo: Prisma.TodoWhereInput = {
      meeting: { is: visible },
    };

    const visibleDecision: Prisma.DecisionWhereInput = {
      meeting: { is: visible },
    };

    const [
      totalMeetings,
      draftMeetings,
      notStartedMeetings,
      inProgressMeetings,
      completedMeetings,
      cancelledMeetings,
      totalTodos,
      completedTodos,
      pendingReviewTodos,
      overdueTodos,
      reworkCount,
      acceptedSamples,
      totalDecisions,
    ] = await Promise.all([
      // 会议总数（历史口径）：排除草稿、AI 失败与尚未开始的预约会议
      this.prisma.meeting.count({ where: formalMeeting }),

      // 草稿箱数量：手动草稿 + AI 生成失败
      this.prisma.meeting.count({ where: draftMeeting }),

      // 未开始：只统计尚未开始的预约会议（历史口径里不该有未开始）
      this.prisma.meeting.count({
        where: { AND: [upcomingMeeting, { completionStatus: 'NOT_STARTED' }] },
      }),

      // 进行中：IN_PROGRESS，或「预约已过但仍停在 NOT_STARTED」的遗留会议
      this.prisma.meeting.count({
        where: {
          AND: [
            formalMeeting,
            {
              OR: [
                { completionStatus: 'IN_PROGRESS' },
                {
                  completionStatus: 'NOT_STARTED',
                  scheduledAt: { lte: new Date() },
                },
              ],
            },
          ],
        },
      }),

      this.prisma.meeting.count({
        where: { AND: [formalMeeting, { completionStatus: 'COMPLETED' }] },
      }),

      this.prisma.meeting.count({
        where: { AND: [formalMeeting, { completionStatus: 'CANCELLED' }] },
      }),

      this.prisma.todo.count({ where: visibleTodo }),

      this.prisma.todo.count({
        where: { AND: [visibleTodo, { status: 'COMPLETED' }] },
      }),

      // 待验收：不计入完成率，但要在看板上单独露出，否则「完成率」会被误读
      this.prisma.todo.count({
        where: { AND: [visibleTodo, { status: 'SUBMITTED' }] },
      }),

      // 逾期：过了截止时间且仍未完成（含待验收，提交了但没验收也算没交付完）
      this.prisma.todo.count({
        where: {
          AND: [
            visibleTodo,
            { deadlineAt: { not: null, lt: new Date() } },
            { status: { notIn: ['COMPLETED', 'CANCELLED'] } },
          ],
        },
      }),

      // 返工次数：被打回的提交数
      this.prisma.todoSubmission.count({
        where: { status: 'REJECTED', todo: { meeting: visible } },
      }),

      // 平均验收时长：只取最近 500 条，避免统计把整张表拖进来
      this.prisma.todoSubmission.findMany({
        where: {
          status: 'ACCEPTED',
          reviewedAt: { not: null },
          todo: { meeting: visible },
        },
        select: { createdAt: true, reviewedAt: true },
        orderBy: { reviewedAt: 'desc' },
        take: 500,
      }),

      this.prisma.decision.count({ where: visibleDecision }),
    ])

    const reviewHours = acceptedSamples
      .map((row) => {
        if (!row.reviewedAt) return null

        const hours = (row.reviewedAt.getTime() - row.createdAt.getTime()) / 3_600_000

        return hours >= 0 ? hours : null
      })
      .filter((hours): hours is number => hours !== null)

    const avgReviewHours = reviewHours.length
      ? Math.round((reviewHours.reduce((sum, h) => sum + h, 0) / reviewHours.length) * 10) / 10
      : null

    return {
      totalMeetings,
      draftMeetings,
      notStartedMeetings,
      inProgressMeetings,
      completedMeetings,
      cancelledMeetings,
      totalTodos,
      completedTodos,
      pendingReviewTodos,
      overdueTodos,
      reworkCount,
      avgReviewHours,
      totalDecisions,
    }
  }

  /**
   * 构造「当前用户可见会议」的查询条件。
   *
   * 普通用户：自己拥有的 ∪ 自己负责的 ∪ 自己参与的 ∪ 别人共享给自己的
   * 管理员及以上：全部会议
   *
   * 所有列表查询都走这里，避免某条查询漏掉数据隔离。
   */
  /** 构造「当前用户可见会议」的查询条件；实现见 meetings.scope.ts */
  private visibleMeetingWhere(user: AuthenticatedUser): Prisma.MeetingWhereInput {
    return visibleMeetingScope(user);
  }

  /**
   * 查询历史会议（分页 + 服务端筛选）。
   *
   * 默认排除未开始的预约会议 —— 它们属于"待办日程"，由首页展示；
   * 传 upcoming=true 时反过来只取未开始的会议。
   */
  async findAll(user: AuthenticatedUser, query: MeetingListQuery = {}) {
    const now = new Date();
    const page = Math.max(1, Math.trunc(query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Math.trunc(query.pageSize ?? 20)));

    const conditions: Prisma.MeetingWhereInput[] = [
      this.visibleMeetingWhere(user),
      { status: { notIn: ['FAILED', 'DRAFT'] } },
    ];

    /** 关键词（已裁剪）；空串表示不做全文过滤 */
    const keyword = query.keyword?.trim() ?? '';

    if (query.upcoming) {
      conditions.push({ scheduledAt: { gt: now } });
    } else {
      // 已开始的会议：没有预约时间，或预约时间已过
      conditions.push({
        OR: [{ scheduledAt: null }, { scheduledAt: { lte: now } }],
      });
    }

    if (query.pinned) {
      conditions.push({ pinnedAt: { not: null } });
    }

    /**
     * 关键词检索覆盖「标题 + 摘要 + 原文 + 决策 + 待办」。
     *
     * 列表只返回摘要字段，所以这里用 Prisma 的关系过滤（some）直接命中子表，
     * 不需要把 decisions / todos 一起读出来；
     * 命中片段由下方的补查单独取，避免主查询被正文拖慢。
     */
    if (keyword) {
      conditions.push({
        OR: [
          { title: { contains: keyword, mode: 'insensitive' } },
          { summary: { contains: keyword, mode: 'insensitive' } },
          { content: { contains: keyword, mode: 'insensitive' } },
          {
            decisions: {
              some: { content: { contains: keyword, mode: 'insensitive' } },
            },
          },
          {
            todos: {
              some: { content: { contains: keyword, mode: 'insensitive' } },
            },
          },
        ],
      });
    }

    if (query.status) {
      conditions.push({
        completionStatus: query.status as MeetingCompletionStatus,
      });
    }

    if (query.from || query.to) {
      const createdAt: Prisma.DateTimeFilter = {};

      if (query.from) createdAt.gte = new Date(`${query.from}T00:00:00`);
      if (query.to) {
        createdAt.lt = new Date(
          new Date(`${query.to}T00:00:00`).getTime() + 24 * 60 * 60 * 1000,
        );
      }

      conditions.push({ createdAt });
    }

    const where: Prisma.MeetingWhereInput = { AND: conditions };

    // 置顶永远排在最前，其余按用户选择的创建时间方向
    const createdDirection: Prisma.SortOrder =
      query.sort === 'oldest' ? 'asc' : 'desc';

    const [rows, total, pinnedTotal] = await Promise.all([
      this.prisma.meeting.findMany({
        where,
        orderBy: [
          { pinnedAt: { sort: 'desc', nulls: 'last' } },
          { createdAt: createdDirection },
        ],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          title: true,
          summary: true,
          completionStatus: true,
          status: true,
          scheduledAt: true,
          pinnedAt: true,
          createdAt: true,
          ownerId: true,
          audioOpen: true,
          /*
           * 列表要显示会议号和「入会」按钮。
           * 不加这两行，mapper 拿到 undefined 一律输出 null，
           * 前端 v-if 判断不成立 —— 列表上什么都不会出现，
           * 而且不报错，只能靠对着界面才发现。
           */
          externalCode: true,
          externalJoinUrl: true,
          leaders: { select: { user: { select: USER_BRIEF_SELECT } } },
          members: { select: { user: { select: USER_BRIEF_SELECT } } },
          shares: {
            where: { userId: user.id },
            select: { permission: true },
          },
          _count: { select: { decisions: true, todos: true } },
        },
      }),
      this.prisma.meeting.count({ where }),
      // 当前筛选下的置顶总数，供列表上方的统计文案使用
      this.prisma.meeting.count({ where: { AND: [...conditions, { pinnedAt: { not: null } }] } }),
    ]);

    /**
     * 有关键词时，补一次查询取命中片段。
     *
     * 只查当前页这十几条：主查询刻意不碰正文（`content` 动辄几十 KB），
     * 但只把结果缩小、不说明「为什么匹配」，用户还得自己翻一遍才知道对不对。
     */
    const hitsByMeeting = keyword
      ? await this.loadSearchHits(
          rows.map((row) => row.id),
          keyword,
        )
      : new Map<number, SearchHit[]>();

    return {
      items: rows.map((row) => {
        const access = this.resolveAccessFromRow(row, user);
        const capabilities = computeMeetingCapabilities({
          user,
          access,
          audioOpen: row.audioOpen,
        });

        // 历史列表不出现「未开始」：预约已过但仍停在 NOT_STARTED 的遗留会议，按进行中展示
        const completionStatus =
          row.completionStatus === 'NOT_STARTED' &&
          (row.scheduledAt === null || row.scheduledAt <= new Date())
            ? 'IN_PROGRESS'
            : row.completionStatus;

        return {
          ...mapMeetingSummary(
            { ...row, completionStatus },
            access,
            capabilities,
          ),
          // 有关键词时带上命中片段；没有则为空数组，前端无需判断字段是否存在
          hits: hitsByMeeting.get(row.id) ?? [],
        };
      }),
      total,
      pinnedTotal,
      page,
      pageSize,
      hasMore: page * pageSize < total,
    };
  }

  /**
   * 取当前页这些会议的命中片段。
   *
   * 只在有关键词时调用，且 id 已限定在可见结果内，
   * 因此不需要再套一次数据隔离条件。
   */
  private async loadSearchHits(
    ids: number[],
    keyword: string,
  ): Promise<Map<number, SearchHit[]>> {
    if (!ids.length) {
      return new Map();
    }

    const match = (value: string) => ({
      contains: value,
      mode: 'insensitive' as const,
    });

    const rows = await this.prisma.meeting.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        title: true,
        summary: true,
        content: true,
        decisions: {
          where: { content: match(keyword) },
          select: { content: true },
          take: 3,
        },
        todos: {
          where: { content: match(keyword) },
          select: { content: true },
          take: 3,
        },
      },
    });

    return new Map(
      rows.map((row) => [
        row.id,
        collectHits({
          title: row.title,
          summary: row.summary,
          content: row.content,
          decisions: row.decisions.map((item) => item.content),
          todos: row.todos.map((item) => item.content),
          keyword,
        }),
      ]),
    );
  }

  /** 从列表行推断当前用户的访问级别（与 resolveMeetingAccess 同规则） */
  private resolveAccessFromRow(
    row: {
      ownerId: number;
      leaders?: Array<{ user: { id: number } }>;
      members?: Array<{ user: { id: number } }>;
      shares?: Array<{ permission: 'READ' | 'EDIT' }>;
    },
    user: AuthenticatedUser,
  ): MeetingAccess {
    if (row.ownerId === user.id) return 'owner';
    if (row.leaders?.some((l) => l.user.id === user.id)) return 'leader';
    if (row.members?.some((m) => m.user.id === user.id)) return 'member';
    if (row.shares?.some((s) => s.permission === 'EDIT')) return 'edit';
    if (hasGlobalMeetingAccess(user)) {
      return roleHasUpdateAll(user.role) ? 'edit' : 'read';
    }

    return 'read';
  }

  /** 查询草稿箱会议；AI 生成失败的会议会保留在这里。 */
  async findDrafts(user: AuthenticatedUser) {
    const meetings = await this.prisma.meeting.findMany({
      where: {
        AND: [
          this.visibleMeetingWhere(user),
          { status: { in: ['FAILED', 'DRAFT'] } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      include: meetingIncludeFor(user.id),
    });

    return this.toApiRecordList(meetings, user);
  }

  /** 查询单条会议详情；无权访问时同样返回 404，避免探测会议是否存在。 */
  async findOne(id: number, user: AuthenticatedUser) {
    const { access, capabilities } = await assertCanRead(
      this.prisma,
      user,
      id,
    );

    const meeting = await this.prisma.meeting.findUnique({
      where: { id },
      include: meetingIncludeFor(user.id),
    });

    if (!meeting) throw new NotFoundException('会议记录不存在');

    return this.toApiRecord(meeting, access, user, capabilities);
  }

  /**
   * 导出会议纪要（Markdown）。
   *
   * 直接复用 findOne：访问权限、能力位与关联数据都在那一层校验过，
   * 这里不另写一套判断，避免出现「详情打不开、导出却拿得到」的旁路。
   */
  async exportMarkdown(id: number, user: AuthenticatedUser) {
    const meeting = await this.findOne(id, user);

    return {
      filename: markdownFilename(meeting.title, meeting.id),
      content: buildMeetingMarkdown(meeting),
    };
  }

  /**
   * 追加一位负责人。
   *
   * 负责人可以有多个；同一个人也可同时是成员。
   * 重复添加按幂等处理。
   */
  async addLeader(id: number, leaderUserId: number, user: AuthenticatedUser) {
    await assertCanManageMembers(this.prisma, user, id);

    const target = await this.prisma.user.findUnique({
      where: { id: leaderUserId },
      select: { id: true, isActive: true },
    });

    if (!target) {
      throw new NotFoundException('指定为负责人的用户不存在');
    }

    if (!target.isActive) {
      throw new BadRequestException('该账号已被停用，不能担任负责人');
    }

    await this.prisma.meetingLeader.upsert({
      where: { meetingId_userId: { meetingId: id, userId: leaderUserId } },
      create: { meetingId: id, userId: leaderUserId },
      update: {},
    });

    return this.findLeaders(id);
  }

  /**
   * 移除一位负责人。
   *
   * 每场会议至少要保留一位负责人，移除最后一位会被拒绝。
   */
  async removeLeader(
    id: number,
    leaderUserId: number,
    user: AuthenticatedUser,
  ) {
    const access = await assertCanManageMembers(this.prisma, user, id);

    const leaders = await this.prisma.meetingLeader.findMany({
      where: { meetingId: id },
      select: { userId: true },
    });

    if (!leaders.some((l) => l.userId === leaderUserId)) {
      throw new NotFoundException('该用户不是本会议的负责人');
    }

    if (leaders.length <= 1) {
      throw new BadRequestException('每场会议至少要保留一位负责人');
    }

    /**
     * 移除自己后若既非创建者也不是成员，会失去访问权，
     * 直接拒绝并提示先把自己加为成员。
     */
    if (
      leaderUserId === user.id &&
      access.access === 'leader'
    ) {
      const selfMember = await this.prisma.meetingMember.findUnique({
        where: { meetingId_userId: { meetingId: id, userId: user.id } },
        select: { id: true },
      });

      if (!selfMember) {
        throw new BadRequestException(
          '移除自己后你将失去该会议的访问权限，请先把自己加为成员',
        );
      }
    }

    await this.prisma.meetingLeader.deleteMany({
      where: { meetingId: id, userId: leaderUserId },
    });

    return this.findLeaders(id);
  }

  /** 负责人列表 */
  async listLeaders(id: number) {
    const leaders = await this.prisma.meetingLeader.findMany({
      where: { meetingId: id },
      select: { user: { select: { id: true, name: true, phone: true } } },
      orderBy: { createdAt: 'asc' },
    });

    return leaders.map((l) => l.user);
  }

  /** 带读取权限校验的负责人列表查询 */
  async findLeaders(id: number) {
    return this.listLeaders(id);
  }

  /**
   * 删除会议；外键会级联清理决策、待办、成员与共享记录。
   *
   * 只有归属者或具备全局删除权限的管理员可删除，
   * 「被共享者」与成员不能删别人的会议。
   */
  async remove(id: number, user: AuthenticatedUser) {
    await assertCanOwn(this.prisma, user, id);

    // 录音是磁盘文件，不参与外键级联，必须在删除记录前单独清理。
    await this.audioService.removeAudioByMeetingId(id);

    // 交付物附件同理：删除记录后文件会变成孤儿
    await this.todos.removeTodoAttachmentFiles(id);

    await this.prisma.meeting.delete({ where: { id } });

    await this.audit.record(user, {
      action: 'meeting.delete',
      resourceType: 'meeting',
      resourceId: id,
    });
  }

  /**
   * 添加会议成员。
   *
   * 负责人与创建者也可以被加为成员（需求明确允许），
   * 不做互斥校验；重复添加按幂等处理。
   */
  async addMember(
    id: number,
    memberUserId: number,
    user: AuthenticatedUser,
  ) {
    await assertCanManageMembers(this.prisma, user, id);

    const target = await this.prisma.user.findUnique({
      where: { id: memberUserId },
      select: { id: true, name: true, phone: true, isActive: true },
    });

    if (!target) {
      throw new NotFoundException('要添加的用户不存在');
    }

    if (!target.isActive) {
      throw new BadRequestException('该账号已被停用，不能加入会议');
    }

    await this.prisma.meetingMember.upsert({
      where: {
        meetingId_userId: { meetingId: id, userId: memberUserId },
      },
      create: { meetingId: id, userId: memberUserId },
      update: {},
    });

    return this.listMembers(id);
  }

  /** 移除会议成员。移除负责人不影响其负责人身份。 */
  async removeMember(
    id: number,
    memberUserId: number,
    user: AuthenticatedUser,
  ) {
    await assertCanManageMembers(this.prisma, user, id);

    await this.prisma.meetingMember.deleteMany({
      where: { meetingId: id, userId: memberUserId },
    });

    return this.listMembers(id);
  }

  /** 会议成员列表 */
  async listMembers(id: number) {
    const members = await this.prisma.meetingMember.findMany({
      where: { meetingId: id },
      select: { user: { select: { id: true, name: true, phone: true } } },
      orderBy: { createdAt: 'asc' },
    });

    return members.map((m) => m.user);
  }

  /** 带读取权限校验的成员列表查询（接口用） */
  async findMembers(id: number, user: AuthenticatedUser) {
    await assertCanRead(this.prisma, user, id);

    return this.listMembers(id);
  }

  /**
   * 控制会议录音是否对非负责人开放。
   *
   * 只有负责人、创建者或超级管理员可操作；
   * 关闭后成员与共享者既看不到播放器，也无法通过音频接口取流。
   */
  async updateAudioOpen(
    id: number,
    audioOpen: boolean,
    user: AuthenticatedUser,
  ) {
    await assertCanToggleAudio(this.prisma, user, id);

    if (typeof audioOpen !== 'boolean') {
      throw new BadRequestException('audioOpen 必须是布尔值');
    }

    const updated = await this.prisma.meeting.update({
      where: { id },
      data: { audioOpen },
      select: { id: true, audioOpen: true },
    });

    return updated;
  }

  /**
   * 批量转换列表：根据归属关系计算每条的访问级别与能力位。
   *
   * shares 已在查询时按当前用户过滤（meetingIncludeFor），
   * 因此只需看本人的那条授权即可判定 edit / read。
   */
  private toApiRecordList(
    meetings: Array<MeetingWithRelations>,
    user: AuthenticatedUser,
  ) {
    return meetings.map((meeting) => {
      let access: MeetingAccess;

      if (meeting.ownerId === user.id) {
        access = 'owner';
      } else if (meeting.leaders?.some((l) => l.user.id === user.id)) {
        access = 'leader';
      } else if (meeting.members?.some((m) => m.user.id === user.id)) {
        access = 'member';
      } else if (meeting.shares?.some((s) => s.permission === 'EDIT')) {
        // 共享明确给了编辑权
        access = 'edit';
      } else if (hasGlobalMeetingAccess(user)) {
        // 管理员及以上，无显式共享时仍可按全局权限编辑
        access = roleHasUpdateAll(user.role) ? 'edit' : 'read';
      } else {
        access = 'read';
      }

      const capabilities = computeMeetingCapabilities({
        user,
        access,
        audioOpen: meeting.audioOpen,
      });

      return this.toApiRecord(meeting, access, user, capabilities);
    });
  }

  /** 转换 Prisma 字段名及关联数据，维持现有 Vue 页面所需的 API 结构。 */
  private toApiRecord(
    meeting: MeetingWithRelations,
    access: MeetingAccess,
    user: AuthenticatedUser,
    capabilities: MeetingCapabilities,
  ) {
    const audioUrl = meeting.audioUrl ?? null;

    return {
      id: meeting.id,
      title: meeting.title,
      content: meeting.content,
      summary: meeting.summary ?? '',
      completionStatus: meeting.completionStatus,
      /**
       * 录音地址。未开放且当前用户无权听时返回 null，
       * 避免前端拿到地址后仍能直接播放。
       * 真正播放走鉴权接口 /api/meetings/:id/audio。
       */
      audioUrl: capabilities.canListenAudio && audioUrl
        ? `/api/meetings/${meeting.id}/audio`
        : null,
      audioDurationSec: meeting.audioDurationSec ?? null,
      /** 正式会议的开会时间；为空表示临时会议 */
      scheduledAt: meeting.scheduledAt?.toISOString() ?? null,
      /** 录音是否对非负责人开放（前端用于渲染开关状态） */
      audioOpen: meeting.audioOpen,
      /** 是否存在录音（与是否有权听无关，用于展示“有录音但未开放”） */
      hasAudio: !!audioUrl,
      // 置顶时间；为空表示未置顶。前端据此把置顶会议排在最前。
      pinnedAt: meeting.pinnedAt?.toISOString() ?? null,
      isDraft:
        meeting.status === 'FAILED' ||
        meeting.status === 'DRAFT',

      // ---- 会议来源（腾讯会议等）----
      // 前端据此显示「进入会议」按钮与会议号
      sourcePlatform: meeting.sourcePlatform ?? null,
      externalJoinUrl: meeting.externalJoinUrl ?? null,
      externalCode: meeting.externalCode ?? null,

      // ---- 负责人与成员 ----
      leaders: (meeting.leaders ?? []).map((l) => ({
        id: l.user.id,
        name: l.user.name,
        phone: l.user.phone,
      })),
      members: (meeting.members ?? []).map((m) => ({
        id: m.user.id,
        name: m.user.name,
        phone: m.user.phone,
      })),

      // ---- 权限相关字段，前端据此决定按钮是否可点 ----
      /** 归属者 ID，用于判断“是我的会议” */
      ownerId: meeting.ownerId,
      /** 当前用户的实际访问级别 */
      access,
      ...capabilities,

      decisions: meeting.decisions.map((decision) => decision.content),
      todos: meeting.todos.map((todo) => {
        const latest = todo.submissions?.[0] ?? null
        const leaderIds = (meeting.leaders ?? []).map((l) => l.user.id)
        const isMeetingLeader = access === 'owner' || leaderIds.includes(user.id)
        const isLeaderLike =
          access === 'owner' ||
          leaderIds.includes(user.id) ||
          capabilities.canEdit

        const isAssignee = todo.assigneeUserId === user.id
        const unfinished = todo.status === 'OPEN' || todo.status === 'IN_PROGRESS'

        return {
          id: todo.id,
          content: todo.content,
          assignee: todo.assignee ?? undefined,
          /** 结构化负责人；为空说明只留了姓名文本（AI 没能唯一匹配到账号） */
          assigneeUserId: todo.assigneeUserId ?? null,
          assigneeName: todo.assigneeUser?.name ?? todo.assignee ?? null,
          /** 验收人；为空表示这条待办不需要验收 */
          reviewerId: todo.reviewerId ?? null,
          reviewerName: todo.reviewer?.name ?? null,
          deadline: todo.deadline ?? undefined,
          deadlineAt: todo.deadlineAt?.toISOString() ?? null,
          /** 逾期：过了截止时间且未完成（含待验收） */
          overdue: isOverdue(todo.deadlineAt, todo.status),
          /** 验收要点：只是清单，不改变状态机 */
          checklist: (todo.checkItems ?? []).map((item) => ({
            id: item.id,
            content: item.content,
            done: item.done,
            doneById: item.doneById ?? null,
            doneByName: item.doneBy?.name ?? null,
            doneAt: item.doneAt?.toISOString() ?? null,
          })),
          checklistTotal: todo.checkItems?.length ?? 0,
          checklistDone: todo.checkItems?.filter((item) => item.done).length ?? 0,
          status: todo.status,
          /** 最近一次提交（待验收 / 被打回时前端据此渲染角标与时间线入口） */
          latestSubmission: latest
            ? {
              id: latest.id,
              status: latest.status,
              note: latest.note,
              attemptNo: latest.attemptNo,
              submitterId: latest.submitterId,
              submitterName: latest.submitter?.name ?? null,
              rejectReason: latest.rejectReason,
              reviewedAt: latest.reviewedAt?.toISOString() ?? null,
              createdAt: latest.createdAt.toISOString(),
              attachmentCount: latest._count?.attachments ?? 0,
            }
            : null,
          /** 改状态：该事项的验收人、会议负责人，或超级管理员 */
          canChangeStatus:
            todo.status !== 'SUBMITTED' &&
            (isMeetingLeader ||
              (todo.reviewerId !== null && todo.reviewerId === user.id) ||
              user.role === 'SUPER_ADMIN'),
          /** 提交：只有该待办的负责人 */
          canSubmit: unfinished && isAssignee,
          /** 能否查看提交内容（说明、附件、打回原因） */
          canViewSubmissionContent:
            isAssignee ||
            todo.reviewerId === user.id ||
            isMeetingLeader ||
            user.role === 'SUPER_ADMIN',
          /** 验收人：指定验收人，或负责人/管理员代验收 */
          canReview:
            todo.status === 'SUBMITTED' &&
            latest?.status === 'PENDING' &&
            (todo.reviewerId === user.id || isLeaderLike),
          /** 撤回：只有提交人本人，负责人也不行 */
          canWithdraw:
            todo.status === 'SUBMITTED' &&
            latest?.status === 'PENDING' &&
            latest.submitterId === user.id,
        }
      }),
      created_at: meeting.createdAt.toISOString(),
    };
  }
}

/** 列表/详情查询统一带回的基础关联与归属字段 */
type UserBrief = { id: number; name: string; phone: string };

type MeetingWithRelations = Meeting & {
  decisions: Array<{ content: string; sortOrder: number }>;
  todos: Array<{
    id: number;
    content: string;
    assignee: string | null;
    assigneeUserId: number | null;
    reviewerId: number | null;
    deadline: string | null;
    deadlineAt: Date | null;
    status: TodoStatus;
    sortOrder: number;
    assigneeUser?: { id: number; name: string } | null;
    reviewer?: { id: number; name: string } | null;
    checkItems?: Array<{
      id: number;
      content: string;
      done: boolean;
      doneById: number | null;
      doneAt: Date | null;
      doneBy?: { id: number; name: string } | null;
    }>;
    submissions?: Array<{
      id: number;
      status: string;
      note: string | null;
      attemptNo: number;
      submitterId: number;
      reviewerId: number | null;
      rejectReason: string | null;
      reviewedAt: Date | null;
      createdAt: Date;
      submitter?: { id: number; name: string };
      _count?: { attachments: number };
    }>;
  }>;
  leaders?: Array<{ user: UserBrief }>;
  members?: Array<{ user: UserBrief }>;
  shares?: Array<{ permission: 'READ' | 'EDIT' }>;
};
