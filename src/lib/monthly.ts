import { addMonthsKey, daysInMonth, monthOfKey } from './date';
import { focusMsByDate, formatFocusDuration } from './focus';
import type { DateKey, FocusSession, Task } from '../types';

/* ============================================================================
   月报（F14）

   为什么是"月"而不是"周"：周报已经存在（`lib/weekly.ts`，写进日记的
   三问三答）。周是**执行节奏**，月才是**回看节奏** —— 一个月过去，
   "这个月到底推进了什么"这个问题只有拉到 30 天才看得出来，
   而周报里全是细节。

   口径纪律（和今日进度、热力图、周报**必须同源**）：
   - 任务的日期用 `task.date`（本地日期字符串），不用 doneAt —— 后者是 ISO
     时间戳，涉及时区与日界换算，容易差一天。
   - 专注时长用 `session.date`（写入时已按日界换算过）。
   - 完成率的 percent 在"本月没有任何任务"时是 `null` 而不是 0 ——
     空月份画成 0% 会看起来像"我一个月什么都没做完"。
   ========================================================================= */

export interface MonthlyReport {
  year: number;
  /** 0–11（与 Date 一致） */
  month0: number;
  /** 'YYYY-MM' */
  key: string;
  /** 本月任务完成情况（含已完成与未完成，子任务也计入 —— 与今日进度同口径） */
  tasks: { total: number; done: number; percent: number | null };
  /**
   * 专注：`totalMs` 本月总时长；`activeDays` 有专注的天数；
   * `averageMs` **按有专注的天数**平均 —— 除以自然日会把"周末没学"算成退步，
   * 那个数字没人想看。
   */
  focus: { totalMs: number; activeDays: number; averageMs: number };
  /** 分类分布：完成数降序，同数按名称排；一条任务都没有的分类不出现 */
  byCategory: { category: string; total: number; done: number }[];
  /** 完成任务最多的一天（并列取较早的） */
  bestDay: { date: DateKey; done: number } | null;
  /** 专注最久的一天 */
  bestFocusDay: { date: DateKey; ms: number } | null;
  /** 本月有任务的天数 */
  activeDays: number;
  /**
   * 上个月的同口径合计，用于**环比**。
   *
   * `null` = 上个月既没有任务也没有专注记录 —— 这时候不能说"比上月多 100%"，
   * 那是拿"无"当"零"，得单独说"上月还没有记录"。
   */
  previous: MonthTotals | null;
}

/** 一个月的四个核心数字（环比只需要这四个） */
export interface MonthTotals {
  /** 'YYYY-MM' */
  key: string;
  done: number;
  total: number;
  focusMs: number;
}

/** 'YYYY-MM' 形式的月份键（月报里当唯一标识用） */
export function monthKey(year: number, month0: number): string {
  return `${year}-${String(month0 + 1).padStart(2, '0')}`;
}

/** 本月全部日期键（1 号 → 月末） */
export function monthDateKeys(year: number, month0: number): DateKey[] {
  const total = daysInMonth(year, month0);
  const keys: DateKey[] = [];
  for (let day = 1; day <= total; day += 1) {
    keys.push(`${monthKey(year, month0)}-${String(day).padStart(2, '0')}` as DateKey);
  }
  return keys;
}

/** 只算环比要用的四个数（不建分类分布 / 最佳日，省一半工作） */
function totalsOf(
  tasks: Task[],
  focusSessions: FocusSession[],
  year: number,
  month0: number,
): MonthTotals {
  const prefix = `${monthKey(year, month0)}-`;
  const list = (Array.isArray(tasks) ? tasks : []).filter(
    (task) => task && typeof task.date === 'string' && task.date.startsWith(prefix),
  );
  const msByDate = focusMsByDate(Array.isArray(focusSessions) ? focusSessions : []);
  let focusMs = 0;
  for (const key of monthDateKeys(year, month0)) focusMs += msByDate.get(key) ?? 0;
  return {
    key: monthKey(year, month0),
    done: list.filter((task) => task.done).length,
    total: list.length,
    focusMs,
  };
}

export function buildMonthlyReport(
  tasks: Task[],
  focusSessions: FocusSession[],
  year: number,
  month0: number,
): MonthlyReport {
  const keys = monthDateKeys(year, month0);
  const prefix = `${monthKey(year, month0)}-`;

  /* ---------- 任务 ---------- */
  const list = (Array.isArray(tasks) ? tasks : []).filter(
    (task) => task && typeof task.date === 'string' && task.date.startsWith(prefix),
  );
  const done = list.filter((task) => task.done).length;
  const total = list.length;

  /** 每天完成了几条（用于 bestDay 与 activeDays） */
  const doneByDay = new Map<DateKey, number>();
  const totalByDay = new Map<DateKey, number>();
  for (const task of list) {
    totalByDay.set(task.date, (totalByDay.get(task.date) ?? 0) + 1);
    if (task.done) doneByDay.set(task.date, (doneByDay.get(task.date) ?? 0) + 1);
  }

  let bestDay: { date: DateKey; done: number } | null = null;
  for (const key of keys) {
    const value = doneByDay.get(key) ?? 0;
    if (value === 0) continue;
    // 并列取较早的：keys 是从 1 号顺序来的，用 `>` 而不是 `>=`
    if (!bestDay || value > bestDay.done) bestDay = { date: key, done: value };
  }

  /* ---------- 分类 ---------- */
  const byCategoryMap = new Map<string, { total: number; done: number }>();
  for (const task of list) {
    const name = task.category || '未分类';
    const bucket = byCategoryMap.get(name) ?? { total: 0, done: 0 };
    bucket.total += 1;
    if (task.done) bucket.done += 1;
    byCategoryMap.set(name, bucket);
  }
  const byCategory = [...byCategoryMap.entries()]
    .map(([category, value]) => ({ category, ...value }))
    .sort((a, b) => (b.done !== a.done ? b.done - a.done : a.category.localeCompare(b.category)));

  /* ---------- 专注 ---------- */
  const msByDate = focusMsByDate(Array.isArray(focusSessions) ? focusSessions : []);
  let totalMs = 0;
  let focusActiveDays = 0;
  let bestFocusDay: { date: DateKey; ms: number } | null = null;
  for (const key of keys) {
    const ms = msByDate.get(key) ?? 0;
    if (ms <= 0) continue;
    totalMs += ms;
    focusActiveDays += 1;
    if (!bestFocusDay || ms > bestFocusDay.ms) bestFocusDay = { date: key, ms };
  }

  return {
    year,
    month0,
    key: monthKey(year, month0),
    tasks: { total, done, percent: total === 0 ? null : Math.round((done / total) * 100) },
    focus: {
      totalMs,
      activeDays: focusActiveDays,
      averageMs: focusActiveDays === 0 ? 0 : Math.round(totalMs / focusActiveDays),
    },
    byCategory,
    bestDay,
    bestFocusDay,
    activeDays: totalByDay.size,
    /**
     * 上月合计。用 `addMonthsKey` 走"上一个月的同一天"再取月份，
     * 避免自己在 1 月/12 月边界上手写 `month0 - 1`（那是最容易写错的地方）。
     */
    previous: (() => {
      const prevKey = addMonthsKey(`${monthKey(year, month0)}-01`, -1);
      const prev = monthOfKey(prevKey);
      const totals = totalsOf(tasks, focusSessions, prev.year, prev.month);
      // 上个月一片空白 → 没有可比的东西
      return totals.total === 0 && totals.focusMs === 0 ? null : totals;
    })(),
  };
}

/**
 * 把月报压成几句可以直接读的话（设置页那一栏的文案）。
 *
 * 为什么单独一个函数而不是在 JSX 里拼：这些句子里有"取舍"
 * （比如达成率低于 30% 时不评价），放在纯函数里能被用例钉住，
 * 混在 JSX 里就只能靠人眼。
 */
export function monthlyHeadline(report: MonthlyReport): string[] {
  const lines: string[] = [];
  if (report.tasks.percent === null) {
    lines.push('这个月还没有安排任务');
  } else {
    lines.push(`完成 ${report.tasks.done} / ${report.tasks.total} 项 · ${report.tasks.percent}%`);
  }
  if (report.focus.totalMs > 0) {
    // 至少算 1 分钟：30 秒的专注不该被显示成"专注 0 小时 0 分钟"
    const minutes = Math.max(1, Math.round(report.focus.totalMs / 60000));
    lines.push(
      `专注 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟 · 有 ${report.focus.activeDays} 天在学`,
    );
  }
  return lines;
}

/* ============================================================================
   环比（和上个月比）
   ========================================================================= */

export interface MonthComparison {
  /** 专注时长的环比；空串 = 不显示（上月没有任何记录） */
  focus: string;
  /** 完成项数的环比；空串 = 不显示 */
  done: string;
}

/**
 * 差多少算"持平"：5 分钟。
 *
 * 月度合计是小时量级，差 1 分钟说"少 1分钟"既不可信也不好看 ——
 * 那是记账误差（一段专注的起止取整），不是趋势。
 */
const SAME_THRESHOLD_MS = 5 * 60_000;

/**
 * 环比文案。
 *
 * 三条刻意的克制：
 * - **上月是空的时候不提百分比**。拿"无"当"零"算出"比上月多 100%"
 *   是统计上最廉价的一种自我安慰。
 * - 不评价。只说"多了 4 小时"，不说"进步很大"——说教只会让人关掉这一栏。
 * - **5 分钟以内算持平**：差 1 分钟说"多学了 1 分钟"是记账误差，不是趋势。
 */
export function monthComparison(report: MonthlyReport): MonthComparison {
  const previous = report.previous;
  if (!previous) return { focus: '', done: '' };

  const focusDiff = report.focus.totalMs - previous.focusMs;
  let focus = '';
  if (Math.abs(focusDiff) < SAME_THRESHOLD_MS) {
    focus = '专注和上月持平';
  } else if (focusDiff > 0) {
    focus = `专注比上月多 ${formatFocusDuration(focusDiff)}`;
  } else {
    focus = `专注比上月少 ${formatFocusDuration(-focusDiff)}`;
  }

  const doneDiff = report.tasks.done - previous.done;
  let done = '';
  if (doneDiff === 0) done = '完成数和上月一样';
  else if (doneDiff > 0) done = `完成比上月多 ${doneDiff} 项`;
  else done = `完成比上月少 ${-doneDiff} 项`;

  return { focus, done };
}
