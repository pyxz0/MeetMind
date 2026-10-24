/**
 * 截止时间解析。
 *
 * AI 与用户给的都是自然语言（「本周五」「下周一」「10月30日」），
 * 只有落成时间点才能排序、判逾期、算时效。
 *
 * 约定：
 * - 一律按 UTC+8 的日历日计算，截止时刻取当天 23:59:59（含当天）
 * - 解析不了就返回 null，只保留原文，不猜
 * - 纯函数、可注入 now，方便单测跨月跨年边界
 */

const CN_OFFSET_MS = 8 * 60 * 60 * 1000;

type Ymd = { y: number; m: number; d: number };

const pad = (value: number) => String(value).padStart(2, '0');

/** 取 UTC+8 视角下的年月日与星期（0=周日） */
const cnToday = (now: Date) => {
  const shifted = new Date(now.getTime() + CN_OFFSET_MS);

  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
    dow: shifted.getUTCDay(),
  };
};

/** 当天 23:59:59（UTC+8） */
const endOfDay = ({ y, m, d }: Ymd): Date | null => {
  const at = new Date(`${y}-${pad(m)}-${pad(d)}T23:59:59+08:00`);

  return Number.isNaN(at.getTime()) ? null : at;
};

const addDays = ({ y, m, d }: Ymd, delta: number): Ymd => {
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() + delta);

  return {
    y: base.getUTCFullYear(),
    m: base.getUTCMonth() + 1,
    d: base.getUTCDate(),
  };
};

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** 中文数字与阿拉伯数字都支持 */
const toNumber = (text: string): number | null => {
  const map: Record<string, number> = {
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
    十一: 11, 十二: 12,
  };

  if (/^\d+$/.test(text)) return Number(text);

  return map[text] ?? null;
};

/** 周一为一周起点：周一=0 … 周日=6 */
const weekdayIndex = (dow: number) => (dow + 6) % 7;

const WEEKDAY: Record<string, number> = {
  一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6,
  1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6,
};

export const parseDeadlineAt = (
  value?: string | null,
  now: Date = new Date(),
): Date | null => {
  if (!value) return null;

  // 去掉「截止」「前」这类修饰与空白，避免影响匹配
  const text = value
    .trim()
    .replace(/\s+/g, '')
    .replace(/^截止[:：]?/, '')
    .replace(/前$/, '');

  if (!text) return null;

  const today = cnToday(now);

  // 2026-11-02 / 2026/11/2 / 2026.11.2
  const absolute = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (absolute) {
    const parsed = {
      y: Number(absolute[1]),
      m: Number(absolute[2]),
      d: Number(absolute[3]),
    };

    if (parsed.m < 1 || parsed.m > 12 || parsed.d < 1 || parsed.d > daysInMonth(parsed.y, parsed.m)) {
      return null;
    }

    return endOfDay(parsed);
  }

  // 2026-11-02T18:00 / 2026-11-02 18:00：带时刻的按原值，不再补到当天末尾
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(text)) {
    const at = new Date(text);

    return Number.isNaN(at.getTime()) ? null : at;
  }

  // 11月2日 / 11月2号（按当前年；已过则视为明年，避免给出一个必然逾期的日期）
  const monthDay = text.match(/^(\d{1,2})月(\d{1,2})[日号]?$/);
  if (monthDay) {
    const m = Number(monthDay[1]);
    const d = Number(monthDay[2]);

    if (m < 1 || m > 12 || d < 1 || d > daysInMonth(today.y, m)) return null;

    const sameYear = { y: today.y, m, d };
    const candidate = endOfDay(sameYear);

    if (candidate && candidate.getTime() < now.getTime()) {
      return endOfDay({ y: today.y + 1, m, d });
    }

    return candidate;
  }

  // 今天 / 明天 / 后天 / 大后天
  const relativeDays: Record<string, number> = {
    今天: 0, 今日: 0, 明天: 1, 明日: 1, 后天: 2, 大后天: 3,
  };

  if (text in relativeDays) {
    return endOfDay(addDays(today, relativeDays[text]));
  }

  // 3天内 / 三天内 / 5天后
  const inDays = text.match(/^([一二三四五六七八九十\d]+)天[内后]?$/);
  if (inDays) {
    const days = toNumber(inDays[1]);

    if (days === null) return null;

    return endOfDay(addDays(today, days));
  }

  // 本周五 / 这周五 / 下周一 / 下下周三 / 周五 / 星期五
  const week = text.match(/^(本|这|下|下下)?(?:周|星期)([一二三四五六日天1-7])$/);
  if (week) {
    const target = WEEKDAY[week[2]];

    if (target === undefined) return null;

    const monday = addDays(today, -weekdayIndex(today.dow));
    const weekOffset = week[1] === '下' ? 1 : week[1] === '下下' ? 2 : 0;

    return endOfDay(addDays(monday, weekOffset * 7 + target));
  }

  // 本月底 / 月底 / 下月底
  const monthEnd = text.match(/^(本|这|下)?月[底末]$/);
  if (monthEnd) {
    const offset = monthEnd[1] === '下' ? 1 : 0;
    const totalMonth = today.m - 1 + offset;
    const y = today.y + Math.floor(totalMonth / 12);
    const m = (totalMonth % 12) + 1;

    return endOfDay({ y, m, d: daysInMonth(y, m) });
  }

  // 本周内 / 这周内 → 本周日
  if (/^(本|这)周[内末]$/.test(text)) {
    const monday = addDays(today, -weekdayIndex(today.dow));

    return endOfDay(addDays(monday, 6));
  }

  return null;
};

/** 是否已逾期：只看未完成的待办 */
export const isOverdue = (
  deadlineAt: Date | null | undefined,
  status: string,
  now: Date = new Date(),
): boolean => {
  if (!deadlineAt) return false;
  if (status === 'COMPLETED' || status === 'CANCELLED') return false;

  return deadlineAt.getTime() < now.getTime();
};
