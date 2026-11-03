import { TEXT } from '../constants';
import { sumFocusMs } from './focus';
import type { DateKey, FocusSession, Task } from '../types';

/* ============================================================================
   今日时间预算（F1）—— 纯函数，零 React / 零 localStorage

   回答一个问题：「今天还剩多少活，我已经投进去多少时间」。

   三个数字的口径（**改之前先读这里**）：
   1. `estimatedMinutes` = 当日**未完成 + 顶层**任务的估时之和。
      - 只算未完成：已经做完的事不该继续占着今天的预算，否则"预计"永远降不下来；
      - **只算顶层**：子任务是父任务的"步骤"，如果父子都填了估时就会重复计一遍
        （父 60 分钟 = 子 20+20+20，加起来变 120）。简化口径：只认父任务那一份。
   2. `focusedMs` = 当日 focusSessions 的毫秒和（复用 lib/focus 的 sumFocusMs，
      与自习室 / 周报同源，不另算一套）。
   3. `unestimatedCount` = 上面那批任务里 `estimatedMinutes === 0` 的条数 ——
      用来提示"预算还没算全"，否则用户会以为预计时间就是全部。

   入参一律当脏数据看（会经云同步从别的设备过来），任何路径都不抛异常。
   ========================================================================= */

/** 一天的预算快照（视图 + 测试共用） */
export interface DayBudget {
  /** 未完成顶层任务的估时之和（分钟） */
  estimatedMinutes: number;
  /** 当日专注毫秒数 */
  focusedMs: number;
  /** 未完成顶层任务里"没填估时"的条数 */
  unestimatedCount: number;
  /** 未完成顶层任务的条数（供调用方判断空态，不直接展示） */
  openCount: number;
}

/** 估时兜底：只接受正有限数，其余按 0 计（与 Lib/task 的 clamp 同口径，这里只读不算） */
function safeMinutes(raw: unknown): number {
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.trunc(value);
}

/**
 * 算一天的预算。`focusSessions` 传**全量**记录即可 —— 内部按 `session.date` 过滤，
 * 调用方不必自己筛（筛错一天就会得到"已专注 0 分钟"这种假结论）。
 */
export function dayBudget(
  tasks: Task[],
  date: DateKey,
  focusSessions: FocusSession[],
): DayBudget {
  const empty: DayBudget = {
    estimatedMinutes: 0,
    focusedMs: 0,
    unestimatedCount: 0,
    openCount: 0,
  };
  if (!Array.isArray(tasks) || typeof date !== 'string' || !date) return empty;

  let estimatedMinutes = 0;
  let unestimatedCount = 0;
  let openCount = 0;

  for (const task of tasks) {
    if (!task || typeof task !== 'object') continue;
    if (task.date !== date) continue;
    // 已完成的、以及子任务（parentId 非空）都不进预算，理由见文件头
    if (task.done === true) continue;
    if (task.parentId) continue;
    openCount += 1;
    const minutes = safeMinutes(task.estimatedMinutes);
    if (minutes > 0) estimatedMinutes += minutes;
    else unestimatedCount += 1;
  }

  const scoped = Array.isArray(focusSessions)
    ? focusSessions.filter((session) => session && session.date === date)
    : [];

  return {
    estimatedMinutes,
    focusedMs: sumFocusMs(scoped),
    unestimatedCount,
    openCount,
  };
}

/**
 * 分钟数 → '2小时30分钟' / '45分钟' / '2小时'。
 *
 * 与 `formatFocusDuration` 的阅读体验保持一致（同一屏里两行数字不该是两种写法），
 * 但**不接受 0**：0 分钟的"预计"没有意义，调用方应当整段不渲染
 * （见 budgetSegments），这里返回空串把这件事明确表达出来。
 */
export function formatMinutesText(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  const total = Math.max(1, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest}分钟`;
  if (rest === 0) return `${hours}小时`;
  return `${hours}小时${rest}分钟`;
}

/**
 * 预算行要展示的片段（视图直接 `join(' · ')`）。
 *
 * 规则（用户的裁决）：
 * - 每一段**为 0 就整段不出现**（不写"预计 0分钟"，那是噪音）；
 * - 三段都为空 → 返回空数组 → 调用方整行不渲染，**不占位**；
 * - 「N 项未估时」只在 N > 0 时出现（与段规则同源，不必单独判）。
 */
export function budgetSegments(budget: DayBudget): string[] {
  const segments: string[] = [];
  if (!budget || typeof budget !== 'object') return segments;

  const estimated = formatMinutesText(budget.estimatedMinutes);
  if (estimated) segments.push(`${TEXT.budgetEstimatedPrefix} ${estimated}`);

  const focused = formatMinutesText(budget.focusedMs / 60000);
  if (focused) segments.push(`${TEXT.budgetFocusedPrefix} ${focused}`);

  if (Number.isFinite(budget.unestimatedCount) && budget.unestimatedCount > 0) {
    segments.push(`${budget.unestimatedCount} ${TEXT.budgetUnestimatedSuffix}`);
  }
  return segments;
}
