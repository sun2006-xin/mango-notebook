import { TEXT } from '../constants';
import { diffDays, isValidDateKey } from './date';
import type { DateKey, ExamGoal } from '../types';

/* ============================================================================
   目标倒计时（F2）—— 纯函数，零 React / 零 localStorage

   数据住在 `settings.goals`（不是新的持久化集合），所以本文件只做两件事：
   1. `sanitizeGoals`：把一坨来路不明的数组收敛成合法列表
      （storage.sanitizeSettings 与 reducer 的 SET_GOALS 共用它）；
   2. `nextGoal`：挑出"最近一个**未过期**的目标"并算出还剩几天。

   === 两条容易改坏的规则 ===
   ① `sanitizeGoals` **逐项丢弃**，绝不整条数组清空：
      一个手改坏的目标不该让用户其它目标一起消失（与 sanitizeCategories 同理）。
   ② `nextGoal` 的 `today` 必须来自 `todayKey(settings.dayStartHour)`（今日视图
      传下来的那个 `today`），**不能再读一次系统时钟**：日界设成 4 时，
      凌晨 1 点的"今天"还是前一天，两处口径不同会让横幅显示差一天。
   ========================================================================= */

/** 目标名上限（与标题同量级；再长横幅上会换行挤掉别的信息） */
export const GOAL_NAME_MAX = 40;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 目标列表兜底。
 *
 * - 非数组 → `[]`（老数据没有这个字段，这是最常见的一条）；
 * - 每一项要求：`id` 非空字符串、`name` 是字符串（trim + 截断到 40）、
 *   `date` 通过 `isValidDateKey`（'2026-02-30' 这类必须挡掉）；
 * - 非法项**只丢自己**，其它目标原样保留；
 * - 同 id 去重（保留先出现的那条）、按 `date` 升序（横幅/列表都按日期读）。
 */
export function sanitizeGoals(raw: unknown): ExamGoal[] {
  if (!Array.isArray(raw)) return [];
  const byId = new Map<string, ExamGoal>();

  for (const item of raw) {
    const rec = asRecord(item);
    if (!rec) continue;
    const id = typeof rec.id === 'string' ? rec.id.trim() : '';
    if (!id) continue;
    const name = typeof rec.name === 'string' ? rec.name.trim().slice(0, GOAL_NAME_MAX) : '';
    if (!name) continue;
    const date = typeof rec.date === 'string' && isValidDateKey(rec.date) ? rec.date : null;
    if (!date) continue;
    if (byId.has(id)) continue;
    byId.set(id, { id, name, date });
  }

  return [...byId.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** 一个目标的倒计时结果 */
export interface GoalCountdown {
  goal: ExamGoal;
  /** 还剩几天；`0` = 就是今天 */
  days: number;
}

/**
 * 最近一个**未过期**的目标（`date >= today` 里日期最小的那个）。
 *
 * - 全部过期 / 空数组 → `null`（调用方据此整行不渲染，不占位）；
 * - 同一天有多个目标 → 按 id 升序取第一（保证同样的输入必得同样的输出，
 *   否则每次渲染横幅可能换人，看起来像在闪）；
 * - `days` 用 `diffDays(goal.date, today)`：**下限是 today、上限是 goal.date**，
 *   所以结果恒 `>= 0`（参数顺序反了会得到负数天，横幅会显示"还有 -3 天"）。
 *
 * 入参一律当脏数据看：老版本载荷里 `goals` 可能是 undefined，
 * 手改过的 JSON 里 `date` 可能是 '2026-13-01' —— 一律跳过，绝不抛。
 */
export function nextGoal(goals: ExamGoal[] | null | undefined, today: DateKey): GoalCountdown | null {
  if (!Array.isArray(goals) || typeof today !== 'string' || !isValidDateKey(today)) return null;

  let best: GoalCountdown | null = null;
  for (const goal of goals) {
    if (!goal || typeof goal !== 'object') continue;
    if (typeof goal.date !== 'string' || !isValidDateKey(goal.date)) continue;
    // 已过期的目标不参与（"距昨天考完的试还有 -1 天"没有意义）
    if (goal.date < today) continue;

    const candidate: GoalCountdown = {
      goal: { id: goal.id, name: goal.name, date: goal.date },
      /**
       * ⚠️ 参数方向：`diffDays(a, b) = a - b`。
       * 这里要的是"还有几天"，所以是 `diffDays(目标日, 今天)`；
       * 写反会得到负数（横幅变成"还有 -3 天"），而类型不会报错。
       */
      days: diffDays(goal.date, today),
    };
    if (!best) {
      best = candidate;
      continue;
    }
    if (candidate.goal.date < best.goal.date) {
      best = candidate;
      continue;
    }
    // 同一天：按 id 字典序取较小者（稳定，不闪烁）
    if (candidate.goal.date === best.goal.date && candidate.goal.id < best.goal.id) best = candidate;
  }
  return best;
}

/**
 * 横幅上那一行字。
 *
 * - `null`（没有未过期目标）→ 空串 → 调用方整行不渲染（不占位）；
 * - `days === 0` → `{name} 就是今天`（"还有 0 天"是机器语言）；
 * - 其余 → `距 {name} 还有 {N} 天`。
 *
 * 文案全部来自 constants.TEXT（组件里不写字面量中文，便于统一改词）。
 */
export function formatGoalCountdown(countdown: GoalCountdown | null): string {
  if (!countdown || !countdown.goal || typeof countdown.goal.name !== 'string') return '';
  const days = Number.isFinite(countdown.days) ? Math.max(0, Math.trunc(countdown.days)) : 0;
  if (days === 0) return `${countdown.goal.name} ${TEXT.goalTodaySuffix}`;
  return `${TEXT.goalCountdownPrefix} ${countdown.goal.name} ${TEXT.goalCountdownMiddle} ${days} ${TEXT.goalCountdownSuffix}`;
}

/**
 * 按剩余天数给一句"今天该怎么用力"的提示（F1 倒计时联动首页）。
 *
 * 刻意**不给具体任务条数**：应用并不知道用户今天有多少时间，
 * 编一个"今天建议完成 5 条"只会变成新的焦虑源。
 * 它只做阶段提醒 —— 越靠近考试，越该把注意力放在错题和薄弱章节上。
 */
export function goalPhaseHint(days: number): string {
  if (!Number.isFinite(days)) return '';
  const d = Math.max(0, Math.trunc(days));
  if (d === 0) return '就是今天，按自己的节奏来';
  if (d <= 7) return '冲刺期 · 优先处理错题与薄弱章节';
  if (d <= 30) return '收尾期 · 保持每日清单的节奏';
  return '打基础期 · 每天推进一点就够';
}
