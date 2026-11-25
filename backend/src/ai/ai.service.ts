import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import OpenAI from 'openai';
import { createHash } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { hasTenantWideMeetingAccess } from '../meetings/meetings.access';
import { resolveMeetingSpace } from '../meetings/meetings.invite';
import { PrismaService } from '../common/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.decorators';
import { cstDayKey } from '../common/datetime';
import { assertCanRead, assertCanWrite } from '../meetings/meetings.access';
import { buildAskSystemPrompt } from './meeting-context';

@Injectable()
export class AiService {
  /** 结构化日志：代替 console，便于按级别检索 */
  private readonly logger = new Logger(AiService.name);

  private readonly client: OpenAI;

  constructor(
    private readonly prisma: PrismaService,
  ) {
    this.client = new OpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseURL: 'https://api.deepseek.com',
    });
  }

  async generateMeetingSummary(
    content: string,
    user: AuthenticatedUser,
    /** 会议归属的空间；不传 = 当前空间 */
    tenantId?: string,
  ) {
    if (!content || !content.trim()) {
      throw new Error('会议内容不能为空');
    }

    // 保存当前会议 ID。
    // 即使后面的 AI 调用失败，也可以把这条会议标记为 FAILED。
    let meetingId: number | null = null;

    try {
      /**
       * 第一步：
       * 先保存会议原文。
       *
       * 此时 AI 还没有生成结果，所以状态设置为 PROCESSING。
       */
      const processingMeeting = await this.prisma.meeting.create({
        data: {
          title: 'AI生成会议纪要',
          content,
          summary: null,
          status: 'PROCESSING',
          // 归属发起该请求的用户，保证生成结果不会跨用户可见
          ownerId: user.id,
          // 会议归属的空间。由调用方透传（用户在表单里选的），缺省为当前空间。
          tenantId: tenantId ?? user.activeTenantId,
          // 每场会议至少一位负责人，AI 生成的会议由发起者担任（多负责人是关联表）
          leaders: { create: [{ userId: user.id }] },
        },
      });

      meetingId = processingMeeting.id;

      this.logger.log(
        `会议 ${meetingId} 已保存，开始调用 DeepSeek...`,
      );

      /**
       * 第二步：
       * 调用 DeepSeek。
       */
      const response =
        await this.client.chat.completions.create({
          model:
            process.env.DEEPSEEK_MODEL ||
            'deepseek-flash',

          messages: [
            {
              role: 'system',
              content: `
你是一个专业的智能会议纪要助手。

请分析用户提供的会议内容，并提取以下信息。

必须返回合法的 JSON。

JSON 必须包含以下三个字段：

summary：会议内容摘要，字符串类型。

decisions：会议中已经确定的决策，字符串数组。

todos：会议中的待办事项，对象数组。

todos 中每个对象必须包含：

task：任务名称
assignee：负责人
deadline：截止时间

例如返回：

{
  "summary": "本次会议讨论了产品需求和开发安排。",
  "decisions": [
    "第一版产品支持邮箱登录"
  ],
  "todos": [
    {
      "task": "首页UI设计",
      "assignee": "张三",
      "deadline": "本周五"
    }
  ]
}

规则：

1. summary 必须是字符串。
2. decisions 必须是字符串数组。
3. todos 必须是对象数组。
4. task、assignee、deadline 都必须是字符串。
5. 如果没有明确决策，decisions 返回空数组。
6. 如果没有明确负责人，assignee 填写“未指定”。
7. 如果没有明确截止时间，deadline 填写“未指定”。
8. 只能根据会议原文提取信息。
9. 不允许编造会议中不存在的信息。
10. 必须输出 JSON。
11. 不要输出 Markdown。
`,
            },
            {
              role: 'user',
              content: content,
            },
          ],

          response_format: {
            type: 'json_object',
          },

          stream: false,
        });

      /**
       * 第三步：
       * 获取 AI 返回结果并解析 JSON。
       */
      const result =
        response.choices[0]?.message?.content || '{}';

      const data = JSON.parse(result);

      /**
       * 第四步：
       * AI 成功后更新原来的 PROCESSING 记录。
       *
       * 同时创建决策和待办。
       */
      const meeting =
        await this.prisma.meeting.update({
          where: {
            id: meetingId,
          },

          data: {
            summary: data.summary || '',
            status: 'READY',

            decisions: {
              create: (
                Array.isArray(data.decisions)
                  ? data.decisions
                  : []
              ).map(
                (
                  decision: string,
                  index: number,
                ) => ({
                  content: decision,
                  sortOrder: index,
                }),
              ),
            },

            todos: {
              create: (
                Array.isArray(data.todos)
                  ? data.todos
                  : []
              ).map(
                (
                  todo: {
                    task: string;
                    assignee: string;
                    deadline: string;
                  },
                  index: number,
                ) => ({
                  content: todo.task,
                  assignee:
                    todo.assignee || '未指定',
                  deadline:
                    todo.deadline || '未指定',
                  sortOrder: index,
                }),
              ),
            },
          },

          include: {
            decisions: true,
            todos: true,
          },
        });

      this.logger.log(
        `会议 ${meetingId} AI 纪要生成成功`,
      );

      return meeting;
    } catch (error: any) {
      this.logger.error(
        '================ AI 生成失败 ================',
      );

      this.logger.error(
        '会议 ID:',
        meetingId,
      );

      this.logger.error(
        '错误信息:',
        error?.message,
      );

      this.logger.error(
        '错误状态:',
        error?.status,
      );

      this.logger.error(
        '错误类型:',
        error?.type,
      );

      this.logger.error(
        '完整错误:',
        error,
      );

      /**
       * AI 调用失败时：
       * 保留会议原文，只把状态改成 FAILED。
       */
      if (meetingId !== null) {
        try {
          await this.prisma.meeting.update({
            where: {
              id: meetingId,
            },

            data: {
              status: 'FAILED',
            },
          });

          this.logger.log(
            `会议 ${meetingId} 已标记为 FAILED`,
          );
        } catch (statusError) {
          this.logger.error(
            '更新会议 FAILED 状态失败:',
            statusError,
          );
        }
      }

      this.logger.error(
        '=============================================',
      );

      throw new InternalServerErrorException(
        error?.message ||
        'DeepSeek API 调用失败',
      );
    }
  }
  /**
 * 重新生成已有会议的 AI 纪要。
 *
 * 不创建新的会议记录，保留原来的会议 ID 和会议原文。
 */
  async regenerateMeetingSummary(
    id: number,
    user: AuthenticatedUser,
  ) {
    // 重新生成会覆盖摘要与待办，属于写操作，需要该会议的写权限
    await assertCanWrite(this.prisma, user, id);

    this.consumeGenerateQuota(user.id);

    const meeting = await this.prisma.meeting.findUnique({
      where: { id },
      include: {
        decisions: true,
        todos: true,
      },
    });

    if (!meeting) {
      throw new Error('会议记录不存在');
    }

    if (!meeting.content?.trim()) {
      throw new Error('会议原文为空，无法重新生成');
    }

    /**
     * 抢占这场会议。同时点两次「重新生成」时，只让一个进去 ——
     * 否则两次调用都会先删掉旧纪要再各自重建，最后留下谁的待办全靠时序。
     *
     * 用带条件的 updateMany 做成一次 CAS，抢不到直接 409。
     * 允许抢占「卡在 PROCESSING 超过 10 分钟」的记录：进程崩溃或
     * 上游超时会把状态留在 PROCESSING，不能让人永远无法重试。
     */
    const staleBefore = new Date(Date.now() - 10 * 60 * 1000);

    const claimed = await this.prisma.meeting.updateMany({
      where: {
        id,
        OR: [
          { status: { not: 'PROCESSING' } },
          { updatedAt: { lt: staleBefore } },
        ],
      },
      data: { status: 'PROCESSING' },
    });

    if (!claimed.count) {
      throw new ConflictException('这场会议正在重新生成，请稍后再试');
    }

    try {
      /**
       * 删掉旧的 AI 结果，防止重新生成后出现重复的决策和待办。
       * （状态已在上面用 CAS 置为 PROCESSING，这里不再重复 update）
       */
      await this.prisma.decision.deleteMany({
        where: {
          meetingId: id,
        },
      });

      await this.prisma.todo.deleteMany({
        where: {
          meetingId: id,
        },
      });

      /**
       * 第二步：调用 DeepSeek。
       */
      const response =
        await this.client.chat.completions.create({
          model:
            process.env.DEEPSEEK_MODEL ||
            'deepseek-flash',

          messages: [
            {
              role: 'system',
              content: `
你是一个专业的智能会议纪要助手。

请分析用户提供的会议内容，并提取以下信息。

必须返回合法的 JSON。

JSON 必须包含以下三个字段：

summary：会议内容摘要，字符串类型。

decisions：会议中已经确定的决策，字符串数组。

todos：会议中的待办事项，对象数组。

todos 中每个对象必须包含：

task：任务名称
assignee：负责人
deadline：截止时间

规则：

1. summary 必须是字符串。
2. decisions 必须是字符串数组。
3. todos 必须是对象数组。
4. task、assignee、deadline 都必须是字符串。
5. 如果没有明确决策，decisions 返回空数组。
6. 如果没有明确负责人，assignee 填写“未指定”。
7. 如果没有明确截止时间，deadline 填写“未指定”。
8. 只能根据会议原文提取信息。
9. 不允许编造会议中不存在的信息。
10. 必须输出 JSON。
11. 不要输出 Markdown。
`,
            },
            {
              role: 'user',
              content: meeting.content,
            },
          ],

          response_format: {
            type: 'json_object',
          },

          stream: false,
        });

      /**
       * 第四步：
       * 解析 AI 结果。
       */
      const result =
        response.choices[0]?.message?.content || '{}';

      const data = JSON.parse(result);

      /**
       * 第五步：
       * 更新原会议记录。
       */
      const updatedMeeting =
        await this.prisma.meeting.update({
          where: {
            id,
          },

          data: {
            summary: data.summary || '',
            status: 'READY',

            decisions: {
              create: (
                Array.isArray(data.decisions)
                  ? data.decisions
                  : []
              ).map(
                (
                  decision: string,
                  index: number,
                ) => ({
                  content: decision,
                  sortOrder: index,
                }),
              ),
            },

            todos: {
              create: (
                Array.isArray(data.todos)
                  ? data.todos
                  : []
              ).map(
                (
                  todo: {
                    task: string;
                    assignee: string;
                    deadline: string;
                  },
                  index: number,
                ) => ({
                  content: todo.task,
                  assignee:
                    todo.assignee || '未指定',
                  deadline:
                    todo.deadline || '未指定',
                  sortOrder: index,
                }),
              ),
            },
          },

          include: {
            decisions: true,
            todos: true,
          },
        });

      this.logger.log(
        `会议 ${id} 重新生成成功`,
      );

      return updatedMeeting;
    } catch (error: any) {
      this.logger.error(
        `会议 ${id} 重新生成失败:`,
        error,
      );

      /**
       * 保留会议原文，只将状态恢复为 FAILED。
       */
      await this.prisma.meeting.update({
        where: { id },

        data: {
          status: 'FAILED',
        },
      });

      throw new InternalServerErrorException(
        error?.message ||
        '重新生成会议纪要失败',
      );
    }
  }
  /* =========================================================
     异步生成：建任务 → 后台执行 → 前端轮询
     ========================================================= */

  /**
   * 发起一次生成任务，立即返回任务 id。
   *
   * 同一个人对同一段内容重复提交时，复用还在跑的任务，
   * 避免"点了三次产生三条记录、烧三次额度"。
   */
  /**
   * 启动时清理中断的任务。
   *
   * 生成在进程内执行，服务重启会让 RUNNING 的任务永远停在运行中、
   * 对应会议也卡在 PROCESSING。这里统一标记为失败，让用户能重试。
   */
  async onModuleInit() {
    const stale = await this.prisma.meetingGeneration.findMany({
      where: { status: { in: ['PENDING', 'RUNNING'] } },
      select: { id: true, meetingId: true },
    });

    if (!stale.length) {
      return;
    }

    await this.prisma.meetingGeneration.updateMany({
      where: { id: { in: stale.map((item) => item.id) } },
      data: {
        status: 'FAILED',
        error: '服务重启，生成任务中断，请重新提交',
        finishedAt: new Date(),
      },
    });

    const meetingIds = stale
      .map((item) => item.meetingId)
      .filter((id): id is number => typeof id === 'number');

    if (meetingIds.length) {
      await this.prisma.meeting.updateMany({
        where: { id: { in: meetingIds } },
        data: { status: 'FAILED' },
      });
    }

    this.logger.warn(`已清理 ${stale.length} 个中断的生成任务（服务重启）`);
  }

  async startGeneration(
    content: string,
    user: AuthenticatedUser,
    /** 会议要落到哪个空间；不传 = 当前空间 */
    tenantId?: string,
  ) {
    const trimmed = content?.trim() ?? '';

    if (!trimmed) {
      throw new InternalServerErrorException('会议内容不能为空');
    }

    /**
     * 先校验空间归属再建任务。
     *
     * 任务的 tenantId 必须和它将要创建的会议一致，否则按租户恢复任务时会错位
     * （见 runGeneration 里的说明）。校验不通过抛 404，不消耗额度。
     */
    const space = resolveMeetingSpace(user, tenantId);

    this.consumeGenerateQuota(user.id);

    const contentHash = createHash('sha256').update(trimmed).digest('hex');

    /**
     * 「查有没有在跑」和「建一条任务」之间有竞态：同一份内容连点两下，
     * 两个请求都查不到在跑的任务，于是各自建一条，结果是两次大模型调用、
     * 两条会议记录、双倍费用。
     *
     * 用事务级 advisory lock 按（用户 + 内容哈希）串行化这一段：
     * 后到的请求会等前一个事务提交，然后看到 running 直接复用。
     * 锁随事务结束自动释放，不需要额外维护一张锁表。
     */
    const { generation, reused } = await this.prisma.$transaction(
      async (tx) => {
        const lockKey = `meeting-gen:${user.id}:${contentHash}`;

        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;

        const running = await tx.meetingGeneration.findFirst({
          where: {
            userId: user.id,
            contentHash,
            status: { in: ['PENDING', 'RUNNING'] },
          },
          select: { id: true, meetingId: true, status: true },
        });

        if (running) {
          return { generation: running, reused: true };
        }

        const created = await tx.meetingGeneration.create({
          // 任务和它将要创建的会议必须同租户，否则按租户恢复任务时会错位
          data: {
            userId: user.id,
            tenantId: space.tenantId,
            contentHash,
            status: 'PENDING',
          },
          select: { id: true, meetingId: true, status: true },
        });

        return { generation: created, reused: false };
      },
    );

    // 后台执行，不阻塞 HTTP 响应；复用的任务不能重复跑
    if (!reused) {
      void this.runGeneration(generation.id, content, user, space.tenantId);
    }

    return { ...generation, reused };
  }

  /** 后台执行生成；无论成功失败都会把状态落到任务上 */
  private async runGeneration(
    generationId: number,
    content: string,
    user: AuthenticatedUser,
    /** 与任务上的 tenantId 一致，用来创建会议 */
    tenantId: string,
  ) {
    await this.prisma.meetingGeneration.update({
      where: { id: generationId },
      data: { status: 'RUNNING', startedAt: new Date() },
    });

    try {
      const meeting = await this.generateMeetingSummary(content, user, tenantId);

      await this.prisma.meetingGeneration.update({
        where: { id: generationId },
        data: {
          status: 'SUCCEEDED',
          finishedAt: new Date(),
          meetingId: meeting?.id ?? null,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '生成失败';

      this.logger.error(`生成任务 ${generationId} 失败：${message}`);

      await this.prisma.meetingGeneration.update({
        where: { id: generationId },
        data: {
          status: 'FAILED',
          finishedAt: new Date(),
          error: message,
        },
      });
    }
  }

  /** 查询任务状态；只有发起人或有全局权限的人能看 */
  async getGenerationStatus(generationId: number, user: AuthenticatedUser) {
    const generation = await this.prisma.meetingGeneration.findUnique({
      where: { id: generationId },
      select: {
        id: true,
        userId: true,
        meetingId: true,
        status: true,
        error: true,
        startedAt: true,
        finishedAt: true,
      },
    });

    if (!generation) {
      throw new NotFoundException('生成任务不存在');
    }

    if (generation.userId !== user.id && !hasTenantWideMeetingAccess(user)) {
      // 与会议一致：无权访问返回 404，避免探测任务是否存在
      throw new NotFoundException('生成任务不存在');
    }

    return {
      id: generation.id,
      meetingId: generation.meetingId,
      status: generation.status,
      error: generation.error,
      startedAt: generation.startedAt?.toISOString() ?? null,
      finishedAt: generation.finishedAt?.toISOString() ?? null,
    };
  }

  /* =========================================================
     会议追问：只依据这一份纪要回答
     ========================================================= */

  /** 追问的限流窗口与配额 */
  private static readonly ASK_WINDOW_MS = 60_000;
  private static readonly ASK_LIMIT = 8;

  /** 生成纪要的日配额（每人每天） */
  private static readonly GENERATE_DAILY_LIMIT = 30;

  /** userId → { day, count }，跨天自动重置 */
  private readonly generateUsage = new Map<
    number,
    { day: string; count: number }
  >();

  /** 每个用户最近若干次提问的时间戳（进程内，单实例有效） */
  private readonly askHits = new Map<number, number[]>();

  /**
   * 就某场会议提问。
   *
   * 这是一条**只读**链路：不改会议、不改待办、不产生任何业务副作用，
   * 只有问答本身落库。用户问「把这条标成完成」，助手只会告诉他去哪改。
   *
   * 权限与详情页共用 assertCanRead：能打开这份纪要的人才能问，
   * 看不到的人一律 404，不泄露会议是否存在。
   */
  async askMeeting(
    meetingId: number,
    question: string,
    user: AuthenticatedUser,
  ) {
    await assertCanRead(this.prisma, user, meetingId);

    const trimmed = question?.trim() ?? '';

    if (!trimmed) {
      throw new BadRequestException('请输入要问的问题');
    }

    this.assertAskQuota(user.id);

    const meeting = await this.prisma.meeting.findUnique({
      where: { id: meetingId },
      select: {
        id: true,
        title: true,
        content: true,
        summary: true,
        createdAt: true,
        scheduledAt: true,
        completionStatus: true,
        decisions: {
          select: { content: true },
          orderBy: { sortOrder: 'asc' },
        },
        todos: {
          select: {
            content: true,
            assignee: true,
            deadline: true,
            status: true,
          },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });

    if (!meeting) {
      throw new NotFoundException('会议记录不存在');
    }

    /**
     * 最近 12 条 = 6 轮对话。
     * 再往前模型也不会真的用上，只会白烧 token。
     *
     * 必须带 id 作为次序：一问一答是同一条 createMany 写进去的，
     * created_at 完全相同，只按时间排序会让问和答的顺序随机颠倒。
     */
    const history = await this.prisma.meetingChatMessage.findMany({
      where: { meetingId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 12,
      select: { role: true, content: true },
    });

    const answer = await this.requestAnswer(
      buildAskSystemPrompt(meeting),
      history.reverse().map((item) => ({
        role: item.role === 'USER' ? ('user' as const) : ('assistant' as const),
        content: item.content,
      })),
      trimmed,
    );

    /**
     * 问答落库：刷新页面还能看到，才对得起「记录」两个字。
     * 落库失败不影响已经拿到的回答（用户已经看到了），只记日志。
     */
    try {
      await this.prisma.meetingChatMessage.createMany({
        data: [
          { meetingId, userId: user.id, role: 'USER', content: trimmed },
          { meetingId, userId: user.id, role: 'ASSISTANT', content: answer },
        ],
      });
    } catch (error) {
      this.logger.error(
        `会议 ${meetingId} 追问落库失败`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    return { answer, createdAt: new Date().toISOString() };
  }

  /** 追问历史（最近 30 条），打开抽屉时回填 */
  async listMeetingChat(meetingId: number, user: AuthenticatedUser) {
    await assertCanRead(this.prisma, user, meetingId);

    const items = await this.prisma.meetingChatMessage.findMany({
      where: { meetingId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 30,
      select: { id: true, role: true, content: true, createdAt: true },
    });

    return items.reverse().map((item) => ({
      id: item.id,
      role: item.role,
      content: item.content,
      createdAt: item.createdAt.toISOString(),
    }));
  }

  /** 调用模型拿回答；失败统一收敛成一句人能看懂的话 */
  private async requestAnswer(
    systemPrompt: string,
    history: { role: 'user' | 'assistant'; content: string }[],
    question: string,
  ): Promise<string> {
    try {
      const response = await this.client.chat.completions.create({
        model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
        messages: [
          { role: 'system', content: systemPrompt },
          ...history,
          { role: 'user', content: question },
        ],
        // 读纪要要的是严谨，不是文采：温度压低，减少自由发挥
        temperature: 0.2,
        stream: false,
      });

      const answer = response.choices[0]?.message?.content?.trim();

      if (!answer) {
        throw new Error('模型没有返回内容');
      }

      return answer;
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';

      this.logger.error(`会议追问调用失败：${message}`);

      throw new InternalServerErrorException('回答生成失败，请稍后重试');
    }
  }

  /**
   * 追问是唯一会实时烧额度的接口，单独设一道闸：
   * 同一用户 60 秒内最多 8 次，超了回 429。
   *
   * 进程内计数，只对单实例有效；多副本部署需要换 Redis。
   * 这里不追求精确，目的是挡住「按住回车连发」和顺手写的小脚本。
   */
  /**
   * 生成纪要的日配额。
   *
   * 追问有 60 秒 8 次的窗口限制，能给出即时反馈；但生成是**长文本**调用，
   * token 消耗是追问的几十倍，而且走异步任务，用户感知不到频率。
   * 没有日配额的话，一个循环调用几分钟就能把整月额度烧完。
   *
   * 在入口计数而不是在真正调 API 时计数：排队中也算一次，
   * 否则反复点「生成」能把任务队列塞满。
   */
  private consumeGenerateQuota(userId: number) {
    const day = cstDayKey(new Date());
    const record = this.generateUsage.get(userId);

    if (!record || record.day !== day) {
      this.generateUsage.set(userId, { day, count: 1 });

      return;
    }

    if (record.count >= AiService.GENERATE_DAILY_LIMIT) {
      throw new HttpException(
        `今天已生成 ${AiService.GENERATE_DAILY_LIMIT} 次纪要，明天再试`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    record.count += 1;

    // 跨天的旧记录没有意义，顺手清掉，防止 Map 随用户数增长
    if (this.generateUsage.size > 500) {
      for (const [id, item] of this.generateUsage) {
        if (item.day !== day) {
          this.generateUsage.delete(id);
        }
      }
    }
  }

  private assertAskQuota(userId: number) {
    const now = Date.now();
    const since = now - AiService.ASK_WINDOW_MS;

    const recent = (this.askHits.get(userId) ?? []).filter((t) => t > since);

    if (recent.length >= AiService.ASK_LIMIT) {
      const oldest = recent[0] ?? now;
      const waitSec = Math.max(
        1,
        Math.ceil((oldest + AiService.ASK_WINDOW_MS - now) / 1000),
      );

      throw new HttpException(
        `问得有点快，${waitSec} 秒后再试`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    recent.push(now);
    this.askHits.set(userId, recent);

    // 防止 Map 随用户数无限增长：过期即删
    if (this.askHits.size > 500) {
      for (const [id, hits] of this.askHits) {
        if (!hits.some((t) => t > since)) {
          this.askHits.delete(id);
        }
      }
    }
  }
}
