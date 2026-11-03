import { DAY_START_MAX, TEXT } from '../constants';
import type { DateKey, DayCell, MonthCursor, Repeat } from '../types';

/* ============================================================================
   日期纯函数（ARCHITECTURE §4.1）
   纪律（两条禁令）：
   1. 禁止 `toISOString().slice(0, 10)` —— 会把本地 23:30 变成次日；
   2. 禁止 `ts + 86400000` 加天 —— 跨 DST 不安全，一律 `d.setDate(d.getDate() + n)`。
   本文件不依赖 React / window / localStorage；只有 todayKey / nowIso 读系统时钟。
   ========================================================================= */

/** 0=周日 … 6=周六，与 Date.getDay() 一致 */
const WEEKDAY_FULL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;
const WEEKDAY_SHORT = ['日', '一', '二', '三', '四', '五', '六'] as const;

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Date → 'YYYY-MM-DD'（本地时区） */
export function dateKey(d: Date): DateKey {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** key → 本地零点 Date（不能用 new Date('2026-10-24')，那是 UTC） */
export function parseDateKey(key: DateKey): Date {
  const [y, m, d] = key.split('-').map((part) => Number(part));
  return new Date(y as number, (m as number) - 1, d as number);
}

/**
 * 按「日界」取归属日。
 *
 * dayStartHour 的含义是"一天从几点开始"：设 4，则凌晨 3 点仍算**前一天**。
 * 这一步就是减小时再取本地日 —— 加减小时由 Date 自己处理，跨月跨年都安全。
 * 熬夜党的刚需：凌晨 1 点还在学，不该已经被算进"明天"。
 *
 * 合法范围 0–6（设置里就是这么限的），越界退 0 = 午夜翻页。
 */
export function dateKeyAtDayStart(d: Date, dayStartHour: number): DateKey {
  const hour = Number.isFinite(dayStartHour)
    ? Math.min(DAY_START_MAX, Math.max(0, Math.trunc(dayStartHour)))
    : 0;
  const shifted = new Date(d.getTime());
  shifted.setHours(shifted.getHours() - hour);
  return dateKey(shifted);
}

/**
 * 当前本地日 —— 唯一允许读系统时钟的入口之一（便于测试注入）。
 * 传 dayStartHour 即按日界换算后的"今天"。
 */
export function todayKey(dayStartHour: number = 0): DateKey {
  return dateKeyAtDayStart(new Date(), dayStartHour);
}

/** 格式 + 真实存在性校验：'2026-02-30' 必须为 false */
export function isValidDateKey(s: string): boolean {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map((part) => Number(part));
  const date = new Date(y as number, (m as number) - 1, d as number);
  return date.getFullYear() === y && date.getMonth() === (m as number) - 1 && date.getDate() === d;
}

/** 加减 n 天（跨月/跨年/闰年自动正确） */
export function addDays(key: DateKey, n: number): DateKey {
  const d = parseDateKey(key);
  d.setDate(d.getDate() + n);
  return dateKey(d);
}

/** a - b 的天数差（零点差无 DST 抖动） */
export function diffDays(a: DateKey, b: DateKey): number {
  return Math.round((parseDateKey(a).getTime() - parseDateKey(b).getTime()) / 86400000);
}

/** key 字典序比较（定长零填充后字符串比较即正确） */
export function compareDateKey(a: DateKey, b: DateKey): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 逾期口径：只看日期不看时间；当天 23:59 的任务不算逾期 */
export function isOverdue(key: DateKey, today: DateKey): boolean {
  return key < today;
}

/** key → { year, month0 } */
export function monthOfKey(key: DateKey): MonthCursor {
  const d = parseDateKey(key);
  return { year: d.getFullYear(), month: d.getMonth() };
}

/** 月份平移（month 必须归一到 0-11） */
export function shiftMonth(cur: MonthCursor, delta: number): MonthCursor {
  const d = new Date(cur.year, cur.month + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() };
}

/** 当月天数 */
export function daysInMonth(year: number, month0: number): number {
  return new Date(year, month0 + 1, 0).getDate();
}

/** 所在周首日（weekStart=1 → 周一；0 → 周日） */
export function startOfWeek(key: DateKey, weekStart: 0 | 1): DateKey {
  const day = parseDateKey(key).getDay();
  const offset = (day - weekStart + 7) % 7;
  return addDays(key, -offset);
}

/**
 * 所在周的起止日（周视图数据入口）。
 * 跨月/跨年不裁剪；同一周的任意两天必得同一组起止值（幂等）。
 */
export function getWeekRange(key: DateKey, weekStart: 0 | 1): { startKey: DateKey; endKey: DateKey } {
  const startKey = startOfWeek(key, weekStart);
  return { startKey, endKey: addDays(startKey, 6) };
}

/* ---------- 重复任务 ---------- */

/** 按月推进（1 月 31 日 + 1 月 → 2 月 28/29 日，不会溢出到 3 月） */
export function addMonthsKey(key: DateKey, n: number): DateKey {
  const base = isValidDateKey(key) ? key : todayKey();
  const shifted = shiftMonth(monthOfKey(base), n);
  const day = Math.min(Number(base.slice(8, 10)), daysInMonth(shifted.year, shifted.month));
  return `${shifted.year}-${pad2(shifted.month + 1)}-${pad2(day)}`;
}

/** 按周期推进**一次**；'none' 与非法值原样返回 */
export function advanceRepeat(key: DateKey, repeat: Repeat): DateKey {
  if (repeat === 'daily') return addDays(key, 1);
  if (repeat === 'weekly') return addDays(key, 7);
  if (repeat === 'monthly') return addMonthsKey(key, 1);
  return key;
}

/**
 * 下一次出现的日期，**保证不早于 `today`**。
 *
 * 为什么要一路推到今天：一个"每天"的任务如果三天没碰，直接 +1 天会生成一份
 * 落在过去的新任务，立刻变成逾期。推到今天才是用户真正想看到的。
 * 'none' 返回 null（没有下一次）。
 */
export function nextOccurrence(key: DateKey, repeat: Repeat, today: DateKey): DateKey | null {
  if (repeat === 'none') return null;
  let next = advanceRepeat(key, repeat);
  // 上限 400 次：既覆盖"月重复跨很多年"，又绝对不会死循环
  for (let guard = 0; next < today && guard < 400; guard += 1) {
    next = advanceRepeat(next, repeat);
  }
  return next;
}

/**
 * 周视图 7 个 dateKey（列序与 weekdayLabels 同源）。
 * key 非法时以 todayKey() 为锚，调用方不必先校验。
 */
export function buildWeekDays(key: DateKey, weekStart: 0 | 1): DateKey[] {
  const anchor = isValidDateKey(key) ? key : todayKey();
  const { startKey } = getWeekRange(anchor, weekStart);
  const days: DateKey[] = [];
  for (let i = 0; i < 7; i += 1) days.push(addDays(startKey, i));
  return days;
}

/**
 * 周视图标题（口径已由主理人按 M1 视觉基线裁定：用日期区间，不用「第 N 周」）。
 * 同月：'10月19日 – 25日'；跨月同年：'9月28日 – 10月4日'；
 * 跨年：'2026年12月28日 – 2027年1月3日'（只有跨年才显示年份）。
 */
export function formatWeekTitle(startKey: DateKey, endKey: DateKey): string {
  const a = parseDateKey(startKey);
  const b = parseDateKey(endKey);
  const sameYear = a.getFullYear() === b.getFullYear();
  const sameMonth = sameYear && a.getMonth() === b.getMonth();

  if (sameMonth) {
    return `${a.getMonth() + 1}月${a.getDate()}日 – ${b.getDate()}日`;
  }
  if (sameYear) {
    return `${a.getMonth() + 1}月${a.getDate()}日 – ${b.getMonth() + 1}月${b.getDate()}日`;
  }
  return (
    `${a.getFullYear()}年${a.getMonth() + 1}月${a.getDate()}日 – ` +
    `${b.getFullYear()}年${b.getMonth() + 1}月${b.getDate()}日`
  );
}

/**
 * 月历网格：固定 42 格（6×7），首格 = startOfWeek(该月 1 日)。
 * isToday 由传入的 today 比较得出，保持纯函数。
 */
export function buildMonthGrid(
  year: number,
  month0: number,
  weekStart: 0 | 1,
  today: DateKey,
): DayCell[] {
  const firstOfMonth = dateKey(new Date(year, month0, 1));
  const startKey = startOfWeek(firstOfMonth, weekStart);
  const cells: DayCell[] = [];
  for (let i = 0; i < 42; i += 1) {
    const key = addDays(startKey, i);
    const d = parseDateKey(key);
    cells.push({
      key,
      day: d.getDate(),
      inMonth: d.getMonth() === month0 && d.getFullYear() === year,
      isToday: key === today,
      weekday: d.getDay(),
    });
  }
  return cells;
}

/** '10月24日 周五'（不补零） */
export function formatDateTitle(key: DateKey): string {
  const d = parseDateKey(key);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAY_FULL[d.getDay()]}`;
}

/** '2026 年 10 月'（数字与汉字间留半角空格） */
export function formatMonthTitle(year: number, month0: number): string {
  return `${year} 年 ${month0 + 1} 月`;
}

/** '今天' / '昨天' / '前天' / '明天' / '后天' / 'M月D日'（跨年补年份） */
export function formatRelativeDay(key: DateKey, today: DateKey): string {
  const diff = diffDays(key, today);
  if (diff === 0) return '今天';
  if (diff === -1) return '昨天';
  if (diff === -2) return '前天';
  if (diff === 1) return '明天';
  if (diff === 2) return '后天';
  const d = parseDateKey(key);
  const sameYear = d.getFullYear() === parseDateKey(today).getFullYear();
  return sameYear
    ? `${d.getMonth() + 1}月${d.getDate()}日`
    : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** '09:00' | '随时' */
export function formatTime(time: string | null): string {
  return time ?? TEXT.anytime;
}

/** 列头 7 个短名（与 buildMonthGrid / buildWeekDays 同源） */
export function weekdayLabels(weekStart: 0 | 1): string[] {
  const out: string[] = [];
  for (let i = 0; i < 7; i += 1) out.push(WEEKDAY_SHORT[(i + weekStart) % 7] as string);
  return out;
}

/** 唯一允许读系统时钟的第二个入口 */
export function nowIso(): string {
  return new Date().toISOString();
}
