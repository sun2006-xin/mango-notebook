import { SLEEP_LOG_KEEP_DAYS } from '../constants';
import { sameFields } from './equal';
import type { DateKey, SleepEntry, TimeKey } from '../types';

/* ============================================================================
   作息打卡（F5）—— 清洗与格式化

   独立成叶子模块的理由：`sanitizeSettings` 与 reducer 都要用，
   放在 storage 里会让 reducer 反向依赖 storage（本项目一直避免这种环）。
   ========================================================================= */

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isTimeKey(value: unknown): value is TimeKey {
  return typeof value === 'string' && TIME_RE.test(value);
}

function isDateKey(value: unknown): value is DateKey {
  return typeof value === 'string' && DATE_RE.test(value);
}

/**
 * 清洗作息数组。
 *
 * 规则（与 sanitizeGoals 同款思路）：
 * ① 非数组 → []；
 * ② 非法项**只丢自己**，不牵连整份数据；
 * ③ 同日期去重（保留先出现的，避免同步合并后出现两条）；
 * ④ 按日期倒序、只留最近 SLEEP_LOG_KEEP_DAYS 条 —— 载荷不会无限长大。
 */
export function sanitizeSleepLog(raw: unknown): SleepEntry[] {
  if (!Array.isArray(raw)) return [];
  const byDate = new Map<DateKey, SleepEntry>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (!isDateKey(rec.date)) continue;
    if (byDate.has(rec.date)) continue;
    const wakeAt = isTimeKey(rec.wakeAt) ? rec.wakeAt : null;
    const sleepAt = isTimeKey(rec.sleepAt) ? rec.sleepAt : null;
    // 两项都空的记录没有信息量，别占位置
    if (!wakeAt && !sleepAt) continue;
    byDate.set(rec.date, { date: rec.date, wakeAt, sleepAt });
  }
  return [...byDate.values()]
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, SLEEP_LOG_KEEP_DAYS);
}

/**
 * 两份作息流水合并（多设备同步用）。
 *
 * ⚠️ 它必须进 settings 合并的并集清单，不能跟着 `...base` 整包走。
 * 曾经漏了这一项，症状是：**手机上记的起床/睡觉时间，电脑同步一次就没了** ——
 * 电脑那份 settings 的 savedAt 更新 → `base` 取电脑 → 手机那条凭空消失，
 * 还会被推上云端，手机下次同步也找不回来（habitChecks 早就是并集待遇，
 * 两条同级流水口径不一致就是 bug）。
 *
 * 合并口径：**按日期取并集，同一天的两个字段各自取先有值的一方**。
 * - 按日期：两边的记录互不覆盖，对方那天有、这边没有就补过来；
 * - 字段级：`起床` 和 `睡觉` 是**两个独立的动作**，常在两台设备上分别记
 *   （手机记起床、电脑记睡觉）。整条覆盖会让另一半丢掉，所以字段各自补空。
 * - 同一字段两边都有值 → 取 `base`（savedAt 较新的一方）。作息没有
 *   条目级时间戳，这是能拿到的最好判据，且严格不劣于"整包覆盖"。
 * - 结果是**未排序**的：调用方（sanitizeSettings）会再排一次序 + 截断，
 *   这里不重复做那件事。
 */
export function mergeSleepLog(a: unknown, b: unknown): SleepEntry[] {
  const left = Array.isArray(a) ? sanitizeSleepLog(a) : [];
  const right = Array.isArray(b) ? sanitizeSleepLog(b) : [];
  if (left.length === 0) return right;
  if (right.length === 0) return left;

  const byDate = new Map<DateKey, SleepEntry>();
  for (const entry of left) byDate.set(entry.date, { ...entry });
  for (const entry of right) {
    const prev = byDate.get(entry.date);
    if (!prev) {
      byDate.set(entry.date, { ...entry });
      continue;
    }
    byDate.set(entry.date, {
      date: entry.date,
      wakeAt: prev.wakeAt ?? entry.wakeAt,
      sleepAt: prev.sleepAt ?? entry.sleepAt,
    });
  }
  return [...byDate.values()];
}

/** 写入/更新一天的作息（同日期覆盖单项，另一项保持） */
export function upsertSleepLog(
  log: SleepEntry[],
  entry: { date: DateKey; wakeAt?: TimeKey | null; sleepAt?: TimeKey | null },
): SleepEntry[] {
  const existing = log.find((item) => item.date === entry.date);
  const next: SleepEntry = {
    date: entry.date,
    wakeAt: entry.wakeAt !== undefined ? entry.wakeAt : (existing?.wakeAt ?? null),
    sleepAt: entry.sleepAt !== undefined ? entry.sleepAt : (existing?.sleepAt ?? null),
  };
  const rest = log.filter((item) => item.date !== entry.date);
  return sanitizeSleepLog([...rest, next]);
}

/**
 * 某一项是否真的改变了（用于 action 幂等：没变就别写盘、别触发云推送）。
 *
 * 按结构比而不是手抄三个字段：`SleepEntry` 加字段（比如"中间醒了几次"）时，
 * 漏写清单的后果是**那个字段写进去也判"没变"** → 不落盘、同步不出去，
 * 而界面上看起来明明改了（和 `sameHabits` 漏 `autoTask` 是同一类事故）。
 */
export function sameSleepEntry(a: SleepEntry | undefined, b: SleepEntry | undefined): boolean {
  return sameFields(a, b);
}

/** 现在几点的 'HH:mm'（本地时区）。打卡是用户主动点，取"点击那一刻"是正确的 */
export function nowTimeKey(now: Date = new Date()): TimeKey {
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

/**
 * 「昨晚 02:10 睡 · 今早 11:05 起」这样的一句摘要。
 *
 * 刻意只陈述事实，不评价（不说"太晚了"）—— 用户自己看得到。
 */
export function formatSleepSummary(entry: SleepEntry | null | undefined): string {
  if (!entry) return '';
  const parts: string[] = [];
  if (entry.sleepAt) parts.push(`睡 ${entry.sleepAt}`);
  if (entry.wakeAt) parts.push(`起 ${entry.wakeAt}`);
  return parts.join(' · ');
}
