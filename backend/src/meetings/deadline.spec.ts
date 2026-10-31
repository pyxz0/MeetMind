import { isOverdue, parseDeadlineAt } from './deadline';

/** 固定基准：2026-10-23（周五）10:00 UTC+8 */
const NOW = new Date('2026-10-23T10:00:00+08:00');

/** 断言解析结果的 UTC+8 日期部分 */
const expectDay = (input: string, day: string) => {
  const parsed = parseDeadlineAt(input, NOW);

  // 截止时刻是 23:59:59+08，直接 slice ISO 会落到 UTC 的前一天，必须先换算回 UTC+8
  const cnDay = parsed
    ? new Date(parsed.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
    : null;

  expect(cnDay).toBe(day);
};

describe('parseDeadlineAt', () => {
  it('解析 ISO 日期，截止到当天 23:59:59（UTC+8）', () => {
    const parsed = parseDeadlineAt('2026-11-02', NOW);

    expect(parsed?.toISOString()).toBe('2026-11-02T15:59:59.000Z');
  });

  it('支持斜杠与点分隔的绝对日期', () => {
    expectDay('2026/11/2', '2026-11-02');
    expectDay('2026.11.2', '2026-11-02');
  });

  it('解析相对日：今天 / 明天 / 后天 / 大后天', () => {
    expectDay('今天', '2026-10-23');
    expectDay('明天', '2026-10-24');
    expectDay('后天', '2026-10-25');
    expectDay('大后天', '2026-10-26');
  });

  it('解析「3天内」「三天后」', () => {
    expectDay('3天内', '2026-10-26');
    expectDay('三天后', '2026-10-26');
  });

  it('本周五就是今天；周日落在本周最后一天', () => {
    expectDay('本周五', '2026-10-23');
    expectDay('这周日', '2026-10-25');
    expectDay('周五', '2026-10-23');
    expectDay('星期五', '2026-10-23');
  });

  it('下周与下下周按周一起算', () => {
    expectDay('下周一', '2026-10-26');
    expectDay('下周五', '2026-10-30');
    expectDay('下下周三', '2026-11-04');
  });

  it('解析「月底」「本月底」「下月底」', () => {
    expectDay('月底', '2026-10-31');
    expectDay('本月底', '2026-10-31');
    expectDay('下月底', '2026-11-30');
  });

  it('解析「本周内」为本周日', () => {
    expectDay('本周内', '2026-10-25');
  });

  /**
   * 范围词：模型提取待办时最常写「本周」「下周」。
   * 解析不出来就会静默变成「没有截止时间」，逾期提醒永远不触发。
   */
  it('解析范围词「本周」「下周」「下下周」为对应周期最后一天', () => {
    expectDay('本周', '2026-10-25');
    expectDay('这周', '2026-10-25');
    expectDay('本周末', '2026-10-25');
    expectDay('下周', '2026-11-01');
    expectDay('下周内', '2026-11-01');
    expectDay('下下周', '2026-11-08');
  });

  it('解析范围词「本月」「下月」为对应月最后一天', () => {
    expectDay('本月', '2026-10-31');
    expectDay('这个月', '2026-10-31');
    expectDay('下月', '2026-11-30');
  });

  it('「本周五」「下周一」仍按精确日解析，不被范围词规则吃掉', () => {
    expectDay('本周五', '2026-10-23');
    expectDay('下周一', '2026-10-26');
  });

  it('月日已过则顺延到明年，避免给出必然逾期的日期', () => {
    expectDay('10月1日', '2027-10-01');
    expectDay('1月5日', '2027-01-05');
  });

  it('没有年份的月日按当前年解析', () => {
    expectDay('10月30日', '2026-10-30');
    expectDay('11月2号', '2026-11-02');
  });

  it('非法日期与无法识别的文本返回 null', () => {
    expect(parseDeadlineAt('2月30日', NOW)).toBeNull();
    expect(parseDeadlineAt('尽快', NOW)).toBeNull();
    expect(parseDeadlineAt('下周八', NOW)).toBeNull();
    expect(parseDeadlineAt('', NOW)).toBeNull();
    expect(parseDeadlineAt(null, NOW)).toBeNull();
  });

  it('忽略「截止」「前」等修饰', () => {
    expectDay('截止：明天', '2026-10-24');
    expectDay('10月30日前', '2026-10-30');
  });
});

describe('isOverdue', () => {
  const past = new Date('2026-10-22T15:59:59.000Z');
  const future = new Date('2026-10-24T15:59:59.000Z');

  it('未完成且已过截止时间算逾期', () => {
    expect(isOverdue(past, 'OPEN', NOW)).toBe(true);
    expect(isOverdue(past, 'SUBMITTED', NOW)).toBe(true);
  });

  it('已完成 / 已取消 / 未来 / 没填截止时间都不算逾期', () => {
    expect(isOverdue(past, 'COMPLETED', NOW)).toBe(false);
    expect(isOverdue(past, 'CANCELLED', NOW)).toBe(false);
    expect(isOverdue(future, 'IN_PROGRESS', NOW)).toBe(false);
    expect(isOverdue(null, 'OPEN', NOW)).toBe(false);
  });
});
