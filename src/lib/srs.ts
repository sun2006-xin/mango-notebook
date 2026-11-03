import {
  MATURE_INTERVAL_DAYS,
  MAX_INTERVAL_DAYS,
  MAX_REPS,
  NEW_CARD_DAILY_CAP,
} from '../constants';
import { addDays, dateKey, isValidDateKey } from './date';
import { isNoteDeleted } from './note';
import type { DateKey, Note, NoteSr } from '../types';

/* ============================================================================
   间隔重复（SRS）引擎 —— 纯函数，零 React / 零 localStorage

   为什么自己写而不是引 SM-2 库：
   1. 只有三档（忘了 / 模糊 / 记住），SM-2 的 ease factor 对备考场景过重；
   2. 全部逻辑必须可单测、可回放（同样的输入必得同样的输出）；
   3. 复习进度要跟着 note 一起走云同步，不能引入"另一份数据库"。

   === 两条容易被后人改坏的设计（改之前先读这里）===
   ① `ivl === 0` 表示"已入队但还没学过的新卡"。新卡走**固定阶梯**
      （again→1 / hard→2 / good→3），**绝不能对新卡用乘数**：
      prevIvl = 0 时 `0 × 1.5 = 0`、`0 × 2.2 = 0`，都会被 max(1, …) 拉平成 1 天，
      于是 hard 和 good 的结果一模一样 —— 正反馈在起步阶段就没了。
   ② `again → ivl = 1, due = today + 1`，所以**同一张卡不会在同一次会话里复现**，
      因此**不需要** Anki 的 learning steps（1min / 10min 那种秒级重排）。
      硬加回来的话，会和"队列冻结 id 列表"的设计打架：会话内的 current 会反复
      跳回上一张，用户会以为界面坏了。
   ========================================================================= */

/** 三档评级：忘了 / 模糊 / 记住 */
export type ReviewRating = 'again' | 'hard' | 'good';

/** 数值收敛：非法一律 null（不抛） */
function toFiniteOrNull(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * 把一坨来路不明的数据收敛成合法的 `NoteSr`；任一字段不过关就整体返回 null。
 *
 * 为什么要这么严：sr 会经云同步从别的设备过来（老版本 / 手改过的 JSON 都有）。
 * 一个 `due: '2026-02-30'` 会让"今天该复习哪几张"算错，而 `ivl: -1` 会让
 * 间隔越学越短。
 *
 * ⚠️ 返回 null 的语义是"**这条没有有效的复习进度**"，调用方**只能丢掉 sr**，
 * 绝不能丢掉整条 note —— 复习进度可以重建，笔记正文不能重建。
 */
export function sanitizeSr(raw: unknown): NoteSr | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;

  const due = typeof rec.due === 'string' ? rec.due : '';
  if (!isValidDateKey(due)) return null;

  const ivlRaw = toFiniteOrNull(rec.ivl);
  const repsRaw = toFiniteOrNull(rec.reps);
  if (ivlRaw === null || repsRaw === null) return null;

  /**
   * `last`（最近一次评级的 ISO 时间）是**可选**字段：
   * - 可解析的字符串 → 原样保留（用于「本周复习 N 张」的统计）；
   * - 其它（123 / 'not-a-date' / 缺失）→ **只丢这一个字段**。
   *
   * ⚠️ 绝不能因为 last 坏了就 return null：那等于把整条 sr 丢掉，
   * 而 sr 一丢，"这张卡"就变回普通记事 —— 复习进度可以重排，
   * 但用户看到的"我明明加过复习"会凭空消失。更不能因此丢 note。
   */
  const lastRaw = rec.last;
  const last =
    typeof lastRaw === 'string' && Number.isFinite(Date.parse(lastRaw)) ? lastRaw : null;

  return {
    due,
    ivl: clampInt(ivlRaw, 0, MAX_INTERVAL_DAYS),
    reps: clampInt(repsRaw, 0, MAX_REPS),
    ...(last ? { last } : {}),
  };
}

/** 内部取 sr（顺带做一次运行时校验；note.sr 的类型是可信的，但它来自磁盘） */
function srOf(note: Note): NoteSr | null {
  if (!note || typeof note !== 'object') return null;
  return sanitizeSr(note.sr);
}

/**
 * 是不是一张复习卡片。
 *
 * 判据是"**有没有合法的 sr 键**"，不是别的字段：
 * - 没有 sr = 普通记事，完全不进复习队列（这是"退出复习"的表达方式）；
 * - 软删除的空壳（content 为空）不算卡片 —— 用户已经把它删了。
 */
export function isCard(note: Note): boolean {
  if (!note || typeof note !== 'object') return false;
  if (isNoteDeleted(note)) return false;
  return srOf(note) !== null;
}

/** 已入队但还没学过（`ivl === 0`） */
export function isNewCard(note: Note): boolean {
  if (!isCard(note)) return false;
  return srOf(note)?.ivl === 0;
}

/**
 * 今天该复习的**老卡**。
 *
 * ⚠️ **不包含新卡**：新卡由 `NEW_CARD_DAILY_CAP` 单独限流（见 dueCount）。
 * 把新卡算进 isDue 的话，当天刚入队的卡会既被算成"逾期"又被算成"新卡"，
 * 横幅上的数字直接翻倍。
 */
export function isDue(note: Note, today: DateKey): boolean {
  if (!isCard(note)) return false;
  const sr = srOf(note);
  if (!sr || sr.ivl === 0) return false;
  return sr.due <= today;
}

/**
 * 今天的待复习张数 = 逾期/到期老卡（**不设上限**）+ 新卡（限流）。
 *
 * 老卡为什么不能截断：截断会让债务滚雪球 —— 今天差的 20 张不会消失，
 * 明天它们还在，后天还在，用户再也追不上。新卡则相反：一次塞 200 张新卡
 * 只会让人直接放弃，所以按天限流。
 */
export function dueCount(notes: Note[], today: DateKey): number {
  if (!Array.isArray(notes)) return 0;
  let backlog = 0;
  let fresh = 0;
  for (const note of notes) {
    if (!isCard(note)) continue;
    if (isNewCard(note)) fresh += 1;
    else if (isDue(note, today)) backlog += 1;
  }
  return backlog + Math.min(fresh, NEW_CARD_DAILY_CAP);
}

/**
 * 构建本次复习队列：**老卡在前**（按 due 升序），新卡在后（按入队日升序，截断到上限）。
 *
 * 老卡优先是刻意的：逾期的卡每多放一天，遗忘曲线就再掉一截；
 * 新卡晚一天开始没有损失。
 *
 * ⚠️ 调用方（ReviewView）必须把这批 **id 冻结**成数组再用，不能用
 * `useMemo(() => buildReviewQueue(notes))` —— 评级会改 notes，一改队列就重算，
 * 当前这张会从队列里"自己跳走"。
 */
const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * `sr.last`（最近一次评级的 ISO 时间）归到**日界换算后**的那一天。
 *
 * 必须走日界：凌晨 1 点学的卡，在"日界 = 4 点"的设置下算前一天 ——
 * 与"今天"的口径保持一致，否则刚过零点就会把额度当成新的一天重新发一遍。
 */
function lastKeyOf(note: Note, dayStartHour: number): DateKey | null {
  const last = srOf(note)?.last;
  if (typeof last !== 'string' || !last) return null;
  const date = new Date(last);
  if (Number.isNaN(date.getTime())) return null;
  date.setHours(date.getHours() - dayStartHour);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * 今天**已经学过几张新卡**。
 *
 * 为什么需要它：`dailyNewCardLimit` 本来应该"每天总共放这么多张新卡"，
 * 但原实现是"每次进复习页都放一批" —— 你今天进出三次就会看到三批新卡，
 * 额度形同虚设（Anki 是真按当天已学数递减的）。
 *
 * 判据：`reps === 1` 说明这张卡**只被评过一次**（新卡刚学完，ivl 已 > 0），
 * 而老卡复习后 reps 必然 ≥ 2。再用 `last` 归日判断是不是今天。
 */
export function countNewCardsLearnedToday(
  notes: Note[],
  today: DateKey,
  dayStartHour = 0,
): number {
  if (!Array.isArray(notes)) return 0;
  const hour = Number.isFinite(dayStartHour) ? Math.max(0, Math.trunc(dayStartHour)) : 0;
  let count = 0;
  for (const note of notes) {
    if (!isCard(note)) continue;
    const sr = srOf(note);
    if (!sr || sr.reps !== 1) continue;
    if (lastKeyOf(note, hour) === today) count += 1;
  }
  return count;
}

export function buildReviewQueue(
  notes: Note[],
  today: DateKey,
  /** 每日新卡上限（F9）：不传 = 用内置的 NEW_CARD_DAILY_CAP；0 = 不限制 */
  newCardLimit?: number,
  /** 日界（0–6）：用来判断"今天已学的新卡"属于哪一天 */
  dayStartHour = 0,
): Note[] {
  if (!Array.isArray(notes)) return [];
  const backlog: Note[] = [];
  const fresh: Note[] = [];

  for (const note of notes) {
    if (!isCard(note)) continue;
    if (isNewCard(note)) fresh.push(note);
    else if (isDue(note, today)) backlog.push(note);
  }

  const dueOf = (note: Note): DateKey => srOf(note)?.due ?? today;
  backlog.sort((a, b) => (dueOf(a) < dueOf(b) ? -1 : dueOf(a) > dueOf(b) ? 1 : 0));
  fresh.sort((a, b) => (dueOf(a) < dueOf(b) ? -1 : dueOf(a) > dueOf(b) ? 1 : 0));

  const cap = Number.isFinite(newCardLimit)
    ? Math.max(0, Math.trunc(newCardLimit as number))
    : NEW_CARD_DAILY_CAP;
  /**
   * 扣掉今天**已经学过**的新卡：额度是"每天总共几张"，不是"每次进几张"。
   * 不扣的话，进出三次复习页就会放三批新卡，额度形同虚设。
   */
  const learnedToday = cap === 0 ? 0 : countNewCardsLearnedToday(notes, today, dayStartHour);
  const remaining = cap === 0 ? Number.POSITIVE_INFINITY : Math.max(0, cap - learnedToday);
  // 0 = 不限制（用户明确选了"不限"），否则按上限截断
  return [
    ...backlog,
    ...(remaining === Number.POSITIVE_INFINITY ? fresh : fresh.slice(0, remaining)),
  ];
}

/** 新卡的固定阶梯：再次见到它的间隔（天）。**不给新卡用乘数**，理由见文件头 ① */
function newCardInterval(rating: ReviewRating): number {
  if (rating === 'again') return 1;
  if (rating === 'hard') return 2;
  return 3;
}

/** 老卡的乘数：忘了回到 1 天，模糊 ×1.5，记住 ×2.2 */
function matureInterval(prevIvl: number, rating: ReviewRating): number {
  if (rating === 'again') return 1;
  if (rating === 'hard') return Math.max(1, Math.round(prevIvl * 1.5));
  return Math.max(1, Math.round(prevIvl * 2.2));
}

/**
 * 评级一次，返回**新的 note**（不可变）。
 *
 * ⚠️ `updatedAt` 必须在这里强制写成 `now`，**不能让调用方补**：
 * `sameNoteSet`（云同步的"稳态"判定）只比 `id + updatedAt`，它对 sr 完全不可见。
 * 评级若不刷新 updatedAt，会同时踩两个坑：
 *   ① 云同步永远判定"两边一样"，复习进度**永远传不到另一台设备**；
 *   ② `mergeNotes` 按 updatedAt 取新，对端的旧 sr 会**覆盖**刚评的这张卡。
 * 这两条都不报错、界面也看不出来，只能靠这里把时间戳写死。
 *
 * again **不重置 reps**：reps 的语义是"这张卡被复习过多少次"，
 * 是给用户看的投入量，不是记忆强度的估计。
 */
export function grade(note: Note, rating: ReviewRating, today: DateKey, now: string): Note {
  const prev = srOf(note) ?? { due: today, ivl: 0, reps: 0 };
  const nextIvl =
    prev.ivl === 0 ? newCardInterval(rating) : matureInterval(prev.ivl, rating);
  const ivl = clampInt(nextIvl, 1, MAX_INTERVAL_DAYS);
  const reps = Math.min(MAX_REPS, prev.reps + 1);

  return {
    ...note,
    sr: { due: addDays(today, ivl), ivl, reps, last: now },
    updatedAt: now,
  };
}

/**
 * 加入复习（显式开关）。已经是卡片时原样返回**同一个引用** —— 不做无谓的写盘。
 *
 * 新卡的 `due` 记为入队当天（它同时也是"新卡按入队日升序"的排序键）。
 */
export function enroll(note: Note, today: DateKey, now: string): Note {
  if (srOf(note)) return note;
  return { ...note, sr: { due: today, ivl: 0, reps: 0 }, updatedAt: now };
}

/**
 * 退出复习：**解构删掉 sr 这个键**。
 *
 * ⚠️ 不能写 `sr: undefined`：那样 note 上仍然存在 `sr` 键
 * （`Object.keys` 能看见、`JSON.stringify` 会省略但 `'sr' in note` 为真），
 * 而"有没有 sr 键"正是"它是不是卡片"的判据。留着键等于"退出了但又被当成卡片"。
 * 同理也不能把 ivl 归零来"退出" —— 那是新卡，不是退出。
 */
export function unenroll(note: Note, now: string): Note {
  const { sr, ...rest } = note;
  // 显式引用一次，避免 lint 认为 sr 未被使用（同时也说明这里确实是在"删字段"）
  void sr;
  return { ...rest, updatedAt: now };
}

/** 队列健康度：卡片总数 / 已排期（学过，ivl > 0）/ 成熟卡（ivl ≥ 7） */
export function reviewStats(notes: Note[]): { total: number; scheduled: number; mature: number } {
  if (!Array.isArray(notes)) return { total: 0, scheduled: 0, mature: 0 };
  let total = 0;
  let scheduled = 0;
  let mature = 0;
  for (const note of notes) {
    if (!isCard(note)) continue;
    total += 1;
    const sr = srOf(note);
    if (!sr) continue;
    if (sr.ivl > 0) scheduled += 1;
    if (sr.ivl >= MATURE_INTERVAL_DAYS) mature += 1;
  }
  return { total, scheduled, mature };
}

/**
 * 区间 `[start, end]`（含端点）内**复习过几张卡** —— 周报的「本周复习 N 张」。
 *
 * 口径与三条纪律：
 * 1. **只认 `sr.last`**：它是"最近一次评级"的时间。不用 `due` / `ivl` 反推 ——
 *    那两个是未来信息，同一张 30 天间隔的卡不管昨天学还是 20 天前学，
 *    due 都落在同一天，反推不出"什么时候学的"。
 * 2. **按本地日期归日**：`last` 是 ISO（可能带时区），这里用 `Date` 解析后
 *    取**本地日期**再和 DateKey 比 —— 与全工程 rest 的归日口径一致
 *    （禁止 `toISOString().slice(0,10)`，那会把本地 23:30 算成次日）。
 * 3. **排除软删除空壳**：`isCard` 已经挡掉 content 为空的墓碑条目 ——
 *    用户删掉的卡不该再被算成"复习过"。
 *
 * 一张卡在一个区间里最多算 1 张（统计的是卡片数，不是评级次数）：
 * 同一天里连评 5 次也只算 1 张，否则数字会随"点错重评"膨胀。
 *
 * 入参一律当脏数据看：区间非法 / notes 不是数组 / last 解析不出来 → 一律不抛。
 */
export function reviewCountInRange(notes: Note[], start: DateKey, end: DateKey): number {
  if (!Array.isArray(notes)) return 0;
  if (!isValidDateKey(start) || !isValidDateKey(end) || start > end) return 0;

  let count = 0;
  for (const note of notes) {
    // isCard 同时挡掉"没有 sr 的普通记事"与"已软删除的空壳"
    if (!isCard(note)) continue;
    const last = srOf(note)?.last;
    if (!last) continue;
    const parsed = Date.parse(String(last));
    if (!Number.isFinite(parsed)) continue;
    const key = dateKey(new Date(parsed));
    if (key >= start && key <= end) count += 1;
  }
  return count;
}
