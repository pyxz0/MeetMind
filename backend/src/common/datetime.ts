/**
 * 时间格式化（固定 UTC+8）。
 *
 * 不要用 toLocaleString / getHours：容器里通常是 UTC，
 * 同一个时刻会显示成差 8 小时的时间。提醒邮件里把「14:30 开会」
 * 写成「06:30」，比不发还糟 —— 所以这里统一按偏移量算。
 */

const CST_OFFSET_MS = 8 * 60 * 60 * 1000;

const pad = (value: number) => String(value).padStart(2, '0');

const shift = (value: Date) => new Date(value.getTime() + CST_OFFSET_MS);

/** 2026-10-27 10:00 */
export const formatCst = (value: Date): string => {
  const date = shift(value);

  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    ` ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
  );
};

/** 10/27 16:00 —— 提醒文案里够用，不必带年份 */
export const formatCstShort = (value: Date): string => {
  const date = shift(value);

  return (
    `${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}` +
    ` ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
  );
};

/** 只有日期：2026-10-27 */
export const formatCstDate = (value: Date): string =>
  formatCst(value).slice(0, 10);

/** 10/27 —— 逾期提醒里只关心哪一天 */
export const formatCstMonthDay = (value: Date): string => {
  const date = shift(value);

  return `${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}`;
};

/**
 * 两个时刻相差几个「UTC+8 日历日」。
 *
 * 用于算逾期天数：截止时间是当天 23:59:59，今天上午跑扫描，
 * 直接按毫秒相除会得到 0.4 天这样的结果，取整后又容易少算一天。
 * 换算成「第几天」再相减才稳。
 */
export const daysBetweenCst = (from: Date, to: Date): number => {
  const dayNumber = (value: Date) =>
    Math.floor((value.getTime() + CST_OFFSET_MS) / 86_400_000);

  return dayNumber(to) - dayNumber(from);
};

/** 当天 00:00（UTC+8），用于「今天是否已经提醒过」的边界 */
export const startOfCstDay = (value: Date): Date => {
  const date = shift(value);

  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
    ) - CST_OFFSET_MS,
  );
};

/** UTC+8 视角的日期键：2026-10-27 */
export const cstDayKey = (value: Date): string => formatCstDate(value);

/** UTC+8 视角的小时（0-23） */
export const cstHour = (value: Date): number => shift(value).getUTCHours();
