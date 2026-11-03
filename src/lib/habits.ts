import { addDays, buildMonthGrid, isValidDateKey } from './date';
import type { DateKey, Habit, HabitCheck, HabitTaskLogEntry } from '../types';

/* ============================================================================
   习惯打卡（F12）—— 纯函数

   设计取舍：
   - 习惯 = 账号级配置；打卡 = 只增流水。分两张表存（见 types.ts 的 Habit 注释）。
   - 打卡用「habitId + date」当主键，所以「重复打卡」天然幂等 ——
     连点两下、网络重放、两台设备各点一次，结果都是"那天做了"。
   - **不做评分、不做催促**：和作息打卡同一条原则。习惯断一天不该被记账羞辱，
     用户自己看得见就够了。
   ========================================================================= */

/** 习惯名上限（太长会撑破今日页那一行） */
export const HABIT_NAME_MAX = 16;
/** 最多几个习惯（再多今日页就变成第二份待办清单了，与"轻量打卡"的定位冲突） */
export const HABIT_MAX = 8;

/** 习惯名的唯一收敛口径：trim + 截断。空名返回 ''（调用方据此拒绝） */
export function normalizeHabitName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, HABIT_NAME_MAX);
}

/** 还在用的习惯（未归档），保持原有顺序 */
export function activeHabits(habits: Habit[]): Habit[] {
  if (!Array.isArray(habits)) return [];
  return habits.filter((habit) => habit && habit.id && !habit.archivedAt);
}

/** 打卡的唯一 key —— 幂等的基础，也是合并取并集的依据 */
export function habitCheckKey(habitId: string, date: DateKey): string {
  return `${habitId}|${date}`;
}

/** 某天做过的习惯 id 集合（今日页渲染用 O(1) 查询） */
export function checkedHabitIds(checks: HabitCheck[], date: DateKey): Set<string> {
  const set = new Set<string>();
  if (!Array.isArray(checks)) return set;
  for (const check of checks) {
    if (check && check.date === date && typeof check.habitId === 'string') set.add(check.habitId);
  }
  return set;
}

/**
 * 切换一次打卡，返回新的打卡数组。
 *
 * 三条规则：
 * - 已经是"做过"→ 撤回（连同 key 一起移除）；否则追加。
 * - **幂等**：同一 (habitId, date) 不会出现两条（先剔除旧记录再追加）。
 * - 未知 habitId 拒绝写入：孤儿打卡会让"这习惯删了又出现"。
 */
export function toggleHabitCheck(
  checks: HabitCheck[],
  habitId: string,
  date: DateKey,
): HabitCheck[] {
  if (!Array.isArray(checks)) return checks;
  if (typeof habitId !== 'string' || !habitId || typeof date !== 'string' || !date) return checks;
  const existed = checks.some((check) => check && check.habitId === habitId && check.date === date);
  const rest = checks.filter((check) => !(check && check.habitId === habitId && check.date === date));
  return existed ? rest : [...rest, { habitId, date }];
}

/**
 * 连续打卡天数（从今天往前数）。
 *
 * 与专注 streak 同一口径：**今天还没打卡不立刻断**，从昨天开始数 ——
 * 否则每天零点一过，"连续 21 天"就变 0，早上打开应用先被打击一次。
 */
export function habitStreak(checks: HabitCheck[], habitId: string, today: DateKey): number {
  return streakFromDates(indexHabitChecks(checks).get(habitId), today);
}

/**
 * 把打卡流水按习惯建成索引（一次 O(n)）。
 *
 * 为什么需要：以前每个习惯各调一次 `habitStreak`，每次都要 `checks.filter` +
 * `new Set` —— 8 个习惯 × 几千条流水 = 每次渲染几万次元素访问，而这份索引
 * 本来只需要建一遍。`HabitStrip`（今日页常驻）与 `HabitCalendar`（设置页）
 * 都是受害者，而且它们内部各自 `useAppState()`，memo 挡不住。
 */
export function indexHabitChecks(checks: HabitCheck[]): Map<string, Set<DateKey>> {
  const index = new Map<string, Set<DateKey>>();
  if (!Array.isArray(checks)) return index;
  for (const check of checks) {
    if (!check || typeof check.habitId !== 'string' || typeof check.date !== 'string') continue;
    let dates = index.get(check.habitId);
    if (!dates) {
      dates = new Set<DateKey>();
      index.set(check.habitId, dates);
    }
    dates.add(check.date);
  }
  return index;
}

/** 从日期集合数连续天数（`habitStreak` 与 `habitStreakMap` 共用的唯一实现） */
function streakFromDates(dates: Set<DateKey> | undefined, today: DateKey): number {
  if (!dates || dates.size === 0) return 0;
  const has = (key: DateKey): boolean => dates.has(key);

  let streak = 0;
  let cursor = has(today) ? today : addDays(today, -1);
  // 上限 3650：兜住脏数据里的远古日期，绝不放任死循环
  for (let guard = 0; guard < 3650; guard += 1) {
    if (!has(cursor)) break;
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

/**
 * 一次性算出**所有**习惯的连续天数。
 *
 * 调用方在外面 `useMemo` 一次即可；不要再在 `map` 里逐个调 `habitStreak`，
 * 那是 O(习惯数 × 流水数)，而这里只有 O(流水数 + 习惯数 × 连续长度)。
 */
export function habitStreakMap(checks: HabitCheck[], today: DateKey): Map<string, number> {
  const streaks = new Map<string, number>();
  for (const [habitId, dates] of indexHabitChecks(checks)) {
    streaks.set(habitId, streakFromDates(dates, today));
  }
  return streaks;
}

/** 某天的完成度（今日页顶部那行 `3/5`） */
export function habitDayProgress(
  habits: Habit[],
  checks: HabitCheck[],
  date: DateKey,
): { done: number; total: number } {
  const active = activeHabits(habits);
  const done = checkedHabitIds(checks, date);
  return { done: active.filter((habit) => done.has(habit.id)).length, total: active.length };
}

/**
 * 合并两台设备的习惯配置。
 *
 * 按 id 取并集，重复时**以 base（较新一侧）为准** —— 改名 / 归档 / 恢复
 * 都是显式动作，不该被较旧的那一侧覆盖回去。
 * 代价是"在较旧的设备上归档"，同步后会变回在用；这比"新设备上刚建的习惯
 * 被旧设备的空数组整包清掉"要轻得多 —— 前者是一次操作没生效，后者是数据消失。
 */
export function mergeHabits(base: Habit[], other: Habit[]): Habit[] {
  const list: Habit[] = Array.isArray(base) ? [...base] : [];
  if (!Array.isArray(other)) return list;
  for (const habit of other) {
    if (!habit || typeof habit.id !== 'string' || !habit.id) continue;
    if (list.some((item) => item.id === habit.id)) continue;
    list.push(habit);
  }
  return list;
}

/**
 * 合并打卡流水：按 `habitId + date` 取并集。
 *
 * 打卡是**只增不改**的事实（"那天做了"），没有"谁更新"的问题，
 * 所以不需要时间戳比较 —— 与专注记录同一套逻辑。
 */
export function mergeHabitChecks(base: HabitCheck[], other: HabitCheck[]): HabitCheck[] {
  const seen = new Set<string>();
  const out: HabitCheck[] = [];
  for (const check of [...(Array.isArray(base) ? base : []), ...(Array.isArray(other) ? other : [])]) {
    if (!check || typeof check.habitId !== 'string' || !check.habitId) continue;
    if (typeof check.date !== 'string' || !check.date) continue;
    const key = habitCheckKey(check.habitId, check.date);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ habitId: check.habitId, date: check.date });
  }
  return out;
}

/* ============================================================================
   习惯日历（F15-B）

   为什么需要：原来只有"连续 N 天"。那个数字只记得住**最近**，
   看不见"这个月我漏了哪几天"—— 而漏在哪天恰恰是最有用的信息
   （周三总是断？周末全废？）。日历把这件事一眼摊开。
   ========================================================================= */

/** 日历上一格 */
export interface HabitCalendarDay {
  date: DateKey;
  /** 1–31（补位格也给自己那天的日号） */
  day: number;
  /** 是否属于当前展示月 */
  inMonth: boolean;
  isToday: boolean;
  /** 这天打了几个习惯（只算在用的） */
  done: number;
  /** 这天一共有几个在用的习惯 */
  total: number;
  /** `done / total`，0–1；total=0 时为 0 */
  ratio: number;
}

/**
 * 一个月的习惯日历（固定 42 格，含补位）。
 *
 * 性能口径：先把打卡流水压成 `日期 → 习惯 id 集合` 的索引，再查 42 个格子。
 * 反过来写（每个格子去遍历一遍流水）在 4000 条记录时会到 17 万次比较，
 * 每次重渲都跑一遍 —— 一个日历不该这么贵。
 */
export function habitCalendar(args: {
  habits: Habit[];
  checks: HabitCheck[];
  year: number;
  /** 0–11 */
  month0: number;
  weekStart: 0 | 1;
  today: DateKey;
}): HabitCalendarDay[] {
  const { habits, checks, year, month0, weekStart, today } = args;
  const active = activeHabits(habits);
  const total = active.length;
  const activeIds = new Set(active.map((habit) => habit.id));

  const byDate = new Map<string, Set<string>>();
  for (const check of Array.isArray(checks) ? checks : []) {
    if (!check || typeof check.date !== 'string' || !activeIds.has(check.habitId)) continue;
    const bucket = byDate.get(check.date);
    if (bucket) bucket.add(check.habitId);
    else byDate.set(check.date, new Set([check.habitId]));
  }

  return buildMonthGrid(year, month0, weekStart, today).map((cell) => {
    const done = byDate.get(cell.key)?.size ?? 0;
    return {
      date: cell.key,
      day: cell.day,
      inMonth: cell.inMonth,
      isToday: cell.isToday,
      done,
      total,
      ratio: total === 0 ? 0 : done / total,
    };
  });
}

/** 一个习惯的月度小结（设置页那行「本月 N 天 · 连续 M」用的） */
export interface HabitSummary {
  monthCount: number;
  streak: number;
}

/**
 * 一次算好全部习惯的「本月天数 + 连续天数」。
 *
 * 为什么批量：设置页原来是 `active.map(h => habitMonthCount(...) + habitStreak(...))`，
 * 每个习惯扫两遍全表 —— 8 个习惯 × 几千条流水 = 每次切月份/勾一次卡都要付 16 次全扫。
 * 建一份索引之后是 O(流水数 + 习惯数)。
 */
export function habitSummaryMap(
  checks: HabitCheck[],
  today: DateKey,
  year: number,
  month0: number,
): Map<string, HabitSummary> {
  const prefix = `${year}-${String(month0 + 1).padStart(2, '0')}-`;
  const out = new Map<string, HabitSummary>();
  for (const [habitId, dates] of indexHabitChecks(checks)) {
    let monthCount = 0;
    for (const date of dates) if (date.startsWith(prefix)) monthCount += 1;
    out.set(habitId, { monthCount, streak: streakFromDates(dates, today) });
  }
  return out;
}

/** 某个习惯在这个月打了几次卡（给"本月 N 天"用） */
export function habitMonthCount(
  checks: HabitCheck[],
  habitId: string,
  year: number,
  month0: number,
): number {
  const prefix = `${year}-${String(month0 + 1).padStart(2, '0')}-`;
  let count = 0;
  for (const check of Array.isArray(checks) ? checks : []) {
    if (check && check.habitId === habitId && typeof check.date === 'string' && check.date.startsWith(prefix)) {
      count += 1;
    }
  }
  return count;
}

/* ============================================================================
   习惯 → 今日任务（长期迭代「习惯与任务联动」）
   ========================================================================= */

/**
 * 生成流水的保留上限。
 *
 * 为什么是 1000 而不是和 `habitChecks` 一样 4000：判定只需要"**今天**有没有派过"，
 * 历史条目纯粹是"别重复派"的记忆残留。8 个习惯 × 125 天（约 4 个月）足够覆盖
 * 任何现实中的使用节奏，再往前的条目对判定毫无贡献，只会让云端载荷变胖。
 * 丢弃从**最旧**的开始，所以今天的判定永远不会受影响。
 */
export const HABIT_TASK_LOG_KEEP_MAX = 1000;

/** 一条生成记录的唯一 key（与打卡同构，但语义是"派过"而非"做过"） */
export function habitTaskLogKey(habitId: string, date: DateKey): string {
  return `${habitId}|${date}`;
}

/**
 * 收流水的口：合法日期 + 习惯仍然存在 + 同 key 去重 + 按日期升序 + 超量丢最旧。
 *
 * 「习惯必须存在」这一步和 `sanitizeHabitChecks` 同款：孤儿记录不参与判定，
 * 却会跟着云同步在设备间来回传，用户永远删不干净。
 */
export function sanitizeHabitTaskLog(raw: unknown, habits: Habit[]): HabitTaskLogEntry[] {
  if (!Array.isArray(raw)) return [];
  const alive = new Set((Array.isArray(habits) ? habits : []).map((habit) => habit.id));
  const seen = new Set<string>();
  const list: HabitTaskLogEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const habitId = typeof rec.habitId === 'string' ? rec.habitId : '';
    const date = typeof rec.date === 'string' && isValidDateKey(rec.date) ? rec.date : null;
    if (!habitId || !date || !alive.has(habitId)) continue;
    const key = habitTaskLogKey(habitId, date);
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ habitId, date });
  }
  list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return list.length > HABIT_TASK_LOG_KEEP_MAX
    ? list.slice(list.length - HABIT_TASK_LOG_KEEP_MAX)
    : list;
}

/**
 * 合并生成流水：按 `habitId + date` 取并集（只增事实，无需时间戳比较）。
 *
 * 结果**按日期升序**，与 `sanitizeHabitTaskLog` 保持同一口径 ——
 * 不排序的话，合并出来的数组和读盘后的数组顺序不一致，每次冷启动都会
 * 因为"数组变了"而多写一次盘、多推一次云（内容其实没变）。
 */
export function mergeHabitTaskLog(
  base: HabitTaskLogEntry[],
  other: HabitTaskLogEntry[],
): HabitTaskLogEntry[] {
  const seen = new Set<string>();
  const out: HabitTaskLogEntry[] = [];
  for (const entry of [
    ...(Array.isArray(base) ? base : []),
    ...(Array.isArray(other) ? other : []),
  ]) {
    if (!entry || typeof entry.habitId !== 'string' || !entry.habitId) continue;
    if (typeof entry.date !== 'string' || !entry.date) continue;
    const key = habitTaskLogKey(entry.habitId, entry.date);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ habitId: entry.habitId, date: entry.date });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

/** 今天该为哪些习惯生成任务（纯函数；已派过的、已归档的都不算） */
export function dueHabitTasks(args: {
  habits: Habit[];
  habitTaskLog: HabitTaskLogEntry[];
  date: DateKey;
}): { habitId: string; title: string }[] {
  const { habits, habitTaskLog, date } = args;
  if (typeof date !== 'string' || !date) return [];
  const logged = new Set<string>();
  for (const entry of Array.isArray(habitTaskLog) ? habitTaskLog : []) {
    if (entry && entry.date === date && typeof entry.habitId === 'string') {
      logged.add(entry.habitId);
    }
  }
  const due: { habitId: string; title: string }[] = [];
  for (const habit of activeHabits(habits)) {
    if (habit.autoTask !== true) continue;
    if (logged.has(habit.id)) continue;
    due.push({ habitId: habit.id, title: habit.name });
  }
  return due;
}
