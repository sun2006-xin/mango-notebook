import { addDays, dateKeyAtDayStart, diffDays, isValidDateKey, parseDateKey } from './date';
import type { DateKey, FocusSession, Task } from '../types';

/* ============================================================================
   专注时长统计（自习室口径）

   纪律：
   1. 本文件不依赖 React / window / localStorage，全部可单测；
   2. **所有入参都当脏数据看**。focusSessions 会经云同步从别的设备过来，
      别的设备可能是旧版本、也可能是被改过的数据；这里没有一个函数允许抛异常。
   3. 时长以 `endedAt - startedAt` 为准，不信 session.durationMs ——
      那是冗余字段，历史上单位不一致过，且可被手改。
   ========================================================================= */

/** 单条记录的毫秒数；非法（空 / 非数字 / 负 / 结束早于开始）一律记 0 */
export function sessionMs(session: FocusSession): number {
  if (!session || typeof session !== 'object') return 0;
  const start = Date.parse(String(session.startedAt ?? ''));
  const end = Date.parse(String(session.endedAt ?? ''));
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  const ms = end - start;
  // 超过 24 小时视为脏数据：没有人一次专注一整天，多半是忘了结束
  return ms > 0 && ms <= 86400000 ? ms : 0;
}

/**
 * 一条专注记录的结束时间：**开始时间 + 实际专注时长**。
 *
 * 绝不能用"现在"：统计口径（`sessionMs`）只认 `endedAt - startedAt`，
 * 于是"关页面 8 小时后回来"的记录会被算成一整天的专注。
 * 抽成函数是为了让这条口径可被单测钉住，而不是靠人记住。
 */
export function focusEndAt(startedAt: string, elapsedMs: number): string {
  const start = Date.parse(String(startedAt ?? ''));
  const safe = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  if (!Number.isFinite(start)) return new Date().toISOString();
  return new Date(start + safe).toISOString();
}

/**
 * 这段专注是不是"忘了结束"的幽灵记录。
 *
 * 场景：设了 25 分钟番茄 → 直接关掉页面 → 8 小时后重新打开。
 * 计时器接回运行态、发现早该结束，于是结束并记录 —— 但用户这 8 小时
 * 显然没有在学。不挡掉的话，「今日专注」「本周专注」「热力图」「连续打卡」
 * 「周报」会被一条 8 小时的记录全部污染。
 *
 * 判据刻意宽松（**两道**同时满足才算幽灵）：既明显超出计划（> 3×），
 * 又超过一小时 —— 只满足一个都不算，避免把"5 分钟番茄实际跑了 20 分钟"
 * 这种正常的走神误判成幽灵。
 */
export function isAbandonedFocus(wallMs: number, plannedMs: number): boolean {
  const planned = Number.isFinite(plannedMs) && plannedMs > 0 ? plannedMs : 0;
  if (planned <= 0) return false;
  if (!Number.isFinite(wallMs) || wallMs <= 0) return false;
  return wallMs > planned * 3 && wallMs > 3_600_000;
}

export interface CategoryFocus {
  /** 分类名；空串 = 未分类（自由专注 / 老记录 / 任务已删） */
  category: string;
  ms: number;
  /** 占本区间总时长的比例（0–1）；总时长为 0 时是 0 */
  ratio: number;
}

/**
 * 按科目（= 任务分类）聚合专注时长，降序。
 *
 * 数据来源是 `session.category`（写入时冗余下来的），**不靠 taskId 反查**：
 * 任务删了之后，那段专注仍然是"我在这门课上花过的时间"。
 * 老记录没有 category → 归入未分类，不丢、不报错。
 */
export function focusByCategory(
  sessions: FocusSession[],
  options: { from?: string; to?: string; fallbackName?: string } = {},
): CategoryFocus[] {
  const { from, to, fallbackName = '未分类' } = options;
  const acc = new Map<string, number>();
  let total = 0;
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (!session || typeof session !== 'object') continue;
    if (from && session.date < from) continue;
    if (to && session.date > to) continue;
    const ms = sessionMs(session);
    if (ms <= 0) continue;
    const key = typeof session.category === 'string' && session.category ? session.category : '';
    acc.set(key, (acc.get(key) ?? 0) + ms);
    total += ms;
  }
  return [...acc.entries()]
    .map(([key, ms]) => ({
      category: key || fallbackName,
      ms,
      ratio: total > 0 ? ms / total : 0,
    }))
    .sort((a, b) => b.ms - a.ms);
}

/** 一堆记录的总时长（毫秒） */
export function sumFocusMs(sessions: FocusSession[]): number {
  if (!Array.isArray(sessions)) return 0;
  let total = 0;
  for (const session of sessions) total += sessionMs(session);
  return total;
}

/**
 * ISO 时间戳 → 归属日（已按日界换算）。
 *
 * 日界（dayStartHour）的含义：一天从几点开始。设 4 点，则凌晨 3 点
 * 发生的记录仍算**前一天** —— 熬夜学到凌晨 3 点，不该被算进"明天"。
 * 这也是 FocusSession.date 落库时就换算好的原因（见 types.ts 的注释）。
 */
export function focusDateKey(iso: string, dayStartHour: number): DateKey {
  const parsed = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(parsed)) return dateKeyAtDayStart(new Date(), dayStartHour);
  return dateKeyAtDayStart(new Date(parsed), dayStartHour);
}

/** 按归属日聚合：date → 毫秒 */
export function focusMsByDate(sessions: FocusSession[]): Map<DateKey, number> {
  const map = new Map<DateKey, number>();
  if (!Array.isArray(sessions)) return map;
  for (const session of sessions) {
    if (!session || typeof session !== 'object') continue;
    const key =
      typeof session.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(session.date)
        ? session.date
        : focusDateKey(String(session.startedAt ?? ''), 0);
    map.set(key, (map.get(key) ?? 0) + sessionMs(session));
  }
  return map;
}

/** 某一天的专注毫秒数 */
export function dailyFocusMs(sessions: FocusSession[], date: DateKey): number {
  return focusMsByDate(sessions).get(date) ?? 0;
}

/** 某一周（含起止）的专注毫秒数 */
export function weeklyFocusMs(sessions: FocusSession[], startKey: DateKey): number {
  const byDate = focusMsByDate(sessions);
  let total = 0;
  for (let i = 0; i < 7; i += 1) total += byDate.get(addDays(startKey, i)) ?? 0;
  return total;
}

/**
 * '2小时30分钟' / '45分钟' / '未开始'。
 * 不到 1 分钟按 1 分钟算 —— 否则用户点了一下开始又停掉，界面显示"0分钟"像坏了。
 */
export function formatFocusDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '未开始';
  const totalMinutes = Math.max(1, Math.round(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}分钟`;
  if (minutes === 0) return `${hours}小时`;
  return `${hours}小时${minutes}分钟`;
}

/** 每日专注目标的上限（分钟）：24 小时。超过一律按 24 小时算 */
export const FOCUS_GOAL_MAX_MINUTES = 24 * 60;

export interface FocusGoalProgress {
  /** 目标分钟数；`0` = 不设目标 */
  goalMinutes: number;
  /** 已专注分钟（不足 1 分钟按 0 算 —— 目标进度不该被一次误点虚增） */
  focusedMinutes: number;
  /** 0–100；`goalMinutes === 0` 时为 null（不是 0：没有目标就没有百分比） */
  percent: number | null;
  /** 是否达成 */
  reached: boolean;
}

/**
 * 每日专注目标进度。
 *
 * 为什么要这个功能：番茄钟只告诉你"这段 25 分钟结束了"，
 * 而备考真正要管的是"今天总共学够没有"。目标一旦可见，
 * 到晚上还剩 40 分钟这件事就会自己推着人坐下 —— 比任何提醒都有效。
 *
 * 三条口径，都是为了不制造假焦虑：
 * - `goalMinutes === 0` → `percent = null`，UI 整块不渲染（不设目标就是不设）。
 * - 进度**不封顶在 100**：超额完成该看得见 130%，不是一律显示满格。
 * - 不足 1 分钟按 0 算：点一下又停掉不该让进度条动 1%。
 */
export function focusGoalProgress(
  sessions: FocusSession[],
  date: DateKey,
  goalMinutes: number,
): FocusGoalProgress {
  const goal = Number.isFinite(goalMinutes)
    ? Math.min(FOCUS_GOAL_MAX_MINUTES, Math.max(0, Math.trunc(goalMinutes)))
    : 0;
  const ms = dailyFocusMs(sessions, date);
  const focused = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 60000) : 0;
  if (goal === 0) return { goalMinutes: 0, focusedMinutes: focused, percent: null, reached: false };
  const percent = Math.round((focused / goal) * 100);
  return { goalMinutes: goal, focusedMinutes: focused, percent, reached: focused >= goal };
}

/**
 * 目标进度的一句话文案。
 *
 * 单独抽出来的原因：直接拼字符串会踩到 `formatFocusDuration(0) === '未开始'`，
 * 于是"刚起床还没开始"那会儿界面会写「已专注 未开始，还差 180 分钟」——
 * 一个明显不是人话的句子。文案有分支逻辑，就该被用例钉住。
 */
export function focusGoalHint(progress: FocusGoalProgress): string {
  const { goalMinutes, focusedMinutes, reached } = progress;
  if (goalMinutes === 0) return '';
  if (focusedMinutes === 0) return `还没开始，目标是 ${formatFocusDuration(goalMinutes * 60000)}`;
  const focused = formatFocusDuration(focusedMinutes * 60000);
  if (reached) return `已专注 ${focused}，今天够了`;
  return `已专注 ${focused}，还差 ${goalMinutes - focusedMinutes} 分钟`;
}

/**
 * 连续专注天数（打卡 streak）。
 *
 * 口径：从今天往前数；今天还没学则**不立刻断**，从昨天开始数 ——
 * 否则每天零点刚过时 streak 会归零，用户一觉醒来看到"连续 0 天"直接劝退。
 * 今天有记录 → 含今天；今天没有 → 从昨天起算（若昨天也没有，则为 0）。
 */
export function computeFocusStreak(sessions: FocusSession[], today: DateKey): number {
  const byDate = focusMsByDate(sessions);
  const has = (key: DateKey): boolean => (byDate.get(key) ?? 0) > 0;

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

/** 热力图单格 */
export interface HeatCell {
  date: DateKey;
  ms: number;
  /** 0=无 … 4=最浓；分档阈值见 buildFocusHeatmap */
  level: 0 | 1 | 2 | 3 | 4;
  weekday: number;
}

/**
 * 最近 N 天的热力图（从旧到新，长度为 days）。
 *
 * 分档用「相对当日上限」而不是绝对分钟数：有人一天学 30 分钟，有人学 8 小时，
 * 固定阈值会让前者永远全灰。上限为 0（这些天完全没学）时全返回 level 0。
 */
export function buildFocusHeatmap(
  sessions: FocusSession[],
  today: DateKey,
  days: number,
): HeatCell[] {
  const byDate = focusMsByDate(sessions);
  const cells: HeatCell[] = [];
  const raw: number[] = [];

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = addDays(today, -offset);
    const ms = byDate.get(date) ?? 0;
    raw.push(ms);
    cells.push({ date, ms, level: 0, weekday: parseDateKey(date).getDay() });
  }

  const max = Math.max(0, ...raw);
  if (max === 0) return cells;

  for (const cell of cells) {
    const ratio = cell.ms / max;
    cell.level = ratio === 0 ? 0 : ratio <= 0.25 ? 1 : ratio <= 0.5 ? 2 : ratio <= 0.75 ? 3 : 4;
  }
  return cells;
}

/**
 * 按任务聚合（哪门课花了多少时间）。
 * taskId 为空 / 指向已删除任务的记录归到 `null`（"自由专注"）。
 * 输出按毫秒降序 —— 用户想看的是"时间都花哪儿了"，不是 id 顺序。
 */
export function focusByTask(sessions: FocusSession[]): { taskId: string | null; ms: number }[] {
  const map = new Map<string | null, number>();
  if (!Array.isArray(sessions)) return [];
  for (const session of sessions) {
    if (!session || typeof session !== 'object') continue;
    const key = typeof session.taskId === 'string' && session.taskId ? session.taskId : null;
    map.set(key, (map.get(key) ?? 0) + sessionMs(session));
  }
  return [...map.entries()]
    .map(([taskId, ms]) => ({ taskId, ms }))
    .sort((a, b) => b.ms - a.ms);
}

/**
 * 给新记录生成归属日 —— reducer / UI 唯一应使用的入口。
 * 传 `now` 而不是内部读时钟，保持纯函数（ARCHITECTURE：reducer 不读时钟）。
 */
export function resolveSessionDate(startedAt: string, dayStartHour: number): DateKey {
  return focusDateKey(startedAt, dayStartHour);
}

/**
 * 墓碑式的过期清理：丢掉早于 `today - keepDays` 的记录。
 * 保留 90 天：既够画一整年的热力图轮廓，又不让数据量无限膨胀。
 */
export function pruneFocusSessions(
  sessions: FocusSession[],
  today: DateKey,
  keepDays: number,
): FocusSession[] {
  if (!Array.isArray(sessions)) return [];
  return sessions.filter((session) => {
    if (!session || typeof session.date !== 'string') return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(session.date)) return false;
    return diffDays(today, session.date) < keepDays;
  });
}

/* ============================================================================
   任务 ↔ 专注的聚合（F2 / F3 共用）

   与上面几个函数同纪律：**入参一律当脏数据看**，没有任何一条路径允许抛异常。
   这些数据会经云同步从别的设备过来（老版本 / 手改过的 JSON），
   一个 `startedAt: 'x'` 不该让整页统计崩掉。
   ========================================================================= */

/** 单条记录的归属日；`date` 非法时按 startedAt 现算（与 focusMsByDate 同一口径） */
function sessionDate(session: FocusSession): DateKey {
  if (typeof session.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(session.date)) {
    return session.date;
  }
  return focusDateKey(String(session.startedAt ?? ''), 0);
}

/** 单条记录的"开始小时"（0–23，本地时区）；非法时间返回 null */
function sessionHour(session: FocusSession): number | null {
  const parsed = Date.parse(String(session.startedAt ?? ''));
  if (!Number.isFinite(parsed)) return null;
  const hour = new Date(parsed).getHours();
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : null;
}

/** 按任务的专注概况（次数 + 总时长）；key 为 `null` = 不挂任务的自由专注 */
export interface TaskFocusStat {
  taskId: string | null;
  /** 段数（用户看到的"专注 N 次"） */
  count: number;
  ms: number;
}

/**
 * taskId → { count, ms }。
 *
 * 任务行上要显示「专注 3 次 · 75 分钟」，逐行 filter 一遍 focusSessions
 * 是 O(行数 × 记录数)；先聚合成 Map，渲染时 O(1) 取。
 *
 * ⚠️ 返回的 Map 用 `string | null` 做 key：自由专注（taskId 为 null）聚在
 * 一个 `null` 键上，不会被误并进任何一个真任务的 id。
 */
/**
 * **单条任务**的专注累计。
 *
 * 与 `focusStatsByTask` 的分工：那个是"整张列表都要用"（今日视图的任务行），
 * 先建 Map 再 O(1) 取才划算；这个是"只要一条"（任务抽屉的摘要），
 * 建一张完整的 Map 是纯浪费 —— 而 App 与 TodayView 曾经各建一次同样的 Map，
 * 一份数据在两处各聚合一遍。这里给一条不走 Map 的路。
 */
export function focusStatsForTask(
  sessions: FocusSession[],
  taskId: string | null,
): TaskFocusStat | undefined {
  if (!Array.isArray(sessions)) return undefined;
  let count = 0;
  let ms = 0;
  for (const session of sessions) {
    if (!session || typeof session !== 'object') continue;
    const sessionTaskId =
      typeof session.taskId === 'string' && session.taskId ? session.taskId : null;
    if (sessionTaskId !== taskId) continue;
    const value = sessionMs(session);
    // 与 focusStatsByTask 同口径：0 毫秒的脏记录不计次数
    if (value <= 0) continue;
    count += 1;
    ms += value;
  }
  return count === 0 ? undefined : { taskId, count, ms };
}

export function focusStatsByTask(sessions: FocusSession[]): Map<string | null, TaskFocusStat> {
  const map = new Map<string | null, TaskFocusStat>();
  if (!Array.isArray(sessions)) return map;
  for (const session of sessions) {
    if (!session || typeof session !== 'object') continue;
    const ms = sessionMs(session);
    // 0 毫秒的脏记录不计次数：否则"专注 5 次 · 0 分钟"会出现在任务行上
    if (ms <= 0) continue;
    const taskId = typeof session.taskId === 'string' && session.taskId ? session.taskId : null;
    const prev = map.get(taskId);
    if (prev) {
      prev.count += 1;
      prev.ms += ms;
    } else {
      map.set(taskId, { taskId, count: 1, ms });
    }
  }
  return map;
}

/**
 * 区间内专注时长最高的一天（含首尾）。
 *
 * 无数据 / 区间非法返回 null —— 让调用方显式处理"这周没学过"，
 * 而不是拿到一个 `1970-01-01 · 0 分钟` 的假结论。
 * 平手取**较早**的一天：稳定性优先（同样的输入必得同样的输出）。
 */
export function peakFocusDay(
  sessions: FocusSession[],
  start: DateKey,
  end: DateKey,
): { date: DateKey; ms: number } | null {
  if (!isValidDateKey(start) || !isValidDateKey(end) || start > end) return null;
  const byDate = focusMsByDate(sessions);
  let best: { date: DateKey; ms: number } | null = null;
  let cursor = start;
  // 上限 400 天：兜住脏区间，绝不放任死循环
  for (let guard = 0; guard < 400 && cursor <= end; guard += 1) {
    const ms = byDate.get(cursor) ?? 0;
    if (ms > 0 && (best === null || ms > best.ms)) best = { date: cursor, ms };
    cursor = addDays(cursor, 1);
  }
  return best;
}

/**
 * 区间内专注时长最高的时段（0–23 点）。
 *
 * 口径是**开始时间**落在哪个小时：一段 9:50–10:20 的专注算 9 点。
 * 用开始时间而不是均分到两个时段 —— 用户问"我几点最专注"时，答案是
 * "开始学的那个点"，不是"跨过的两个点各算一半"。
 */
export function peakFocusHour(
  sessions: FocusSession[],
  start: DateKey,
  end: DateKey,
): { hour: number; ms: number } | null {
  if (!isValidDateKey(start) || !isValidDateKey(end) || start > end) return null;
  const buckets = new Map<number, number>();
  if (Array.isArray(sessions)) {
    for (const session of sessions) {
      if (!session || typeof session !== 'object') continue;
      const date = sessionDate(session);
      if (date < start || date > end) continue;
      const ms = sessionMs(session);
      if (ms <= 0) continue;
      const hour = sessionHour(session);
      if (hour === null) continue;
      buckets.set(hour, (buckets.get(hour) ?? 0) + ms);
    }
  }
  let best: { hour: number; ms: number } | null = null;
  for (let hour = 0; hour < 24; hour += 1) {
    const ms = buckets.get(hour) ?? 0;
    if (ms > 0 && (best === null || ms > best.ms)) best = { hour, ms };
  }
  return best;
}

/**
 * 时间去向：按任务分类聚合（周报的「时间都花在哪儿」）。
 *
 * taskId 指向**已被删除**的任务（或任务根本没挂）→ 归到空串 `''`（未分类）。
 * 这条规则很重要：任务归档掉之后，它的专注记录还在，
 * 如果把这些记录丢掉，周报里"本周专注 5 小时"和下面分类加起来只有 2 小时，
 * 用户会以为统计错了。
 */
export function focusMsByCategory(
  sessions: FocusSession[],
  tasks: Task[],
): { category: string; ms: number }[] {
  const categoryById = new Map<string, string>();
  if (Array.isArray(tasks)) {
    for (const task of tasks) {
      if (!task || typeof task !== 'object' || typeof task.id !== 'string') continue;
      categoryById.set(task.id, typeof task.category === 'string' ? task.category : '');
    }
  }

  const buckets = new Map<string, number>();
  if (Array.isArray(sessions)) {
    for (const session of sessions) {
      if (!session || typeof session !== 'object') continue;
      const ms = sessionMs(session);
      if (ms <= 0) continue;
      const taskId = typeof session.taskId === 'string' && session.taskId ? session.taskId : null;
      const category = (taskId ? categoryById.get(taskId) : '') ?? '';
      buckets.set(category, (buckets.get(category) ?? 0) + ms);
    }
  }

  return [...buckets.entries()]
    .map(([category, ms]) => ({ category, ms }))
    .sort((a, b) => b.ms - a.ms);
}
