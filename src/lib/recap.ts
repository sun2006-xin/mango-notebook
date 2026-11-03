import { addDays } from './date';
import { dailyFocusMs, formatFocusDuration } from './focus';
import { activeHabits, checkedHabitIds } from './habits';
import { getOverdueTasks, getTasksForDate } from './task';
import type { DateKey, FocusSession, Habit, HabitCheck, Task } from '../types';

/* ============================================================================
   每日收尾卡（F15-A）

   设计立场：**不新增"打卡"这个动作，只把已有的数据在正确的时间点摆出来。**
   这个应用里已经有三个打卡系统（习惯 / 作息 / 专注连续），再加一个"今天我来过了"
   的签到不产生任何信息 —— 点一下只告诉你"你点了一下"。而备考期真正容易丢的是
   "我今天到底推进了什么"这个感觉，它只能从数据里捞，不能靠手点。

   触发口径：**第二天第一次打开时回顾昨天**，一天只出一次（`lastRecapSeen`）。
   不放在"当天晚上"是因为没人能保证晚上会打开；而"第二天早上"是必然会发生的。
   ========================================================================= */

export interface DailyRecap {
  /** 被回顾的那一天（通常是昨天） */
  date: DateKey;
  tasks: { total: number; done: number };
  focusMs: number;
  habits: { done: number; total: number };
  /** 承接：今天还有多少要做 */
  today: { open: number; overdue: number };
  /**
   * 这一天有没有值得回顾的东西。
   * 三样全空时**整张卡不渲染** —— 一个"昨天完成 0/0 项"的卡片只是提醒人失败。
   */
  hasContent: boolean;
}

export interface DailyRecapArgs {
  tasks: Task[];
  focusSessions: FocusSession[];
  habits: Habit[];
  habitChecks: HabitCheck[];
  /** 被回顾的那一天 */
  date: DateKey;
  /** 真实今天（用来算今日待办与逾期） */
  today: DateKey;
}

export function buildDailyRecap(args: DailyRecapArgs): DailyRecap {
  const { tasks, focusSessions, habits, habitChecks, date, today } = args;
  const safeTasks = Array.isArray(tasks) ? tasks : [];

  const dayTasks = getTasksForDate(safeTasks, date);
  const done = dayTasks.filter((task) => task.done).length;
  const focusMs = dailyFocusMs(Array.isArray(focusSessions) ? focusSessions : [], date);

  const active = activeHabits(habits);
  const checked = checkedHabitIds(Array.isArray(habitChecks) ? habitChecks : [], date);
  const habitDone = active.filter((habit) => checked.has(habit.id)).length;

  const todayTasks = getTasksForDate(safeTasks, today);
  const open = todayTasks.filter((task) => !task.done).length;
  const overdue = getOverdueTasks(safeTasks, today).length;

  return {
    date,
    tasks: { total: dayTasks.length, done },
    focusMs,
    habits: { done: habitDone, total: active.length },
    today: { open, overdue },
    hasContent: dayTasks.length > 0 || focusMs > 0 || habitDone > 0,
  };
}

/**
 * 回顾那一天的文案（一到两行）。
 *
 * 三条克制：
 * - 没有专注就不提"专注 0 分钟"，没有习惯就不提"习惯 0/0"——空项不占行。
 * - **不评价**（不写"很棒""要加油"）。数据摆出来，结论留给人。
 * - 任务 0 项但有关注 → 只说专注；三样全空 → UI 根本不会渲染这张卡。
 */
export function recapLines(recap: DailyRecap): string[] {
  const parts: string[] = [];
  if (recap.tasks.total > 0) parts.push(`完成 ${recap.tasks.done} / ${recap.tasks.total} 项`);
  if (recap.focusMs > 0) parts.push(`专注 ${formatFocusDuration(recap.focusMs)}`);
  if (recap.habits.total > 0 && recap.habits.done > 0) {
    parts.push(`习惯 ${recap.habits.done} / ${recap.habits.total}`);
  }
  return parts.length > 0 ? [parts.join(' · ')] : [];
}

/** 承接今天的一句话（待办 / 逾期）—— 没有待办时给一句轻的，不留空白 */
export function todayOutlook(recap: DailyRecap): string {
  const parts: string[] = [];
  if (recap.today.open > 0) parts.push(`${recap.today.open} 项待办`);
  if (recap.today.overdue > 0) parts.push(`${recap.today.overdue} 项逾期`);
  return parts.length > 0 ? `今天 ${parts.join(' · ')}` : '今天还没安排任务';
}

/** 昨天 —— 收尾卡回顾的那一天（跨月 / 跨年由 addDays 处理） */
export function recapDate(today: DateKey): DateKey {
  return addDays(today, -1);
}

/* ----------------------------------------------------------------------------
   最近 N 天完成率趋势
   ---------------------------------------------------------------------------
   为什么要有：收尾卡原来只有"昨天 3/5"这一个数字，孤零零的分数既看不出
   起伏、也看不出这一天在这周里算什么水平。一条 7 格的小柱子把"最近在往上走
   还是往下掉"直接摆在眼前 —— 这是数字换了种说法，不是新增一个评分。

   两条克制：
   - 没有任务的那天**画成空槽**（不是 0 分的柱子）：那天本来就没安排，
     画成"完成 0%"是在无中生有地指责用户；
   - 整窗只显示在**至少两天有任务**时（`hasTrend` 判），否则一条全是空槽的
     图既没信息又占地方。
   ------------------------------------------------------------------------- */

export interface RecapTrendPoint {
  date: DateKey;
  done: number;
  total: number;
  /** 0–1；`total === 0` 时为 0，调用方据此画成空槽 */
  ratio: number;
}

/** 以 `endDate` 结尾、长度 `days` 的完成率序列（时间正序，最后一格是 endDate） */
export function recapTrend(tasks: Task[], endDate: DateKey, days = 7): RecapTrendPoint[] {
  const safeTasks = Array.isArray(tasks) ? tasks : [];
  // 夹到 1–14：太少没有形状，太多手机上一格只有 3px 宽
  const raw = Math.trunc(days);
  const span = Number.isFinite(raw) ? Math.min(14, Math.max(1, raw)) : 7;

  const points: RecapTrendPoint[] = [];
  for (let offset = span - 1; offset >= 0; offset -= 1) {
    const date = addDays(endDate, -offset);
    const dayTasks = getTasksForDate(safeTasks, date);
    const total = dayTasks.length;
    const done = dayTasks.filter((task) => task.done).length;
    points.push({ date, done, total, ratio: total === 0 ? 0 : done / total });
  }
  return points;
}

/** 这条趋势到底值不值得画（至少两天安排过任务） */
export function hasTrend(points: RecapTrendPoint[]): boolean {
  if (!Array.isArray(points)) return false;
  return points.filter((point) => point.total > 0).length >= 2;
}

/**
 * 这张卡到底要不要显示。
 *
 * 抽成纯函数是为了能被用例钉住 —— 这是它唯一的"时机"逻辑，
 * 而时机错了的代价很具体：**每次刷新都弹一遍**，用户会开始讨厌它。
 *
 * 两条都得满足：这一天的回顾**没看过**，且**有内容**。
 * 注意"看过"记的是被回顾的那一天：跨天后 `recapDate` 前移，
 * 于是新的一天会自然重新出现一次，不需要任何定时器。
 */
export function shouldShowRecap(recap: DailyRecap, lastSeen: DateKey | null): boolean {
  if (!recap.hasContent) return false;
  return lastSeen !== recap.date;
}
