import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import OpenAI from 'openai';
import { createHash } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { hasGlobalMeetingAccess } from '../meetings/meetings.access';
import { PrismaService } from '../common/prisma.service';
import type { AuthenticatedUser } from '../auth/auth.decorators';
import { assertCanWrite } from '../meetings/meetings.access';

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

    try {
      /**
       * 第一步：
       * 将会议状态改为 PROCESSING。
       */
      await this.prisma.meeting.update({
        where: { id },
        data: {
          status: 'PROCESSING',
        },
      });

      /**
       * 第二步：
       * 删除之前可能存在的 AI 结果。
       *
       * 防止重新生成后出现重复的决策和待办。
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
       * 第三步：
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

  async startGeneration(content: string, user: AuthenticatedUser) {
    const trimmed = content?.trim() ?? '';

    if (!trimmed) {
      throw new InternalServerErrorException('会议内容不能为空');
    }

    const contentHash = createHash('sha256').update(trimmed).digest('hex');

    const running = await this.prisma.meetingGeneration.findFirst({
      where: {
        userId: user.id,
        contentHash,
        status: { in: ['PENDING', 'RUNNING'] },
      },
      select: { id: true, meetingId: true, status: true },
    });

    if (running) {
      return { ...running, reused: true };
    }

    const generation = await this.prisma.meetingGeneration.create({
      data: { userId: user.id, contentHash, status: 'PENDING' },
      select: { id: true, meetingId: true, status: true },
    });

    // 后台执行，不阻塞 HTTP 响应
    void this.runGeneration(generation.id, content, user);

    return { ...generation, reused: false };
  }

  /** 后台执行生成；无论成功失败都会把状态落到任务上 */
  private async runGeneration(
    generationId: number,
    content: string,
    user: AuthenticatedUser,
  ) {
    await this.prisma.meetingGeneration.update({
      where: { id: generationId },
      data: { status: 'RUNNING', startedAt: new Date() },
    });

    try {
      const meeting = await this.generateMeetingSummary(content, user);

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

    if (generation.userId !== user.id && !hasGlobalMeetingAccess(user)) {
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

}
