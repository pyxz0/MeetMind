import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { Prisma, TodoStatus, MeetingCompletionStatus } from '@prisma/client';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaService } from '../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../auth/auth.decorators';
import { formatCstDate, startOfCstDay } from '../common/datetime';
import { assertCanEditTodos, assertCanRead, assertCanWrite } from './meetings.access';
import { visibleMeetingScope } from './meetings.scope';
import { parseDeadlineAt } from './deadline';
import { buildTodoNotices } from './todo-notices';
import { resolveCompletionStatus } from './todo-completion';

/** 验收操作需要的最小提交视图 */
interface SubmissionForReview {
  id: number;
  status: string;
  submitterId: number;
  reviewerId: number | null;
  todoId: number;
  todo: { content: string; meetingId: number };
}

/**
 * 待办的创建、流转、交付与验收。
 *
 * 从 MeetingsService 拆出来是因为那个文件已经 112KB / 3700 行，
 * 里面待办相关的占了大半，而会议本身的查询、权限、导出也挤在一起，
 * 改一处要在一屏之外找另一半。
 *
 * 依赖是单向的：TodosService 不认识 MeetingsService，
 * 需要的会议范围从 meetings.scope 取。
 */
@Injectable()
export class TodosService {
  private readonly logger = new Logger(TodosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** 可见会议范围；与 MeetingsService 用的是同一个函数 */
  private visibleMeetingWhere(user: AuthenticatedUser): Prisma.MeetingWhereInput {
    return visibleMeetingScope(user);
  }

/** 编辑待办事项 */
  async updateTodo(
    id: number,
    data: {
      content?: string
      assignee?: string
      assigneeUserId?: number | null
      reviewerId?: number | null
      deadline?: string
      deadlineAt?: string | null
    },
    user: AuthenticatedUser,
  ) {
    const todo = await this.prisma.todo.findUnique({
      where: { id }
    })

    if (!todo) {
      throw new NotFoundException('待办事项不存在')
    }

    // 待办本身没有归属字段，权限跟着所属会议走
    await assertCanWrite(this.prisma, user, todo.meetingId);

    // 负责人的文本与 ID 必须同时变，否则会出现「显示张三、实际指派给李四」
    let assignee: string | null | undefined = data.assignee
    let assigneeUserId = todo.assigneeUserId

    if (data.assigneeUserId !== undefined) {
      assigneeUserId = data.assigneeUserId

      if (data.assigneeUserId === null) {
        assignee = null
      } else {
        const target = await this.prisma.user.findUnique({
          where: { id: data.assigneeUserId },
          select: { name: true, isActive: true },
        })

        if (!target) throw new NotFoundException('指定的负责人不存在')
        if (!target.isActive) throw new BadRequestException('该账号已停用，不能担任负责人')

        assignee = target.name
      }
    }

    // 截止时间：优先用显式 deadlineAt，否则尝试从文本解析
    let deadlineAt = todo.deadlineAt
    if (data.deadlineAt !== undefined) {
      deadlineAt = data.deadlineAt === null ? null : parseDeadlineAt(data.deadlineAt)
    } else if (data.deadline !== undefined) {
      deadlineAt = parseDeadlineAt(data.deadline)
    }

    /**
     * 截止时间真的变了才重置提醒计数。
     *
     * 不重置的话，一条待办改到下周再改回来，会因为「已经提醒过 7 次」
     * 而永久静音 —— 用户看不到提醒，也找不到原因。
     */
    const deadlineChanged =
      (data.deadlineAt !== undefined || data.deadline !== undefined) &&
      (deadlineAt?.getTime() ?? null) !== (todo.deadlineAt?.getTime() ?? null)

    // 未指定验收人（传了 null）时，默认会议负责人（多个时默认创建者）
    let resolvedReviewerId: number | null | undefined
    if (data.reviewerId !== undefined) {
      resolvedReviewerId = data.reviewerId ?? (await this.resolveDefaultReviewerId(todo.meetingId))

      if (resolvedReviewerId) {
        const reviewer = await this.prisma.user.findUnique({
          where: { id: resolvedReviewerId },
          select: { isActive: true },
        })

        if (!reviewer) throw new NotFoundException('指定的验收人不存在')
        if (!reviewer.isActive) throw new BadRequestException('该账号已停用，不能担任验收人')
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.todo.update({
        where: { id },
        data: {
          ...(data.content !== undefined && {
            content: data.content
          }),
          ...(assignee !== undefined && {
            assignee
          }),
          ...(data.assigneeUserId !== undefined && {
            assigneeUserId
          }),
          ...(resolvedReviewerId !== undefined && {
            reviewerId: resolvedReviewerId
          }),
          ...(data.deadline !== undefined && {
            deadline: data.deadline
          }),
          // 只传了结构化时间、没传文本：补一个可读日期，别让列表显示空
          ...(data.deadlineAt !== undefined &&
            data.deadline === undefined &&
            deadlineAt && {
              deadline: formatCstDate(deadlineAt)
            }),
          ...(data.deadlineAt !== undefined || data.deadline !== undefined
            ? { deadlineAt }
            : {}),
          ...(deadlineChanged && {
            overdueNotifiedAt: null,
            overdueNotifyCount: 0,
          }),
        }
      })

      // 换了负责人或验收人，都要保证对方能打开这场会议，否则只会拿到 404
      const memberIds = [updated.assigneeUserId, updated.reviewerId].filter(
        (userId): userId is number => !!userId,
      )

      for (const userId of [...new Set(memberIds)]) {
        await tx.meetingMember.upsert({
          where: {
            meetingId_userId: {
              meetingId: todo.meetingId,
              userId,
            },
          },
          create: {
            meetingId: todo.meetingId,
            userId,
          },
          update: {},
        })
      }

      await tx.todoEvent.create({
        data: {
          todoId: id,
          actorId: user.id,
          type:
            data.assigneeUserId !== undefined || data.reviewerId !== undefined
              ? 'assigned'
              : data.deadline !== undefined || data.deadlineAt !== undefined
                ? 'deadline_changed'
                : 'updated',
          fromStatus: todo.status,
          toStatus: updated.status,
          metadata: {
            before: {
              assignee: todo.assignee,
              assigneeUserId: todo.assigneeUserId,
              reviewerId: todo.reviewerId,
              deadline: todo.deadline,
            },
            after: {
              assignee: updated.assignee,
              assigneeUserId: updated.assigneeUserId,
              reviewerId: updated.reviewerId,
              deadline: updated.deadline,
            },
          } as Prisma.InputJsonValue,
        },
      })

      /**
       * 改派、改验收人、改截止时间，都必须让当事人知道。
       *
       * 这里之前只写 todoEvent 流水：查得到，但没人会去翻。待办换了负责人，
       * 对方既不收到站内消息，也不会主动打开这场会议 —— 于是「改派」在
       * 用户感知里等于没有发生，活还是压在原负责人身上。
       */
      const notices = buildTodoNotices({
        before: todo,
        after: updated,
        actorId: user.id,
        deadlineChanged,
      })

      for (const notice of notices) {
        await this.notifyTodo(
          tx,
          todo.meetingId,
          [notice.userId],
          notice.kind,
          notice.content,
        )
      }

      return updated
    })
  }



  /**
   * 按人汇总待办负载。
   *
   * getStats 回答的是「会议开得怎么样」，这里回答「活压在谁身上」——
   * 管理者真正会问的第二个问题。数据本来就在 TodoSubmission 里攒着
   * （attemptNo、reviewedAt、rejectReason），只是没人把它按人摊开。
   *
   * 口径：
   * - 只统计当前用户可见的会议，与其它接口保持同一套数据隔离
   * - 「未完成」= OPEN / IN_PROGRESS；「待验收」= 我交了、卡在别人手里
   * - 返工次数与平均验收时长都按**提交人**归属，不是按待办负责人
   */
  async getTodoWorkload(user: AuthenticatedUser) {
    const visible = this.visibleMeetingWhere(user)

    /**
     * 平均验收时长用内存算：Prisma 的 groupBy 不支持
     * `reviewedAt - createdAt` 这类表达式聚合，写原生 SQL 又要
     * 把 visible 那套 OR 条件重拼一遍。取最近 2000 条足够反映现状，
     * 也避免整表扫。
     */
    const [statusGroups, overdueGroups, rejectedGroups, acceptedRows] =
      await Promise.all([
        this.prisma.todo.groupBy({
          by: ['assigneeUserId', 'status'],
          where: {
            assigneeUserId: { not: null },
            meeting: { is: visible },
          },
          _count: { _all: true },
        }),

        this.prisma.todo.groupBy({
          by: ['assigneeUserId'],
          where: {
            assigneeUserId: { not: null },
            status: { notIn: ['COMPLETED', 'CANCELLED'] },
            deadlineAt: { not: null, lt: new Date() },
            meeting: { is: visible },
          },
          _count: { _all: true },
        }),

        this.prisma.todoSubmission.groupBy({
          by: ['submitterId'],
          where: {
            status: 'REJECTED',
            todo: { meeting: visible },
          },
          _count: { _all: true },
        }),

        this.prisma.todoSubmission.findMany({
          where: {
            status: 'ACCEPTED',
            reviewedAt: { not: null },
            todo: { meeting: visible },
          },
          select: { submitterId: true, createdAt: true, reviewedAt: true },
          orderBy: { reviewedAt: 'desc' },
          take: 2000,
        }),
      ])

    const buckets = new Map<
      number,
      {
        openCount: number
        submittedCount: number
        completedCount: number
        overdueCount: number
        reworkCount: number
        reviewHours: number[]
      }
    >()

    const bucketOf = (userId: number) => {
      const existing = buckets.get(userId)

      if (existing) return existing

      const created = {
        openCount: 0,
        submittedCount: 0,
        completedCount: 0,
        overdueCount: 0,
        reworkCount: 0,
        reviewHours: [] as number[],
      }

      buckets.set(userId, created)

      return created
    }

    for (const row of statusGroups) {
      const userId = row.assigneeUserId

      if (userId === null) continue

      const bucket = bucketOf(userId)

      if (row.status === 'OPEN' || row.status === 'IN_PROGRESS') {
        bucket.openCount += row._count._all
      } else if (row.status === 'SUBMITTED') {
        bucket.submittedCount += row._count._all
      } else if (row.status === 'COMPLETED') {
        bucket.completedCount += row._count._all
      }
    }

    for (const row of overdueGroups) {
      if (row.assigneeUserId === null) continue

      bucketOf(row.assigneeUserId).overdueCount = row._count._all
    }

    for (const row of rejectedGroups) {
      bucketOf(row.submitterId).reworkCount = row._count._all
    }

    for (const row of acceptedRows) {
      if (!row.reviewedAt) continue

      const hours =
        (row.reviewedAt.getTime() - row.createdAt.getTime()) / 3_600_000

      if (hours >= 0) {
        bucketOf(row.submitterId).reviewHours.push(hours)
      }
    }

    const userIds = [...buckets.keys()]

    if (!userIds.length) {
      return { members: [], scope: 'visible' }
    }

    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds }, isActive: true },
      select: { id: true, name: true, avatar: true },
    })

    const nameOf = new Map(users.map((row) => [row.id, row]))

    const members = userIds
      .map((userId) => {
        const bucket = buckets.get(userId)!
        const profile = nameOf.get(userId)

        // 账号已停用或删除：待办仍留着，但不该出现在负载榜上
        if (!profile) return null

        const avgReviewHours = bucket.reviewHours.length
          ? Math.round(
            (bucket.reviewHours.reduce((sum, h) => sum + h, 0) /
              bucket.reviewHours.length) *
            10,
          ) / 10
          : null

        return {
          userId,
          name: profile.name,
          avatar: profile.avatar,
          openCount: bucket.openCount,
          submittedCount: bucket.submittedCount,
          completedCount: bucket.completedCount,
          overdueCount: bucket.overdueCount,
          reworkCount: bucket.reworkCount,
          avgReviewHours,
        }
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)
      // 活多的排前面；一样多时先看逾期，让真正堵住的人浮上来
      .sort(
        (a, b) =>
          b.openCount + b.submittedCount - (a.openCount + a.submittedCount) ||
          b.overdueCount - a.overdueCount,
      )

    return {
      members,
      /** 告诉前端这份数据只覆盖当前账号可见的会议 */
      scope: 'visible' as const,
    }
  }



  /** 更新待办事项状态。 */
  async updateTodoStatus(
    id: number,
    status: TodoStatus,
    user: AuthenticatedUser,
  ) {
    const allowedStatuses: TodoStatus[] = [
      'OPEN',
      'IN_PROGRESS',
      'SUBMITTED',
      'COMPLETED',
      'CANCELLED',
    ];

    if (!allowedStatuses.includes(status)) {
      throw new BadRequestException('无效的待办状态');
    }

    const todo = await this.prisma.todo.findUnique({
      where: { id },
    });

    if (!todo) {
      throw new NotFoundException('待办事项不存在');
    }

    /**
     * 状态只能由「该事项的验收人」或「会议负责人」修改。
     *
     * 验收人是这条待办的责任判定人，改状态等于给结论；
     * 会议负责人对整场会议的所有事项都有处置权（含创建者，不含共享编辑者）。
     * 超管是唯一的全局例外：它本来就拥有全部数据的处置权。
     */
    const access = await assertCanRead(this.prisma, user, todo.meetingId)

    const isMeetingLeader =
      access.access === 'owner' || access.leaderIds.includes(user.id)

    /** 该事项的验收人；未指定验收人时只有会议负责人能改 */
    const isTodoReviewer = todo.reviewerId !== null && todo.reviewerId === user.id

    if (!isMeetingLeader && !isTodoReviewer && user.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException(
        '只有该事项的验收人或会议负责人可以修改状态',
      );
    }

    /**
     * 只剩一个后门要堵：不能直接把状态改成 SUBMITTED
     * （必须走提交，才能留下交付记录）。
     */
    if (status === 'SUBMITTED') {
      throw new BadRequestException('请通过「提交」操作进入待验收');
    }

    if (todo.status === 'SUBMITTED') {
      throw new ConflictException('该待办正在等待验收，请先验收或撤回');
    }

    /**
     * 有验收人时也允许直接勾「已完成」，但要分清是不是验收人本人做的：
     * - 验收人本人勾完成 = 他给出结论，等同验收通过（不额外记审计）
     * - 会议负责人 / 超管代完成 = 跳过了验收环节，写一条审计留痕
     *
     * 这里刻意不补造 ACCEPTED 提交记录：没有真实交付却补一条，
     * 会把返工次数、平均验收时长这些统计口径弄脏。
     */
    const forceComplete =
      status === 'COMPLETED' && todo.reviewerId !== null && !isTodoReviewer

    // 待办状态与会议状态必须一起变，否则会出现
    // “待办全完成但会议仍显示进行中”的不一致状态。
    /**
     * 从未完成状态重新打开：事情又要做了，逾期提醒从头算。
     * 不清零的话，一条关掉过的待办会带着「已提醒 7 次」的记录回来，
     * 从此永久静音。
     */
    const reopened =
      (status === 'OPEN' || status === 'IN_PROGRESS') &&
      (todo.status === 'COMPLETED' || todo.status === 'CANCELLED')

    const [updated, completionStatus] = await this.prisma.$transaction(
      async (tx) => {
        const next = await tx.todo.update({
          where: { id },
          data: {
            status,
            ...(reopened && {
              overdueNotifiedAt: null,
              overdueNotifyCount: 0,
            }),
          },
        });

        await tx.todoEvent.create({
          data: {
            todoId: id,
            actorId: user.id,
            type: status === 'IN_PROGRESS' && todo.status === 'COMPLETED'
              ? 'reopened'
              : 'status_changed',
            fromStatus: todo.status,
            toStatus: status,
            ...(forceComplete && {
              metadata: {
                forced: true,
                reviewerId: todo.reviewerId,
              } as Prisma.InputJsonValue,
            }),
          },
        })

        return [
          next,
          await this.syncMeetingCompletionStatus(tx, todo.meetingId),
        ] as const;
      },
    );

    if (forceComplete) {
      await this.audit.record(user, {
        action: 'todo.complete_forced',
        resourceType: 'meeting',
        resourceId: todo.meetingId,
        metadata: { todoId: id, reviewerId: todo.reviewerId },
      })
    }

    return {
      id: updated.id,
      meetingId: updated.meetingId,
      content: updated.content,
      assignee: updated.assignee,
      assigneeUserId: updated.assigneeUserId,
      reviewerId: updated.reviewerId,
      deadline: updated.deadline,
      deadlineAt: updated.deadlineAt?.toISOString() ?? null,
      status: updated.status,
      /** 同步后的会议完成状态，供前端立即刷新表头，无需重新拉取整个会议。 */
      meetingCompletionStatus: completionStatus,
    };
  }
  /* =========================
     待办交付与验收
     ========================= */

  /**
   * 催办：人主动推一把。
   *
   * 与系统自动提醒的分工：
   * - OverdueReminderService 是兜底，每天一封、最多 7 次，面向所有逾期；
   * - 这里是当事人临时起意的一次提醒，指向具体的一个人。
   *
   * 少了这一环，「进度卡住了」只能靠开会解决。
   */
  async nudgeTodo(
    todoId: number,
    to: 'assignee' | 'reviewer',
    message: string | undefined,
    user: AuthenticatedUser,
  ) {
    const todo = await this.prisma.todo.findUnique({
      where: { id: todoId },
      select: {
        id: true,
        meetingId: true,
        content: true,
        status: true,
        assigneeUserId: true,
        reviewerId: true,
        meeting: { select: { leaders: { select: { userId: true } } } },
      },
    })

    if (!todo) throw new NotFoundException('待办事项不存在')

    // 读权限先过：跟这场会无关的人统一 404，不泄露待办是否存在
    const access = await assertCanRead(this.prisma, user, todo.meetingId)

    const isLeader =
      access.access === 'owner' || access.leaderIds.includes(user.id)
    const isAssignee = todo.assigneeUserId === user.id
    const isReviewer = todo.reviewerId === user.id
    const isSuper = user.role === 'SUPER_ADMIN'

    let targetIds: number[]
    let content: string

    if (to === 'assignee') {
      if (!isReviewer && !isLeader && !isSuper) {
        throw new ForbiddenException('只有验收人或会议负责人可以催办负责人')
      }

      if (!todo.assigneeUserId) {
        throw new BadRequestException('这条待办还没有指定负责人')
      }

      if (todo.assigneeUserId === user.id) {
        throw new BadRequestException('不能催自己')
      }

      targetIds = [todo.assigneeUserId]
      content = `待办「${todo.content}」被催办：请尽快推进`
    } else {
      if (!isAssignee && !isLeader && !isSuper) {
        throw new ForbiddenException('只有待办负责人或会议负责人可以催验收人')
      }

      if (todo.status !== 'SUBMITTED') {
        throw new BadRequestException('这条待办还没有待验收的交付')
      }

      // 没指定验收人时，验收责任落在会议负责人身上
      targetIds = todo.reviewerId
        ? [todo.reviewerId]
        : todo.meeting.leaders.map((leader) => leader.userId)
      content = `待办「${todo.content}」已提交，等你验收`
    }

    // 操作者本人不需要被自己催
    targetIds = [...new Set(targetIds)].filter((id) => id !== user.id)

    if (!targetIds.length) {
      throw new BadRequestException('没有可催办的对象')
    }

    const note = message?.trim()

    if (note) {
      content = `${content}；留言：${note}`
    }

    /**
     * 频率：同一条待办、同一个对象、同一个人，每天最多一次。
     *
     * 不限的话「催办」会变成刷屏工具 —— 被催的人一旦开始无视，
     * 真正紧急的那条也就失效了。
     */
    const todaysNudges = await this.prisma.todoEvent.findMany({
      where: {
        todoId,
        actorId: user.id,
        type: 'nudged',
        createdAt: { gte: startOfCstDay(new Date()) },
      },
      select: { metadata: true },
    })

    const alreadyNudged = todaysNudges.some(
      (row) => (row.metadata as { to?: string } | null)?.to === to,
    )

    if (alreadyNudged) {
      throw new ConflictException('今天已经催过了，给对方一点时间')
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.todoEvent.create({
        data: {
          todoId,
          actorId: user.id,
          type: 'nudged',
          fromStatus: todo.status,
          toStatus: todo.status,
          metadata: {
            to,
            targetIds,
            message: note ?? null,
          } as Prisma.InputJsonValue,
        },
      })

      await this.notifyTodo(
        tx,
        todo.meetingId,
        targetIds,
        'todo_nudged',
        content,
      )
    })

    return { ok: true, to, targetIds }
  }

  /**
   * 认领：把没人负责的待办揽到自己名下。
   *
   * 典型场景是 AI 只认出「李总」「小王」这类对不上账号的称呼，
   * 待办挂着 assigneeUserId=null，谁都不认。以前这类待办只能等
   * 会议负责人手动指派，现在挂进收件箱的池子，谁认谁负责。
   */
  async claimTodo(todoId: number, user: AuthenticatedUser) {
    const todo = await this.prisma.todo.findUnique({
      where: { id: todoId },
      select: {
        id: true,
        meetingId: true,
        content: true,
        status: true,
        assigneeUserId: true,
        meeting: { select: { leaders: { select: { userId: true } } } },
      },
    })

    if (!todo) throw new NotFoundException('待办事项不存在')

    await assertCanWrite(this.prisma, user, todo.meetingId)

    if (todo.assigneeUserId !== null) {
      throw new ConflictException('这条待办已经有负责人了')
    }

    if (todo.status !== 'OPEN' && todo.status !== 'IN_PROGRESS') {
      throw new BadRequestException('这条待办已提交或已结束，不能再认领')
    }

    await this.prisma.$transaction(async (tx) => {
      /**
       * CAS：两个人同时点「我来负责」时只有一个能成。
       *
       * 用带条件的 updateMany 而不是 update，是为了让冲突变成 count=0，
       * 而不是悄悄覆盖掉前一个人的认领 —— 后者会让两个人以为自己都接了。
       */
      const claimed = await tx.todo.updateMany({
        where: {
          id: todoId,
          assigneeUserId: null,
          status: { in: ['OPEN', 'IN_PROGRESS'] },
        },
        data: { assigneeUserId: user.id, assignee: user.name },
      })

      if (!claimed.count) {
        throw new ConflictException('这条待办刚被别人认领了')
      }

      // 认领人可能只是共享编辑者，补一条成员关系才打得开这场会议
      await tx.meetingMember.upsert({
        where: {
          meetingId_userId: { meetingId: todo.meetingId, userId: user.id },
        },
        create: { meetingId: todo.meetingId, userId: user.id },
        update: {},
      })

      await tx.todoEvent.create({
        data: {
          todoId,
          actorId: user.id,
          type: 'claimed',
          fromStatus: todo.status,
          toStatus: todo.status,
          metadata: { assignee: user.name } as Prisma.InputJsonValue,
        },
      })

      // 告诉会议负责人「这条有人接了」，免得他们再去手动指派一遍
      const leaders = todo.meeting.leaders
        .map((leader) => leader.userId)
        .filter((id) => id !== user.id)

      await this.notifyTodo(
        tx,
        todo.meetingId,
        leaders,
        'todo_claimed',
        `${user.name} 认领了待办「${todo.content}」`,
      )
    })

    return {
      id: todoId,
      assigneeUserId: user.id,
      assignee: user.name,
    }
  }

  /**
   * 提交交付。
   *
   * 权限：负责人本人，或会议负责人代为提交。
   * 有验收人时进入 SUBMITTED；验收人就是提交人时自动通过（不制造自己审自己的假流程）。
   */
  async submitTodo(todoId: number, note: string | undefined, user: AuthenticatedUser) {
    const todo = await this.prisma.todo.findUnique({
      where: { id: todoId },
      select: {
        id: true,
        meetingId: true,
        content: true,
        status: true,
        assigneeUserId: true,
        reviewerId: true,
        // 没有验收人时要通知会议负责人
        meeting: { select: { leaders: { select: { userId: true } } } },
      },
    })

    if (!todo) throw new NotFoundException('待办事项不存在')

    // 读权限校验放在前面：与会议无关的人统一 404
    await assertCanRead(this.prisma, user, todo.meetingId)

    /**
     * 提交是负责人的动作，负责人也不能代交。
     * 代交会让「谁承诺的、谁交付的」错位；需要别人接手时，先改派负责人。
     */
    if (todo.assigneeUserId !== user.id) {
      throw new ForbiddenException(
        todo.assigneeUserId
          ? '只有该待办的负责人可以提交'
          : '该待办还没有指定负责人，请先指派后再提交',
      )
    }

    if (todo.status !== 'OPEN' && todo.status !== 'IN_PROGRESS') {
      throw new ConflictException('只有未完成的待办可以提交')
    }

    const autoAccept = todo.reviewerId === user.id
    const nextStatus: TodoStatus = autoAccept ? 'COMPLETED' : 'SUBMITTED'

    const [submission, completionStatus] = await this.prisma.$transaction(
      async (tx) => {
        const attemptNo =
          (await tx.todoSubmission.count({ where: { todoId } })) + 1

        const created = await tx.todoSubmission.create({
          data: {
            todoId,
            submitterId: user.id,
            reviewerId: todo.reviewerId,
            note: note?.trim() || null,
            status: autoAccept ? 'ACCEPTED' : 'PENDING',
            attemptNo,
            reviewedAt: autoAccept ? new Date() : null,
          },
        })

        const moved = await tx.todo.updateMany({
          where: { id: todoId, status: { in: ['OPEN', 'IN_PROGRESS'] } },
          data: { status: nextStatus },
        })

        if (!moved.count) {
          throw new ConflictException('待办状态已变化，请刷新后重试')
        }

        await tx.todoEvent.create({
          data: {
            todoId,
            actorId: user.id,
            type: 'submitted',
            fromStatus: todo.status,
            toStatus: nextStatus,
            submissionId: created.id,
            metadata: { attemptNo, autoAccepted: autoAccept } as Prisma.InputJsonValue,
          },
        })

        if (autoAccept) {
          await tx.todoEvent.create({
            data: {
              todoId,
              actorId: user.id,
              type: 'accepted',
              fromStatus: 'SUBMITTED',
              toStatus: 'COMPLETED',
              submissionId: created.id,
              metadata: { autoAccepted: true } as Prisma.InputJsonValue,
            },
          })
        } else {
          // 没有验收人时通知会议负责人，避免提交后无人处理
          const recipients = todo.reviewerId
            ? [todo.reviewerId]
            : todo.meeting.leaders.map((l) => l.userId)

          await this.notifyTodo(
            tx,
            todo.meetingId,
            recipients.filter((id) => id !== user.id),
            'todo_submitted',
            `待办「${todo.content ?? ''}」已提交，等待验收`,
          )
        }

        return [
          created,
          await this.syncMeetingCompletionStatus(tx, todo.meetingId),
        ] as const
      },
    )

    return {
      id: submission.id,
      todoId,
      status: submission.status,
      attemptNo: submission.attemptNo,
      meetingCompletionStatus: completionStatus,
    }
  }

  /** 撤回提交：仅待验收状态、仅提交人（或会议负责人） */
  async withdrawSubmission(submissionId: number, user: AuthenticatedUser) {
    const submission = await this.loadSubmission(submissionId)

    // 先做读权限校验：与会议无关的人统一 404，不泄露提交是否存在
    await assertCanRead(this.prisma, user, submission.todo.meetingId)

    /**
     * 撤回是提交人的动作，负责人也不能代撤。
     * 负责人要反悔验收流程，应该用「打回」而不是替提交人撤回。
     */
    if (submission.submitterId !== user.id) {
      throw new ForbiddenException('只有提交人本人可以撤回')
    }

    const [updated, completionStatus] = await this.prisma.$transaction(
      async (tx) => {
        const claimed = await tx.todoSubmission.updateMany({
          where: { id: submissionId, status: 'PENDING' },
          data: { status: 'WITHDRAWN' },
        })

        if (!claimed.count) {
          throw new ConflictException('该提交已处理，无法撤回')
        }

        await tx.todo.updateMany({
          where: { id: submission.todoId, status: 'SUBMITTED' },
          data: { status: 'IN_PROGRESS' },
        })

        await tx.todoEvent.create({
          data: {
            todoId: submission.todoId,
            actorId: user.id,
            type: 'withdrawn',
            fromStatus: 'SUBMITTED',
            toStatus: 'IN_PROGRESS',
            submissionId,
          },
        })

        return [
          await tx.todoSubmission.findUniqueOrThrow({ where: { id: submissionId } }),
          await this.syncMeetingCompletionStatus(tx, submission.todo.meetingId),
        ] as const
      },
    )

    return { id: updated.id, status: updated.status, meetingCompletionStatus: completionStatus }
  }

  /** 验收通过：提交人不能验自己（提交时已自动通过），负责人可代验收并留审计 */
  async acceptSubmission(submissionId: number, user: AuthenticatedUser) {
    const submission = await this.loadSubmission(submissionId)
    await this.assertCanReview(submission, user, 'accept')

    const [updated, completionStatus, uncheckedChecklist] = await this.prisma.$transaction(
      async (tx) => {
        const claimed = await tx.todoSubmission.updateMany({
          where: { id: submissionId, status: 'PENDING' },
          data: { status: 'ACCEPTED', reviewedAt: new Date() },
        })

        if (!claimed.count) {
          throw new ConflictException('该提交已处理，请刷新后重试')
        }

        const moved = await tx.todo.updateMany({
          where: { id: submission.todoId, status: 'SUBMITTED' },
          data: { status: 'COMPLETED' },
        })

        if (!moved.count) {
          throw new ConflictException('待办状态已变化，请刷新后重试')
        }

        await tx.todoEvent.create({
          data: {
            todoId: submission.todoId,
            actorId: user.id,
            type: 'accepted',
            fromStatus: 'SUBMITTED',
            toStatus: 'COMPLETED',
            submissionId,
            metadata: {
              forced: submission.reviewerId !== user.id,
            } as Prisma.InputJsonValue,
          },
        })

        await this.notifyTodo(
          tx,
          submission.todo.meetingId,
          [submission.submitterId],
          'todo_accepted',
          `待办「${submission.todo.content}」已验收通过`,
        )

        // 清单只是提示：未勾完也允许通过，但把未勾数量带回去让前端说明
        const uncheckedChecklist = await tx.todoCheckItem.count({
          where: { todoId: submission.todoId, done: false },
        })

        return [
          await tx.todoSubmission.findUniqueOrThrow({ where: { id: submissionId } }),
          await this.syncMeetingCompletionStatus(tx, submission.todo.meetingId),
          uncheckedChecklist,
        ] as const
      },
    )

    if (submission.reviewerId !== user.id) {
      await this.audit.record(user, {
        action: 'todo.accept_forced',
        resourceType: 'meeting',
        resourceId: submission.todo.meetingId,
        metadata: { todoId: submission.todoId, submissionId },
      })
    }

    return {
      id: updated.id,
      status: updated.status,
      meetingCompletionStatus: completionStatus,
      /** 还有几条验收要点没勾；前端据此提示「未勾完也通过了」 */
      uncheckedChecklist,
    }
  }

  /** 打回：原因必填（≥5 字），待办退回进行中 */
  async rejectSubmission(
    submissionId: number,
    reason: string,
    user: AuthenticatedUser,
  ) {
    const text = (reason ?? '').trim()

    if (text.length < 5) {
      throw new BadRequestException('请填写至少 5 个字的打回原因')
    }

    const submission = await this.loadSubmission(submissionId)
    await this.assertCanReview(submission, user, 'reject')

    const [updated, completionStatus] = await this.prisma.$transaction(
      async (tx) => {
        const claimed = await tx.todoSubmission.updateMany({
          where: { id: submissionId, status: 'PENDING' },
          data: {
            status: 'REJECTED',
            rejectReason: text,
            reviewedAt: new Date(),
          },
        })

        if (!claimed.count) {
          throw new ConflictException('该提交已处理，请刷新后重试')
        }

        await tx.todo.updateMany({
          where: { id: submission.todoId, status: 'SUBMITTED' },
          data: { status: 'IN_PROGRESS' },
        })

        await tx.todoEvent.create({
          data: {
            todoId: submission.todoId,
            actorId: user.id,
            type: 'rejected',
            fromStatus: 'SUBMITTED',
            toStatus: 'IN_PROGRESS',
            submissionId,
            metadata: { reason: text } as Prisma.InputJsonValue,
          },
        })

        await this.notifyTodo(
          tx,
          submission.todo.meetingId,
          [submission.submitterId],
          'todo_rejected',
          `待办「${submission.todo.content}」被打回：${text}`,
        )

        return [
          await tx.todoSubmission.findUniqueOrThrow({ where: { id: submissionId } }),
          await this.syncMeetingCompletionStatus(tx, submission.todo.meetingId),
        ] as const
      },
    )

    return { id: updated.id, status: updated.status, meetingCompletionStatus: completionStatus }
  }

  /** 某条待办的提交时间线（含附件元信息） */
  async listTodoSubmissions(todoId: number, user: AuthenticatedUser) {
    const todo = await this.prisma.todo.findUnique({
      where: { id: todoId },
      select: {
        meetingId: true,
        assigneeUserId: true,
        reviewerId: true,
      },
    })

    if (!todo) throw new NotFoundException('待办事项不存在')

    const access = await assertCanRead(this.prisma, user, todo.meetingId)

    /**
     * 只有与这条待办直接相关的人能看提交内容：
     * 负责人（提交对象）、验收人、会议负责人/创建者、超管。
     * 其他成员与共享者只能看到「第几次、什么时候、什么状态」。
     */
    const relatedToTodo =
      access.access === 'owner' ||
      access.leaderIds.includes(user.id) ||
      todo.assigneeUserId === user.id ||
      todo.reviewerId === user.id ||
      user.role === 'SUPER_ADMIN'

    const rows = await this.prisma.todoSubmission.findMany({
      where: { todoId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        note: true,
        attemptNo: true,
        rejectReason: true,
        reviewedAt: true,
        createdAt: true,
        submitterId: true,
        submitter: { select: { id: true, name: true } },
        reviewer: { select: { id: true, name: true } },
        attachments: {
          select: {
            id: true,
            fileName: true,
            mimeType: true,
            sizeBytes: true,
            createdAt: true,
          },
        },
      },
    })

    return rows.map((row) => {
      const createdAt = row.createdAt.toISOString()

      // 提交人本人即使后来被改派，也仍然能看到自己交过的东西
      const canViewContent = relatedToTodo || row.submitterId === user.id

      if (!canViewContent) {
        return {
          id: row.id,
          status: row.status,
          attemptNo: row.attemptNo,
          createdAt,
          reviewedAt: null,
          note: null,
          rejectReason: null,
          // 提交人属于元信息：让成员知道是谁交的，但看不到交了什么
          submitter: row.submitter,
          reviewer: null,
          attachments: [],
          canViewContent: false,
        }
      }

      return {
        id: row.id,
        status: row.status,
        attemptNo: row.attemptNo,
        createdAt,
        reviewedAt: row.reviewedAt?.toISOString() ?? null,
        note: row.note,
        rejectReason: row.rejectReason,
        submitter: row.submitter,
        reviewer: row.reviewer,
        attachments: row.attachments.map((a) => ({
          ...a,
          createdAt: a.createdAt.toISOString(),
          url: `/api/meetings/todos/${todoId}/submissions/${row.id}/attachments/${a.id}`,
        })),
        canViewContent: true,
      }
    })
  }

  /** 待办流转时间线 */
  async listTodoEvents(todoId: number, user: AuthenticatedUser) {
    const todo = await this.prisma.todo.findUnique({
      where: { id: todoId },
      select: {
        meetingId: true,
        assigneeUserId: true,
        reviewerId: true,
      },
    })

    if (!todo) throw new NotFoundException('待办事项不存在')

    const access = await assertCanRead(this.prisma, user, todo.meetingId)

    const relatedToTodo =
      access.access === 'owner' ||
      access.leaderIds.includes(user.id) ||
      todo.assigneeUserId === user.id ||
      todo.reviewerId === user.id ||
      user.role === 'SUPER_ADMIN'

    const rows = await this.prisma.todoEvent.findMany({
      where: { todoId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        type: true,
        fromStatus: true,
        toStatus: true,
        submissionId: true,
        metadata: true,
        createdAt: true,
        actor: { select: { id: true, name: true } },
      },
    })

    return rows.map((row) => ({
      ...row,
      // 打回原因属于提交内容，无关的人只看到「被打回」这个事实
      metadata:
        !relatedToTodo && row.type === 'rejected' ? null : row.metadata,
      createdAt: row.createdAt.toISOString(),
    }))
  }

  /**
   * 给某次提交追加交付物。
   *
   * 约束：仅提交人本人或会议负责人可加；仅待验收状态可加（验收后再加会让验收结论失效）。
   * 单次提交最多 5 个文件，单文件大小由控制器层的 multer 限制。
   */
  async addSubmissionAttachment(
    submissionId: number,
    file: { originalname: string; mimetype: string; size: number; path: string; filename: string },
    user: AuthenticatedUser,
  ) {
    const submission = await this.loadSubmission(submissionId)
    const access = await assertCanRead(
      this.prisma,
      user,
      submission.todo.meetingId,
    )

    const isLeader =
      access.access === 'owner' ||
      access.leaderIds.includes(user.id) ||
      access.capabilities.canEdit

    if (submission.submitterId !== user.id && !isLeader) {
      throw new ForbiddenException('只有提交人本人或会议负责人可以补充交付物')
    }

    if (submission.status !== 'PENDING') {
      throw new ConflictException('该提交已处理，不能再补充交付物')
    }

    const count = await this.prisma.todoAttachment.count({
      where: { submissionId },
    })

    if (count >= 5) {
      throw new BadRequestException('单次提交最多 5 个附件')
    }

    const created = await this.prisma.todoAttachment.create({
      data: {
        submissionId,
        fileName: file.originalname.slice(0, 255),
        mimeType: file.mimetype.slice(0, 128) || 'application/octet-stream',
        sizeBytes: file.size,
        // 相对 backend 运行目录保存，换机器后仍能定位
        storedPath: `uploads/todos/${submissionId}/${file.filename}`,
      },
    })

    await this.prisma.todoEvent.create({
      data: {
        todoId: submission.todoId,
        actorId: user.id,
        type: 'attachment_added',
        submissionId,
        metadata: { attachmentId: created.id, fileName: created.fileName } as Prisma.InputJsonValue,
      },
    })

    return {
      id: created.id,
      fileName: created.fileName,
      mimeType: created.mimeType,
      sizeBytes: created.sizeBytes,
      url: `/api/meetings/todos/${submission.todoId}/submissions/${submissionId}/attachments/${created.id}`,
    }
  }

  /** 校验下载权限并返回磁盘位置 */
  async resolveSubmissionAttachment(
    todoId: number,
    submissionId: number,
    attachmentId: number,
    user: AuthenticatedUser,
  ) {
    const attachment = await this.prisma.todoAttachment.findFirst({
      where: {
        id: attachmentId,
        submissionId,
        submission: { todoId },
      },
      select: {
        id: true,
        fileName: true,
        mimeType: true,
        storedPath: true,
        submission: {
          select: {
            submitterId: true,
            todo: {
              select: {
                meetingId: true,
                assigneeUserId: true,
                reviewerId: true,
              },
            },
          },
        },
      },
    })

    if (!attachment) throw new NotFoundException('附件不存在')

    const access = await assertCanRead(
      this.prisma,
      user,
      attachment.submission.todo.meetingId,
    )

    /**
     * 附件是提交内容的一部分：只有负责人、验收人、会议负责人/创建者、超管，
     * 以及该次提交的提交人本人可以下载。其他成员只能看到「有几次提交」。
     */
    const canView =
      access.access === 'owner' ||
      access.leaderIds.includes(user.id) ||
      attachment.submission.submitterId === user.id ||
      attachment.submission.todo.assigneeUserId === user.id ||
      attachment.submission.todo.reviewerId === user.id ||
      user.role === 'SUPER_ADMIN'

    if (!canView) {
      throw new ForbiddenException('只有与该待办相关的人员可以查看提交内容')
    }

    return {
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      absolutePath: join(process.cwd(), attachment.storedPath),
    }
  }

  /**
   * 删除会议前清理交付物文件。
   *
   * 附件是磁盘文件，不参与外键级联；记录删了文件还在，uploads 卷会攒孤儿。
   * 清理失败只记日志，不能因此挡住删除。
   */
  async removeTodoAttachmentFiles(meetingId: number) {
    const attachments = await this.prisma.todoAttachment.findMany({
      where: { submission: { todo: { meetingId } } },
      select: { storedPath: true },
    })

    for (const attachment of attachments) {
      try {
        await unlink(join(process.cwd(), attachment.storedPath))
      } catch {
        // 文件已不存在或权限不足：不影响数据库记录的级联删除
      }
    }
  }

  /* =========================
     验收要点（清单）
     ========================= */

  /**
   * 覆盖式设置验收要点。
   *
   * 待验收期间禁止修改：验收人正在按清单核对，这时换清单等于移动球门。
   * 最多 20 条，单条 200 字；空数组表示清空。
   */
  async setTodoChecklist(todoId: number, items: string[], user: AuthenticatedUser) {
    const todo = await this.prisma.todo.findUnique({
      where: { id: todoId },
      select: { meetingId: true, status: true },
    })

    if (!todo) throw new NotFoundException('待办事项不存在')

    await assertCanWrite(this.prisma, user, todo.meetingId)

    if (todo.status === 'SUBMITTED') {
      throw new ConflictException('待验收期间不能修改验收要点，请先验收或撤回')
    }

    const contents = items
      .map((item) => (item ?? '').trim())
      .filter(Boolean)
      .slice(0, 20)
      .map((item) => item.slice(0, 200))

    const rows = await this.prisma.$transaction(async (tx) => {
      await tx.todoCheckItem.deleteMany({ where: { todoId } })

      if (contents.length) {
        await tx.todoCheckItem.createMany({
          data: contents.map((content, sortOrder) => ({
            todoId,
            content,
            sortOrder,
          })),
        })
      }

      await tx.todoEvent.create({
        data: {
          todoId,
          actorId: user.id,
          type: 'checklist_updated',
          metadata: { count: contents.length } as Prisma.InputJsonValue,
        },
      })

      return tx.todoCheckItem.findMany({
        where: { todoId },
        orderBy: { sortOrder: 'asc' },
        select: {
          id: true,
          content: true,
          done: true,
          doneById: true,
          doneAt: true,
          doneBy: { select: { id: true, name: true } },
        },
      })
    })

    return {
      todoId,
      checklist: rows.map((row) => ({
        id: row.id,
        content: row.content,
        done: row.done,
        doneById: row.doneById ?? null,
        doneByName: row.doneBy?.name ?? null,
        doneAt: row.doneAt?.toISOString() ?? null,
      })),
    }
  }

  /** 勾选 / 取消一条验收要点；不改待办状态 */
  async toggleTodoCheckItem(
    todoId: number,
    itemId: number,
    done: boolean,
    user: AuthenticatedUser,
  ) {
    const item = await this.prisma.todoCheckItem.findFirst({
      where: { id: itemId, todoId },
      select: {
        id: true,
        content: true,
        todo: { select: { meetingId: true } },
      },
    })

    if (!item) throw new NotFoundException('验收要点不存在')

    // 成员也可以勾：清单是核对工具，不应该只有负责人能打勾
    await assertCanEditTodos(this.prisma, user, item.todo.meetingId)

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.todoCheckItem.update({
        where: { id: itemId },
        data: {
          done,
          doneById: done ? user.id : null,
          doneAt: done ? new Date() : null,
        },
      })

      await tx.todoEvent.create({
        data: {
          todoId,
          actorId: user.id,
          type: done ? 'check_checked' : 'check_unchecked',
          metadata: { itemId, content: item.content } as Prisma.InputJsonValue,
        },
      })

      return next
    })

    return {
      id: updated.id,
      done: updated.done,
      doneByName: done ? user.name : null,
      doneAt: updated.doneAt?.toISOString() ?? null,
    }
  }

  /** 读取提交及其待办、会议归属，供验收类操作复用 */
  private async loadSubmission(submissionId: number) {
    const submission = await this.prisma.todoSubmission.findUnique({
      where: { id: submissionId },
      select: {
        id: true,
        status: true,
        submitterId: true,
        reviewerId: true,
        todoId: true,
        todo: {
          select: {
            content: true,
            meetingId: true,
          },
        },
      },
    })

    if (!submission) throw new NotFoundException('提交记录不存在')

    return submission
  }

  /** 谁能验收：指定验收人，或会议创建者/负责人/管理员（代验收） */
  private async assertCanReview(
    submission: SubmissionForReview,
    user: AuthenticatedUser,
    action: 'accept' | 'reject',
  ) {
    const access = await assertCanRead(
      this.prisma,
      user,
      submission.todo.meetingId,
    )

    const allowed =
      submission.reviewerId === user.id ||
      access.access === 'owner' ||
      access.leaderIds.includes(user.id) ||
      access.capabilities.canEdit

    if (!allowed) {
      throw new ForbiddenException(
        action === 'accept'
          ? '只有验收人或会议负责人可以确认通过'
          : '只有验收人或会议负责人可以打回',
      )
    }

    /**
     * 自己不能验自己。
     * 验收人等于提交人时提交阶段已自动通过，走不到这里；
     * 这一条挡的是「创建者/负责人给自己的交付盖章」。
     */
    if (submission.submitterId === user.id) {
      throw new ForbiddenException('不能验收自己提交的交付，请让其他负责人或验收人处理')
    }

    if (submission.status !== 'PENDING') {
      throw new ConflictException('该提交已处理，请刷新后重试')
    }
  }

  /** 写一条待办相关的收件箱消息；没有收件人就跳过 */
  private async notifyTodo(
    tx: Prisma.TransactionClient,
    meetingId: number,
    userIds: number[],
    kind: string,
    content: string,
  ) {
    const targets = [...new Set(userIds)].filter((id) => Number.isFinite(id))

    if (!targets.length) return

    await tx.meetingNotice.createMany({
      data: targets.map((userId) => ({
        userId,
        meetingId,
        kind,
        content,
      })),
    })
  }

  private async syncMeetingCompletionStatus(
    tx: Prisma.TransactionClient,
    meetingId: number,
  ): Promise<MeetingCompletionStatus> {
    /**
     * 锁住会议行再统计待办。
     *
     * 同一场会议的两条待办同时被勾完时，两个事务各自读待办列表（都读不到
     * 对方未提交的改动），都算出「还有未完成」，后提交的那个会把先提交的
     * COMPLETED 覆盖回 IN_PROGRESS —— 会议永远停在「进行中」。
     *
     * 加行锁后这两个事务串行执行：后一个提交前会重新读一次（READ COMMITTED
     * 下每条语句取新快照），看到前一个的结果再推算，状态就正确了。
     */
    await tx.$queryRaw`SELECT id FROM meetings WHERE id = ${meetingId} FOR UPDATE`;

    const meeting = await tx.meeting.findUnique({
      where: { id: meetingId },
      select: { completionStatus: true },
    });

    if (!meeting) {
      throw new NotFoundException('会议记录不存在');
    }

    // 用户主动取消的会议不参与自动流转。
    if (meeting.completionStatus === 'CANCELLED') {
      return meeting.completionStatus;
    }

    const todos = await tx.todo.findMany({
      where: { meetingId },
      select: { status: true },
    });

    const next = resolveCompletionStatus(
      meeting.completionStatus,
      todos.map((todo) => todo.status),
    );

    if (next === meeting.completionStatus) {
      return next;
    }

    await tx.meeting.update({
      where: { id: meetingId },
      data: { completionStatus: next },
    });

    return next;
  }
  /**
   * 解析待办的默认验收人：未指定验收人时，取会议负责人；负责人有多个时取创建者。
   * 返回 null 仅当会议既没有负责人也没有创建者（理论上不会发生）。
   */
  private async resolveDefaultReviewerId(meetingId: number): Promise<number | null> {
    const meeting = await this.prisma.meeting.findUnique({
      where: { id: meetingId },
      select: {
        ownerId: true,
        leaders: { select: { userId: true }, orderBy: { createdAt: 'asc' as const } },
      },
    })

    if (!meeting) throw new NotFoundException('会议不存在')

    const leaderIds = meeting.leaders.map((l) => l.userId)

    if (leaderIds.length === 0) return meeting.ownerId
    if (leaderIds.length === 1) return leaderIds[0]

    // 多个负责人：默认创建者；创建者不在负责人列表时，退回第一个负责人
    return leaderIds.includes(meeting.ownerId) ? meeting.ownerId : leaderIds[0]
  }

  async createTodo(
    meetingId: number,
    data: {
      content: string;
      assignee?: string;
      assigneeUserId?: number | null;
      reviewerId?: number | null;
      deadline?: string;
      deadlineAt?: string | null;
    },
    user: AuthenticatedUser,
  ) {
    await assertCanWrite(this.prisma, user, meetingId);

    // 指定了负责人 ID 就以账号姓名为准，文本只作展示
    let assignee = data.assignee?.trim() || null

    if (data.assigneeUserId) {
      const target = await this.prisma.user.findUnique({
        where: { id: data.assigneeUserId },
        select: { name: true, isActive: true },
      })

      if (!target) throw new NotFoundException('指定的负责人不存在')
      if (!target.isActive) throw new BadRequestException('该账号已停用，不能担任负责人')

      assignee = target.name
    }

    // 未指定验收人时，默认会议负责人（多个时默认创建者）
    let reviewerId = data.reviewerId ?? null
    if (!reviewerId) {
      reviewerId = await this.resolveDefaultReviewerId(meetingId)
    }

    if (reviewerId) {
      const reviewer = await this.prisma.user.findUnique({
        where: { id: reviewerId },
        select: { isActive: true },
      })

      if (!reviewer) throw new NotFoundException('指定的验收人不存在')
      if (!reviewer.isActive) throw new BadRequestException('该账号已停用，不能担任验收人')
    }

    // 新增的待办一定是未完成状态，因此会议不再是“全部完成”。
    const createdDeadlineAt = data.deadlineAt
      ? parseDeadlineAt(data.deadlineAt)
      : parseDeadlineAt(data.deadline)

    /**
     * 只给结构化时间、没给文本时，用日期补一个展示文本。
     *
     * 列表渲染的是 `deadline` 文本；留空的话，用户明明选了 11/09，
     * 卡片上却写着「未指定」—— 看起来像没存上。
     */
    const createdDeadline =
      data.deadline?.trim() ||
      (createdDeadlineAt ? formatCstDate(createdDeadlineAt) : null)

    const [todo, completionStatus] = await this.prisma.$transaction(
      async (tx) => {
        const created = await tx.todo.create({
          data: {
            meetingId,
            content: data.content.trim(),
            assignee,
            assigneeUserId: data.assigneeUserId ?? null,
            reviewerId: reviewerId ?? null,
            deadline: createdDeadline,
            deadlineAt: createdDeadlineAt,
            status: 'OPEN',
            sortOrder: 0,
          },
        });

        await tx.todoEvent.create({
          data: {
            todoId: created.id,
            actorId: user.id,
            type: 'created',
            toStatus: 'OPEN',
            metadata: {
              assigneeUserId: created.assigneeUserId,
              reviewerId: created.reviewerId,
            } as Prisma.InputJsonValue,
          },
        })

        // 负责人与验收人都必须能看到这场会议，否则打开待办只会拿到 404
        const membersToAdd = [created.assigneeUserId, created.reviewerId].filter(
          (userId): userId is number => !!userId,
        )

        for (const userId of [...new Set(membersToAdd)]) {
          await tx.meetingMember.upsert({
            where: { meetingId_userId: { meetingId, userId } },
            create: { meetingId, userId },
            update: {},
          })
        }

        // 创建时就指派了负责人：对方不会自己去翻这场会议，得主动告诉他
        if (created.assigneeUserId && created.assigneeUserId !== user.id) {
          await this.notifyTodo(
            tx,
            meetingId,
            [created.assigneeUserId],
            'todo_assigned',
            `你被指派了待办「${created.content}」`,
          )
        }

        return [
          created,
          await this.syncMeetingCompletionStatus(tx, meetingId),
        ] as const;
      },
    );

    return {
      id: todo.id,
      meetingId: todo.meetingId,
      content: todo.content,
      assignee: todo.assignee,
      assigneeUserId: todo.assigneeUserId,
      reviewerId: todo.reviewerId,
      deadline: todo.deadline,
      deadlineAt: todo.deadlineAt?.toISOString() ?? null,
      status: todo.status,
      meetingCompletionStatus: completionStatus,
    };
  }
  /** 删除单条待办事项 */
  async removeTodo(id: number, user: AuthenticatedUser) {
    const todo = await this.prisma.todo.findUnique({
      where: { id },
    });

    if (!todo) {
      throw new NotFoundException('待办事项不存在');
    }

    await assertCanWrite(this.prisma, user, todo.meetingId);

    // 删掉的若是最后一项未完成待办，会议同样应变为已完成。
    const completionStatus = await this.prisma.$transaction(
      async (tx) => {
        await tx.todo.delete({
          where: { id },
        });

        return this.syncMeetingCompletionStatus(tx, todo.meetingId);
      },
    );

    return {
      message: '待办事项删除成功',
      id,
      meetingId: todo.meetingId,
      meetingCompletionStatus: completionStatus,
    };
  }
}
