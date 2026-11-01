/**
 * @nestjs/common 是纯 ESM 包，Node 22 下 Jest 无法 require（Node ≥24.9 才支持）。
 * 这里把用到的两个符号 mock 掉：装饰器空实现，Logger 空方法，
 * 被测的只是 track / overview 的判断逻辑，不依赖 Nest 运行时。
 */
jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target,
  Logger: class {
    log() {}
    warn() {}
    error() {}
    debug() {}
  },
}));

import type { PrismaService } from '../common/prisma.service';
import { JobRunService } from './job-run.service';

/**
 * 这里只测 track 的行为，不碰数据库。
 *
 * 最要紧的一条是「任务失败不向上抛」：定时器回调里的异常会变成
 * unhandled rejection，轻则刷屏、重则打崩进程 —— 一个提醒发不出去，
 * 不该连累整个服务。
 */
const buildService = () => {
  const create = jest.fn().mockResolvedValue({});

  const prisma = {
    jobRun: { create },
  } as unknown as PrismaService;

  return { service: new JobRunService(prisma), create };
};

describe('JobRunService.track', () => {
  it('有动作时落库：记下条数与耗时', async () => {
    const { service, create } = buildService();

    await service.track('inbox-reminder', async () => ({ affected: 3 }));

    expect(create).toHaveBeenCalledTimes(1);

    const { data } = create.mock.calls[0][0];

    expect(data).toMatchObject({
      job: 'inbox-reminder',
      status: 'OK',
      affected: 3,
      error: null,
    });
    expect(data.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('空跑不落库（每分钟一次心跳会让表爆掉）', async () => {
    const { service, create } = buildService();

    await service.track('inbox-reminder', async () => ({ affected: 0 }));

    expect(create).not.toHaveBeenCalled();
  });

  it('任务抛错时不向上抛，并记一条 FAILED', async () => {
    const { service, create } = buildService();

    await expect(
      service.track('overdue-reminder', async () => {
        throw new Error('数据库连接超时');
      }),
    ).resolves.toBeUndefined();

    const { data } = create.mock.calls[0][0];

    expect(data).toMatchObject({
      job: 'overdue-reminder',
      status: 'FAILED',
      affected: 0,
    });
    expect(data.error).toContain('数据库连接超时');
  });

  it('错误信息超长时截断，避免把整段堆栈塞进库', async () => {
    const { service, create } = buildService();
    const longMessage = 'x'.repeat(5000);

    await service.track('notice-delivery', async () => {
      throw new Error(longMessage);
    });

    expect(create.mock.calls[0][0].data.error).toHaveLength(2000);
  });

  it('写记录本身失败也不抛出（观测不该反过来影响被观测的任务）', async () => {
    const create = jest.fn().mockRejectedValue(new Error('表不存在'));
    const service = new JobRunService({
      jobRun: { create },
    } as unknown as PrismaService);

    await expect(
      service.track('notice-delivery', async () => ({ affected: 1 })),
    ).resolves.toBeUndefined();
  });

  it('overview 在没有执行记录时返回全部任务定义', async () => {
    const prisma = {
      jobRun: {
        groupBy: jest.fn().mockResolvedValue([]),
        findMany: jest.fn().mockResolvedValue([]),
      },
    } as unknown as PrismaService;

    const rows = await new JobRunService(prisma).overview();

    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.key)).toContain('overdue-reminder');
    // 刚启动还没执行过，不能判成「卡住」
    expect(rows.every((row) => row.stale === false)).toBe(true);
    expect(rows.every((row) => row.lastRunAt === null)).toBe(true);
  });
});
