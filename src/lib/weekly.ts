import { DIARY_MAX, TEXT } from '../constants';
import { addDays, formatWeekTitle, getWeekRange } from './date';
import {
  focusMsByCategory,
  formatFocusDuration,
  peakFocusDay,
  peakFocusHour,
  weeklyFocusMs,
} from './focus';
import { reviewCountInRange, reviewStats } from './srs';
import { getDayProgress } from './task';
import type { DateKey, DiaryEntry, FocusSession, Note, Task } from '../types';

/* ============================================================================
   周报复盘（F3）—— 把"这周到底学成什么样"算成一份可回看的账

   两条设计纪律：
   1. **纯派生**：这里只读不写，不碰 React / localStorage / reducer。
      同一份输入必得同一份输出，所以周报可以单测、也可以随时重算。
   2. **不写虚荣指标，但也不藏正反馈**。
      主理人 v0.8 裁定：用**队列健康度**（卡片 / 已排期 / 成熟卡）回答
      "我的复习计划是在推进还是在堵车"；
      v0.9 补充：再加一行「本周复习 N 张」—— 它不是虚荣数字，而是
      "这段时间真的学了几张"的**投入量**，靠 `sr.last` 精确归日。
      两者都显示：前者指导排期，后者给人正反馈，缺一不可。
   ========================================================================= */

export interface WeeklyStatsArgs {
  tasks: Task[];
  focusSessions: FocusSession[];
  notes: Note[];
  /** 当前真实今天 */
  today: DateKey;
  /** 每周起始日（0 = 周日，1 = 周一）；与 settings.weekStart 同源 */
  weekStart: 0 | 1;
  /**
   * 整周平移量：`0` = 本周（默认）、`-1` = 上一周、`+1` = 下一周。
   *
   * ⚠️ `weekStart` 仍然由 `settings.weekStart` + `today` 算出来 ——
   * offset **只平移整周**（±7 天），不改变"一周从周几开始"。
   * 也就是说：先按设置算出本周起止，再整体挪 offset×7 天。
   *
   * 为什么不做成"传任意日期"：周报的三档切换就是「上一周 / 本周 / 下一周」，
   * 用 offset 表达等于把 UI 的语义直接写进类型里，调用方不可能传错日期。
   */
  weekOffset?: number;
}

export interface WeeklyStats {
  /** 本周起止（含首尾）；有 weekOffset 时是**平移后**那一周的起止 */
  startKey: DateKey;
  endKey: DateKey;
  /** 实际生效的整周平移量（0 / -1 / +1；脏值已被收敛成 0） */
  weekOffset: number;
  /** '10月19日 – 25日' */
  rangeLabel: string;
  /** 本周专注毫秒 */
  focusMs: number;
  /** 上周同期专注毫秒（环比用） */
  prevFocusMs: number;
  /** 环比百分比；上周为 0 时 null（不显示"∞%"或"100%"这种假结论） */
  focusDeltaPercent: number | null;
  /** 本周完成任务数（按 task.date 归日，不按 doneAt） */
  doneCount: number;
  /** 本周安排的任务总数 */
  totalCount: number;
  /** 完成率 0–100；没有安排任务时 null */
  doneRate: number | null;
  peakDay: { date: DateKey; ms: number } | null;
  peakHour: { hour: number; ms: number } | null;
  /** 时间去向（按分类，ms 降序；空串 = 未分类） */
  byCategory: { category: string; ms: number }[];
  /** 复习队列健康度 */
  review: { total: number; scheduled: number; mature: number };
  /**
   * 区间内**复习过几张卡**（按 `sr.last` 的本地日期归日，含首尾端点）。
   *
   * 与 `review` 的分工：`review` 说的是"队列健康度"（现在有多少卡、堵不堵车），
   * `reviewedCount` 说的是"这段时间真的学了几张"（投入量）。
   * 两者都显示 —— 前者指导排期，后者给人正反馈，缺一不可。
   */
  reviewedCount: number;
}

/** 周报里要填的三句话（主理人裁定：只问三个，多了没人填） */
export interface WeeklyAnswers {
  /** 最大收获 */
  harvest: string;
  /** 最大问题 */
  problem: string;
  /** 下周最重要的一件事 */
  next: string;
}

const EMPTY_ANSWERS: WeeklyAnswers = { harvest: '', problem: '', next: '' };

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 本周的统计口径全部在这里定死，调用方不要自己再算一遍 */
export function buildWeeklyStats({
  tasks,
  focusSessions,
  notes,
  today,
  weekStart,
  weekOffset = 0,
}: WeeklyStatsArgs): WeeklyStats {
  const safeTasks = Array.isArray(tasks) ? tasks : [];
  const safeSessions = Array.isArray(focusSessions) ? focusSessions : [];
  const safeNotes = Array.isArray(notes) ? notes : [];

  /**
   * 两步算周区间，顺序不能换：
   * ① `getWeekRange(today, weekStart)` —— 按设置算出**本周**起止；
   * ② 再整体平移 `weekOffset × 7` 天 —— offset 只挪整周，不碰"周从周几开始"。
   *
   * 脏 offset（NaN / 小数 / 字符串）一律收敛成 0（= 本周）：
   * 周报是只读派生，宁可按本周显示，也不能因为一个坏参数把整块渲染成空白。
   */
  const offset = Number.isFinite(weekOffset) ? Math.trunc(weekOffset) : 0;
  const thisWeek = getWeekRange(today, weekStart);
  const startKey = addDays(thisWeek.startKey, offset * 7);
  const endKey = addDays(startKey, 6);
  const prevStart = addDays(startKey, -7);

  let doneCount = 0;
  let totalCount = 0;
  // 7 天循环取日进度：口径与今日视图头部的进度条完全一致（同一个 getDayProgress），
  // 否则用户会发现"周报说完成 12，我今天看到的是 13"
  for (let i = 0; i < 7; i += 1) {
    const day = addDays(startKey, i);
    const progress = getDayProgress(safeTasks, day);
    doneCount += progress.done;
    totalCount += progress.total;
  }

  const focusMs = weeklyFocusMs(safeSessions, startKey);
  const prevFocusMs = weeklyFocusMs(safeSessions, prevStart);
  const focusDeltaPercent =
    prevFocusMs > 0 ? Math.round(((focusMs - prevFocusMs) / prevFocusMs) * 100) : null;

  const inWeek = safeSessions.filter((session) => {
    if (!session || typeof session.date !== 'string') return false;
    return session.date >= startKey && session.date <= endKey;
  });

  return {
    startKey,
    endKey,
    weekOffset: offset,
    rangeLabel: formatWeekTitle(startKey, endKey),
    focusMs,
    prevFocusMs,
    focusDeltaPercent,
    doneCount,
    totalCount,
    doneRate: totalCount === 0 ? null : Math.round((doneCount / totalCount) * 100),
    peakDay: peakFocusDay(safeSessions, startKey, endKey),
    peakHour: peakFocusHour(safeSessions, startKey, endKey),
    byCategory: focusMsByCategory(inWeek, safeTasks),
    review: reviewStats(safeNotes),
    reviewedCount: reviewCountInRange(safeNotes, startKey, endKey),
  };
}

/**
 * 周报该写进**哪一天**的那篇日记 = `min(today, 那一周的最后一天)`。
 *
 * 三种情形（主理人 v0.8.1 裁定）：
 * 1. **本周**：`endKey >= today` → 写**今天**（原来的行为，不变）；
 * 2. **历史周**：`endKey < today` → 写**那一周的最后一天**（补写以前的周报）；
 * 3. **未来周**：同样只会得到 `today`（`min` 天然不会把字写进未来），
 *    但未来周本来就在 UI 上被 `canWriteWeekly` 拦住，这里只是兜底不自相矛盾。
 *
 * 为什么落在"那一周最后一天"：周报是**一周的总结**，放在那一周收尾那天最自然；
 * 而且历史周的 `endKey` 天然小于 `today`，永远写不到未来去。
 *
 * 为什么可以直接用字符串比较：`DateKey` 是定长 `'YYYY-MM-DD'`（含前导零），
 * 字典序与时间序一致，不需要解析成 Date（也就没有时区坑）。
 */
export function weeklyWriteDate(today: DateKey, endKey: DateKey): DateKey {
  const safeToday = typeof today === 'string' ? today : '';
  const safeEnd = typeof endKey === 'string' ? endKey : '';
  // 缺一个就退化成另一个：宁可写回今天，也不能生成一个空日期去建墓碑
  if (!safeEnd) return safeToday;
  if (!safeToday) return safeEnd;
  return safeEnd < safeToday ? safeEnd : safeToday;
}

/** '21:00–22:00'（23 点写成 23:00–24:00，不跨到 00:00 让人误读成两个时段） */
function formatHourRange(hour: number): string {
  const safe = Math.min(23, Math.max(0, Math.trunc(hour)));
  return `${pad2(safe)}:00–${pad2(safe + 1)}:00`;
}

/** '2026-10-24 12:30'（生成时间，用本地时区） */
function formatStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  );
}

/** 分类去向那一行：`学习 1小时30分钟 · 工作 40分钟`（未分类显式写出） */
function formatCategoryLine(rows: { category: string; ms: number }[]): string {
  if (rows.length === 0) return '—';
  return rows
    .slice(0, 4)
    .map((row) => `${row.category || TEXT.uncategorized} ${formatFocusDuration(row.ms)}`)
    .join(' · ');
}

/**
 * 生成周报区块的 Markdown。
 *
 * ⚠️ 开头那行必须是 `## 本周回顾 · {区间}` —— `upsertWeeklySection` 靠
 * `startsWith(marker)` 找到它做幂等替换。改动标题格式会让旧区块再也替换不上，
 * 结果是每次写入都追加一份新的（日记里堆满周报）。
 *
 * 小标题用 `### `：它以 `'## '` 之外的前缀开头，所以"找下一个 `## `"的
 * 结束判定不会被自己的小标题提前截断。
 */
export function buildWeeklyMarkdown(
  stats: WeeklyStats,
  answers: WeeklyAnswers = EMPTY_ANSWERS,
  generatedAt: string = '',
): string {
  const delta =
    stats.focusDeltaPercent === null
      ? ''
      : `（上周 ${formatFocusDuration(stats.prevFocusMs)}，${
          stats.focusDeltaPercent >= 0 ? '+' : ''
        }${stats.focusDeltaPercent}%）`;

  const lines: string[] = [
    `${TEXT.weeklyMarker} · ${stats.rangeLabel}`,
    '',
    `- ${TEXT.weeklyFocusThisWeek}：${formatFocusDuration(stats.focusMs)}${delta}`,
    `- ${TEXT.weeklyDone}：${stats.doneCount} / ${stats.totalCount}，${TEXT.weeklyRate} ${
      stats.doneRate === null ? TEXT.emptyPercent : `${stats.doneRate}%`
    }`,
    `- ${TEXT.weeklyPeakDay}：${
      stats.peakDay ? `${stats.peakDay.date}（${formatFocusDuration(stats.peakDay.ms)}）` : '—'
    }`,
    `- ${TEXT.weeklyPeakHour}：${
      stats.peakHour ? formatHourRange(stats.peakHour.hour) : '—'
    }`,
    `- ${TEXT.weeklyByCategory}：${formatCategoryLine(stats.byCategory)}`,
    // 「本周复习 N 张」：区间内评级过的卡片数（靠 sr.last 归日）。
    // 它和下面那行「复习队列」并存 —— 一个说"这段时间学了没"，一个说"后面堵不堵"。
    `- ${TEXT.weeklyReviewed}：${stats.reviewedCount} ${TEXT.weeklyReviewedUnit}`,
    `- ${TEXT.reviewHealthTitle}：${TEXT.reviewHealthCards} ${stats.review.total} ${TEXT.reviewHealthUnit} · ${TEXT.reviewHealthScheduled} ${stats.review.scheduled} ${TEXT.reviewHealthUnit} · ${TEXT.reviewHealthMature} ${stats.review.mature} ${TEXT.reviewHealthUnit}${
      stats.review.total > 0
        ? `（${Math.round((stats.review.mature / stats.review.total) * 100)}%）`
        : ''
    }`,
  ];

  const blocks: [string, string][] = [
    [TEXT.weeklyAnswerHarvest, answers.harvest],
    [TEXT.weeklyAnswerProblem, answers.problem],
    [TEXT.weeklyAnswerNext, answers.next],
  ];
  for (const [title, body] of blocks) {
    lines.push('', `### ${title}`, body.trim() ? body.trim() : '—');
  }

  const stamp = formatStamp(generatedAt);
  if (stamp) lines.push('', `> 生成于 ${stamp}`);

  return lines.join('\n');
}

/**
 * 把周报区块**幂等**写进日记正文。
 *
 * 三种情况：
 * 1. 正文里没有 marker → 追加到末尾（前面有内容就空一行）；
 * 2. 有 marker → 替换"marker 行"到"下一个以 `## ` 开头的行"之间的内容；
 * 3. 替换后若超出 DIARY_MAX → 截断到上限并回报 `truncated`（由 UI 红字提示）。
 *
 * 为什么结束判定是 `'## '` 而不是 `'#'`：周报内部的三句话用 `### ` 小标题，
 * 用宽前缀会把它们当成"下一个区块"的起点，自己把自己截断成半份。
 */
export function upsertWeeklySection(
  existing: string,
  section: string,
  marker: string,
): { content: string; replaced: boolean; truncated: boolean; skipped: boolean } {
  const base = typeof existing === 'string' ? existing : '';
  const lines = base.split('\n');
  const start = lines.findIndex((line) => line.startsWith(marker));

  let next: string;
  if (start < 0) {
    const head = base.trimEnd();
    next = head ? `${head}\n\n${section}` : section;
  } else {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (lines[i] !== undefined && lines[i]!.startsWith('## ')) {
        end = i;
        break;
      }
    }
    const before = lines.slice(0, start);
    const after = lines.slice(end);
    /**
     * `end` 指向下一个 `## ` 行时，它前面那个分隔空行落在了被替换区间里 → 会被吃掉。
     * 补回一个空行，保持区块与后续小节之间的排版（Markdown 渲染不受影响，纯源码美观）。
     */
    const sep = end < lines.length && after.length > 0 ? [''] : [];
    next = [...before, ...section.split('\n'), ...sep, ...after].join('\n');
  }

  /**
   * 空间不足时**放弃写入**，原样返回。
   *
   * 原来是"照写再截断"：`next.slice(0, DIARY_MAX)` 把尾巴切掉，而周报区块
   * 正好在尾巴上 —— 于是 marker 行没了。下一次点击判定"还没有周报"（marker
   * 找不到）→ 又追加一份 → 用户点几次就有几份半截周报，界面却一直显示
   * "已生成 · 点开修改"。幂等比"尽力写入"更重要：宁可这次不写，也要让下一次
   * 的判定是对的。
   */
  if (next.length > DIARY_MAX) {
    return { content: base, replaced: false, truncated: true, skipped: true };
  }
  return { content: next, replaced: start >= 0, truncated: false, skipped: false };
}

/* ============================================================================
   周报**自动**生成（长期迭代）
   ----------------------------------------------------------------------------
   F3 已经有完整的周报生成链路（stats → markdown → 幂等写进日记），但它要用户
   每周自己点一次。真实使用里"每周点一次"几乎不会发生 —— 那个按钮点过 2 次
   之后就被忘了，周报功能等于没做。

   自动生成的三条纪律（都是踩过的坑的同类）：
   ① **只写上一周**：启动时回头补写"上一周"。绝不批量补历史（用户第一次打开
      新版会看到日记里突然多出几十篇周报，那比没有周报更糟）。
   ② **空周不写**：一周既没专注、也没完成任务、也没复习卡 → 什么都不写。
      往日记里塞一行"专注 0 分钟"是噪声，不是复盘。
   ③ **写过的周不再碰**：靠 `settings.weeklyReportLog`（周起始日）去重，
      **不是**靠"日记里有没有 marker" —— 用户删掉那份周报之后，只查 marker
      会立刻把它写回去，删不掉。
   ========================================================================= */

/** 周报自动生成记录最多留多少周（约一年）；只增流水，超量丢最旧 */
export const WEEKLY_REPORT_LOG_KEEP_MAX = 60;

/** 收周报生成记录：只认合法日期 + 去重 + 升序 + 超量丢最旧 */
export function sanitizeWeeklyReportLog(raw: unknown): DateKey[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const list: DateKey[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item)) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    list.push(item);
  }
  list.sort();
  return list.length > WEEKLY_REPORT_LOG_KEEP_MAX
    ? list.slice(list.length - WEEKLY_REPORT_LOG_KEEP_MAX)
    : list;
}

/** 合并两台设备的生成记录：字符串集合取并集（只增事实） */
export function mergeWeeklyReportLog(base: DateKey[], other: DateKey[]): DateKey[] {
  return sanitizeWeeklyReportLog([
    ...(Array.isArray(base) ? base : []),
    ...(Array.isArray(other) ? other : []),
  ]);
}

export type WeeklyAutoReportPlan =
  | { kind: 'write'; startKey: DateKey; writeDate: DateKey; content: string; stats: WeeklyStats }
  /**
   * 不写。`logged` / `already-written` 两种都要被调用方**记进日志**：
   * 前者本来就记过，后者是"用户已经有一份了"，记下才不会被反复检查与覆盖。
   * `empty` 不记 —— 空周以后可能因为同步进来数据而变得不空。
   */
  | { kind: 'skip'; startKey: DateKey; reason: 'logged' | 'empty' | 'already-written' };

/**
 * 决定"这次要不要自动写上一周的周报"，要写就把内容一起算好。
 *
 * 纯函数：不读时钟、不写状态、不碰 localStorage（`now` 由调用方传）。
 */
export function planWeeklyAutoReport(args: {
  tasks: Task[];
  focusSessions: FocusSession[];
  notes: Note[];
  diary: DiaryEntry[];
  today: DateKey;
  weekStart: 0 | 1;
  /** 已处理过的周起始日（settings.weeklyReportLog） */
  log: DateKey[];
  /** 生成时间戳（ISO），写进"生成于 …"那一行 */
  now: string;
}): WeeklyAutoReportPlan {
  const stats = buildWeeklyStats({
    tasks: args.tasks,
    focusSessions: args.focusSessions,
    notes: args.notes,
    today: args.today,
    weekStart: args.weekStart,
    // 只处理**上一周**：本周还没结束，提前写一份"这周的总结"就是编造
    weekOffset: -1,
  });

  const logged = Array.isArray(args.log) ? args.log : [];
  if (logged.includes(stats.startKey)) return { kind: 'skip', startKey: stats.startKey, reason: 'logged' };

  /**
   * 空周的判据要**三条全零**：只看专注时长的话，"这周只勾了任务没开计时"
   * 也会被判成空周，用户会觉得周报漏了；只看任务的话，纯专注用户同理。
   */
  if (stats.focusMs === 0 && stats.doneCount === 0 && stats.reviewedCount === 0) {
    return { kind: 'skip', startKey: stats.startKey, reason: 'empty' };
  }

  const writeDate = weeklyWriteDate(args.today, stats.endKey);
  const target = (Array.isArray(args.diary) ? args.diary : []).find(
    (entry) => entry && entry.date === writeDate,
  );
  if (typeof target?.content === 'string' && target.content.includes(TEXT.weeklyMarker)) {
    return { kind: 'skip', startKey: stats.startKey, reason: 'already-written' };
  }

  const content = buildWeeklyMarkdown(stats, EMPTY_ANSWERS, args.now);
  return { kind: 'write', startKey: stats.startKey, writeDate, content, stats };
}
