import {
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import OpenAI from 'openai';
import { PrismaService } from '../common/prisma.service';

@Injectable()
export class AiService {
  private readonly client: OpenAI;

  constructor(
  private readonly prisma: PrismaService,
) {
  this.client = new OpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseURL: 'https://api.deepseek.com',
    });
  }

  async generateMeetingSummary(content: string) {
    if (!content || !content.trim()) {
      throw new Error('会议内容不能为空');
    }

    try {
      const response = await this.client.chat.completions.create({
        model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',

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

      const result =
        response.choices[0]?.message?.content || '{}';

      const data = JSON.parse(result);

      const meeting = await this.prisma.meeting.create({
  data: {
    title: 'AI生成会议纪要',
    content,
    summary: data.summary || '',
    status: 'READY',

    decisions: {
      create: (data.decisions || []).map(
        (decision: string, index: number) => ({
          content: decision,
          sortOrder: index,
        }),
      ),
    },

    todos: {
      create: (data.todos || []).map(
        (
          todo: {
            task: string;
            assignee: string;
            deadline: string;
          },
          index: number,
        ) => ({
          content: todo.task,
          assignee: todo.assignee,
          deadline: todo.deadline,
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

return meeting;
    } catch (error: any) {
      console.error(
        '================ AI API 调用失败 ================',
      );

      console.error('错误信息:', error?.message);
      console.error('错误状态:', error?.status);
      console.error('错误类型:', error?.type);
      console.error('完整错误:', error);

      console.error(
        '================================================',
      );

      throw new InternalServerErrorException(
        error?.message || 'DeepSeek API 调用失败',
      );
    }
  }
}