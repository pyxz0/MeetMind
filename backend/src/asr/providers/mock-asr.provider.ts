import { randomUUID } from 'node:crypto';
import type {
  AsrPollResult,
  AsrProvider,
  AsrSubmitResult,
} from './asr-provider';

/**
 * 本地占位通道：不访问任何外部服务，几秒后返回一段固定文本。
 *
 * 用途有两个：
 * 1. 没有 ASR 凭据时，上传 / 状态 / 生成纪要的整条链路仍然能跑通；
 * 2. 单元与端到端测试不依赖外部配额。
 *
 * 生产环境必须显式配凭据切到 tencent，否则会议内容会被替换成假文本。
 */
export class MockAsrProvider implements AsrProvider {
  readonly name = 'mock';

  /** 任务 id -> 提交时间，用来模拟「转写要花几秒」 */
  private readonly submittedAt = new Map<string, number>();

  async submit(): Promise<AsrSubmitResult> {
    const taskId = `mock-${randomUUID()}`;
    this.submittedAt.set(taskId, Date.now());

    return { taskId };
  }

  async poll(taskId: string): Promise<AsrPollResult> {
    const startedAt = this.submittedAt.get(taskId) ?? Date.now();

    if (Date.now() - startedAt < 5_000) {
      return { status: 'running' };
    }

    return {
      status: 'done',
      durationSec: 96,
      text: [
        '【本地占位转写】本次会议围绕第一版功能范围展开。',
        '第一，确认首页保留竖向导航，入口不超过五个。',
        '第二，纪要正文按摘要、决策、待办、原文的顺序呈现。',
        '第三，张三负责首页 UI 设计，本周五之前提交；李四负责登录接口，下周一完成。',
        '说明：当前使用的是 mock 转写通道，配置腾讯云 ASR 凭据后即为真实转写结果。',
      ].join('\n'),
    };
  }
}
