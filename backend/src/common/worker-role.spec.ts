import { isSchedulerWorker } from './worker-role';

describe('isSchedulerWorker', () => {
  it('单进程（未设置序号）时由自己负责定时任务', () => {
    expect(isSchedulerWorker(undefined)).toBe(true);
    expect(isSchedulerWorker('')).toBe(true);
  });

  it('只有 0 号 worker 负责', () => {
    expect(isSchedulerWorker('0')).toBe(true);
    expect(isSchedulerWorker('1')).toBe(false);
    expect(isSchedulerWorker('2')).toBe(false);
  });
});
