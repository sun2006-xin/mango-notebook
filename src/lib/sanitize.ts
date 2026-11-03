import {
  DEFAULT_BREAK_MINUTES,
  DEFAULT_CATEGORIES,
  DEFAULT_FOCUS_MINUTES,
  createDefaultSettings,
  DIARY_MAX,
  NOTE_MAX,
  TIME_PATTERN,
  TITLE_MAX,
  TOMBSTONE_KEEP_DAYS,
} from '../constants';
import { isValidDateKey, nowIso, todayKey } from './date';
import { sanitizeFieldAt } from './fieldClock';
import { FOCUS_GOAL_MAX_MINUTES } from './focus';
import { sanitizeGoals } from './goal';
import { normalizeHabitName, sanitizeHabitTaskLog } from './habits';
import { sanitizeSleepLog } from './sleep';
import { sanitizeSr } from './srs';
import { clampEstimateMinutes } from './task';
import { sanitizeWeekPlanTemplate } from './weekPlan';
import { sanitizeWeeklyReportLog } from './weekly';
import type {
  Category,
  DateKey,
  DiaryEntry,
  FilterMode,
  FocusSession,
  Habit,
  HabitCheck,
  Note,
  NoteRemind,
  PersistedPayload,
  Priority,
  Repeat,
  Settings,
  Task,
  ThemeMode,
  TaskTombstone,
  ViewId,
} from '../types';

/** 把 unknown 收敛成对象；不是对象（数组 / null / 原始值）返回 null */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

const THEMES: ThemeMode[] = ['light', 'dark', 'system'];

/* ============================================================================
   字段级清洗（schema 层）
   ----------------------------------------------------------------------------
   从 storage.ts 抽出来：这些函数是**纯函数**（输入脏数据 → 输出合法数据），
   不碰 localStorage、不碰 React、不认识"存盘"这件事。
   放在一起的好处：加字段时只需要看这一个文件；测试也不用先搭存储后端。

   ⚠️ 它们是**逐字段重建**（不是 `...rec` 展开）：新增字段必须显式写进来，
   否则每次冷启动 / 云同步 / 导入备份都会静默变回默认值。
   ========================================================================= */

/**
 * 允许被持久化的视图。
 *
 * ⚠️ `'trash'` 故意**不在**里面 —— 回收站是"出了问题才去"的页面，
 * 记住它会让用户下次冷启动直接落在回收站，看起来像数据全丢了。
 * 不在白名单里 → 读到 'trash' 时回落默认视图，等于自带一层保险。
 */
const VIEWS: ViewId[] = ['today', 'week', 'calendar', 'focus', 'diary', 'notes', 'settings'];
const FILTERS: FilterMode[] = ['all', 'open', 'done'];
const PRIORITIES: Priority[] = ['high', 'medium', 'low'];
/** 老任务没有 repeat 字段 → 一律回落 'none'（一次性） */
const REPEATS: Repeat[] = ['none', 'daily', 'weekly', 'monthly'];

function sanitizeCategories(raw: unknown): Category[] {
  if (!Array.isArray(raw)) return DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  const list: Category[] = [];
  for (const item of raw) {
    const rec = asRecord(item);
    if (!rec) continue;
    const id = typeof rec.id === 'string' ? rec.id.trim() : '';
    const name = typeof rec.name === 'string' ? rec.name.trim() : '';
    if (!id || !name) continue;
    if (list.some((c) => c.id === id || c.name === name)) continue;
    list.push({ id, name });
  }
  // 空数组会导致抽屉无分类可选，必须回落预设
  return list.length ? list : DEFAULT_CATEGORIES.map((c) => ({ ...c }));
}

/** 字段级兜底：任意非法字段回落默认值 */
export function sanitizeSettings(raw: unknown): Settings {
  const rec = asRecord(raw) ?? {};
  const defaults = createDefaultSettings(todayKey());
  /**
   * 习惯先算出来：打卡流水要拿它过滤孤儿（指向不存在的习惯的记录）。
   * 顺序不能调换，所以提成局部变量而不是在对象字面量里现算。
   */
  const habitsList = sanitizeHabits(rec.habits);

  const theme = THEMES.includes(rec.theme as ThemeMode) ? (rec.theme as ThemeMode) : defaults.theme;
  const defaultView = VIEWS.includes(rec.defaultView as ViewId)
    ? (rec.defaultView as ViewId)
    : defaults.defaultView;
  const lastView = VIEWS.includes(rec.lastView as ViewId) ? (rec.lastView as ViewId) : defaults.lastView;
  const weekStart = rec.weekStart === 0 || rec.weekStart === 1 ? rec.weekStart : defaults.weekStart;
  const filterMode = FILTERS.includes(rec.filterMode as FilterMode)
    ? (rec.filterMode as FilterMode)
    : defaults.filterMode;
  const filterCategory =
    typeof rec.filterCategory === 'string' && rec.filterCategory.trim()
      ? rec.filterCategory.trim()
      : null;
  const lastSelectedDate =
    typeof rec.lastSelectedDate === 'string' && isValidDateKey(rec.lastSelectedDate)
      ? (rec.lastSelectedDate as DateKey)
      : defaults.lastSelectedDate;

  return {
    schemaVersion: 1,
    theme,
    defaultView,
    weekStart: weekStart as 0 | 1,
    categories: sanitizeCategories(rec.categories),
    lastSelectedDate,
    lastView,
    filterMode,
    filterCategory,
    doneCollapsed: typeof rec.doneCollapsed === 'boolean' ? rec.doneCollapsed : defaults.doneCollapsed,
    remindEnabled: typeof rec.remindEnabled === 'boolean' ? rec.remindEnabled : defaults.remindEnabled,
    /**
     * ⚠️ 本函数是**逐字段重建**（不是 `...rec` 展开）：新增字段必须显式补在这里，
     * 否则每次冷启动 / 云同步 / 导入备份都会静默变回默认值。
     */
    strictFocus: typeof rec.strictFocus === 'boolean' ? rec.strictFocus : defaults.strictFocus,
    /** 番茄自动续接：只认 boolean，其余回落默认（关） */
    autoContinue: typeof rec.autoContinue === 'boolean' ? rec.autoContinue : defaults.autoContinue,
    dailyNewCardLimit: (() => {
      const raw = Number(rec.dailyNewCardLimit);
      if (!Number.isFinite(raw)) return defaults.dailyNewCardLimit;
      // 0 = 不限制；上限 200 防脏数据把队列撑爆
      return Math.min(200, Math.max(0, Math.trunc(raw)));
    })(),
    dayStartHour: sanitizeDayStartHour(rec.dayStartHour),
    /**
     * 每日专注目标（分钟）。0 = 不设目标；上限 24 小时。
     * 同样必须显式写在这里 —— 漏了 = 每次冷启动都变回"没设目标"。
     */
    dailyFocusGoalMinutes: (() => {
      const raw = Number(rec.dailyFocusGoalMinutes);
      if (!Number.isFinite(raw)) return defaults.dailyFocusGoalMinutes;
      return Math.min(FOCUS_GOAL_MAX_MINUTES, Math.max(0, Math.trunc(raw)));
    })(),
    focusMinutes: sanitizeMinutes(rec.focusMinutes, DEFAULT_FOCUS_MINUTES),
    breakMinutes: sanitizeMinutes(rec.breakMinutes, DEFAULT_BREAK_MINUTES),
    /**
     * 目标倒计时。**必须显式写在这里**：本函数是逐字段重建对象
     * （不是 `...rec` 展开），漏一行 = 每次冷启动 / 每次云同步都把用户
     * 加的目标全部丢掉 —— 编译不报错，只在"我的倒计时怎么没了"时暴露。
     *
     * 兜底逻辑在 lib/goal.ts::sanitizeGoals（非数组 → []、非法项只丢自己、
     * 按日期升序去重）。`goals` 住在 settings 内部，所以**不需要**动
     * SCHEMA_VERSION / MIGRATIONS / PersistedPayload。
     */
    goals: sanitizeGoals(rec.goals),
    /** 作息打卡（F5）：同样必须显式写在这里，否则冷启动即清空 */
    sleepLog: sanitizeSleepLog(rec.sleepLog),
    /**
     * 习惯打卡（F12）。顺序有依赖：打卡要先知道有哪些习惯（孤儿打卡要丢掉），
     * 所以 habits 必须先算完 —— 这两个字段的书写顺序不能调换。
     */
    habits: habitsList,
    habitChecks: sanitizeHabitChecks(rec.habitChecks, habitsList),
    /**
     * 「习惯 → 今日任务」的生成流水。**必须显式写在这里**（本函数逐字段重建，
     * 漏一行 = 每次冷启动都清空 → 同一个习惯每天被派好几次任务）。
     * 依赖 habitsList（孤儿记录要丢掉），所以排在 habits 之后。
     */
    habitTaskLog: sanitizeHabitTaskLog(rec.habitTaskLog, habitsList),
    /** 收尾卡已读标记：只认合法日期，其余回落 null（= 从没看过，会再回顾一次） */
    lastRecapSeen:
      typeof rec.lastRecapSeen === 'string' && isValidDateKey(rec.lastRecapSeen)
        ? (rec.lastRecapSeen as DateKey)
        : null,
    focusPrunedBefore:
      typeof rec.focusPrunedBefore === 'string' && isValidDateKey(rec.focusPrunedBefore)
        ? (rec.focusPrunedBefore as DateKey)
        : null,
    weekPlanTemplate: sanitizeWeekPlanTemplate(rec.weekPlanTemplate),
    /**
     * 周报自动生成。**缺省视为开**（`!== false`）——
     * 老数据没有这个字段，而"默认开"是功能本身的设计口径（见 types.ts）。
     * 写成 `=== true` 会把所有老用户的这个功能静默关掉。
     */
    weeklyAutoReport: rec.weeklyAutoReport !== false,
    /** 已自动生成周报的周（只增流水）；漏了会每天重写一次上一周的周报 */
    weeklyReportLog: sanitizeWeeklyReportLog(rec.weeklyReportLog),
  };
}

/**
 * 日界：允许 0–6 点，超出一律退回 0（午夜翻页）。
 * 为什么只放到 6 点：再晚就会把正常清晨起床的人算进前一天，得不偿失。
 */
function sanitizeDayStartHour(raw: unknown): number {
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) return 0;
  const hour = Math.trunc(value);
  return hour >= 0 && hour <= 6 ? hour : 0;
}

/**
 * 手动排序位：非负整数，其余一律 0。
 * `0` 不是"排在第一位"，而是"**没手动排过**，走自动排序"（见 Task.order）。
 */
function sanitizeOrder(raw: unknown): number {
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) return 0;
  const order = Math.trunc(value);
  return order > 0 ? order : 0;
}

/** 习惯配置上限：再多今日页就变成第二份待办清单了 */
const HABIT_KEEP_MAX = 40;
/** 打卡流水上限（约 8 个习惯 × 500 天）。超出丢最旧的，避免 localStorage 被慢慢撑满 */
const HABIT_CHECK_KEEP_MAX = 4000;

/**
 * 习惯配置：逐条收敛 + 按 id 去重。
 *
 * 被丢掉的情况只有三种：不是对象、没有 id、名字为空。
 * **归档的习惯要保留** —— 它们是历史打卡的归属，删了打卡就成了孤儿。
 */
export function sanitizeHabits(raw: unknown): Habit[] {
  if (!Array.isArray(raw)) return [];
  const now = nowIso();
  const seen = new Set<string>();
  const list: Habit[] = [];
  for (const item of raw) {
    const rec = asRecord(item);
    if (!rec) continue;
    const id = typeof rec.id === 'string' && rec.id.trim() ? rec.id.trim() : '';
    const name = normalizeHabitName(rec.name);
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    list.push({
      id,
      name,
      createdAt: typeof rec.createdAt === 'string' && rec.createdAt ? rec.createdAt : now,
      // 归档标记只认字符串；'' / null / 其它一律视为在用
      archivedAt: typeof rec.archivedAt === 'string' && rec.archivedAt ? rec.archivedAt : null,
      /**
       * 逐字段重建 → 漏一行就等于**每次冷启动都把这个开关关掉**（编译不报错）。
       * 保留原始值形态：只有明确的 true 才算开，省得存进 `'false'` 这种字符串。
       */
      ...(rec.autoTask === true ? { autoTask: true } : {}),
    });
    if (list.length >= HABIT_KEEP_MAX) break;
  }
  return list;
}

/**
 * 打卡流水：合法日期 + 习惯必须存在 + 同 key 去重，按日期升序，超量丢最旧。
 *
 * 「习惯必须存在」这一步是必须的：孤儿打卡不会被渲染，却会一直占着载荷体积；
 * 更糟的是它会跟着云同步在设备之间来回传，用户永远删不干净。
 */
export function sanitizeHabitChecks(raw: unknown, habits: Habit[]): HabitCheck[] {
  if (!Array.isArray(raw)) return [];
  const alive = new Set(habits.map((habit) => habit.id));
  const seen = new Set<string>();
  const list: HabitCheck[] = [];
  for (const item of raw) {
    const rec = asRecord(item);
    if (!rec) continue;
    const habitId = typeof rec.habitId === 'string' ? rec.habitId : '';
    const date = typeof rec.date === 'string' && isValidDateKey(rec.date) ? (rec.date as DateKey) : null;
    if (!habitId || !date || !alive.has(habitId)) continue;
    const key = `${habitId}|${date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ habitId, date });
  }
  list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  // 超量丢最旧的：新记录比老记录更值得留（连续天数靠最近的日子）
  return list.length > HABIT_CHECK_KEEP_MAX ? list.slice(list.length - HABIT_CHECK_KEEP_MAX) : list;
}

/** 分钟数：限制在 1–180，其余退回默认值 */
function sanitizeMinutes(raw: unknown, fallback: number): number {
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  const minutes = Math.trunc(value);
  return minutes >= 1 && minutes <= 180 ? minutes : fallback;
}

/** 逐条兜底：丢弃非对象项与空标题项，补齐 id / 时间戳 */
export function sanitizeTasks(raw: unknown): Task[] {
  if (!Array.isArray(raw)) return [];
  const fallbackDate = todayKey();
  const now = nowIso();
  const list: Task[] = [];

  for (const item of raw) {
    const rec = asRecord(item);
    if (!rec) continue;
    const title = typeof rec.title === 'string' ? rec.title.trim().slice(0, TITLE_MAX) : '';
    if (!title) continue;

    const id =
      typeof rec.id === 'string' && rec.id.trim()
        ? rec.id
        : `t_${Math.random().toString(36).slice(2, 10)}`;
    const date =
      typeof rec.date === 'string' && isValidDateKey(rec.date) ? (rec.date as DateKey) : fallbackDate;
    /**
     * 结束日（多天任务）。必须显式写在这里 —— 逐字段重建漏一行，
     * 每次冷启动都把多天任务**打回单天**，而且没有任何报错。
     * 早于开始日的一律清掉：留着会让 `taskCoversDate` 永不成立，任务直接消失。
     */
    const endDate =
      typeof rec.endDate === 'string' && isValidDateKey(rec.endDate) && rec.endDate > date
        ? (rec.endDate as DateKey)
        : null;
    const note = typeof rec.note === 'string' ? rec.note.slice(0, NOTE_MAX) : '';
    const time = typeof rec.time === 'string' && TIME_PATTERN.test(rec.time) ? rec.time : null;
    const repeat = REPEATS.includes(rec.repeat as Repeat) ? (rec.repeat as Repeat) : 'none';
    const priority = PRIORITIES.includes(rec.priority as Priority)
      ? (rec.priority as Priority)
      : 'medium';
    const category =
      typeof rec.category === 'string' && rec.category.trim()
        ? rec.category.trim()
        : (DEFAULT_CATEGORIES[0] as Category).name;
    const done = rec.done === true;
    const doneAt = done && typeof rec.doneAt === 'string' ? rec.doneAt : null;
    /**
     * 字段级时钟。**必须显式写在这里**（本函数逐字段重建对象）：
     * 漏掉它 = 每次冷启动 / 每次云同步都把时钟清空，
     * 云同步的字段级合并静默退化成"整条 updatedAt 新者胜"，
     * 两台设备改同一任务的不同字段照样丢一方 —— 而且完全不报错。
     * 收敛逻辑在 lib/fieldClock.ts::sanitizeFieldAt（脏数据丢弃）。
     */
    const fieldAt = sanitizeFieldAt(rec.fieldAt);

    list.push({
      id,
      title,
      note,
      date,
      endDate,
      time,
      repeat,
      priority,
      category,
      done,
      doneAt,
      createdAt: typeof rec.createdAt === 'string' && rec.createdAt ? rec.createdAt : now,
      updatedAt: typeof rec.updatedAt === 'string' && rec.updatedAt ? rec.updatedAt : now,
      /**
       * 预计用时（分钟）。**必须显式写在这里**：
       * 本函数是逐字段重建对象（不是 `...rec` 展开），漏一行就等于
       * 每次冷启动 / 每次云同步都把用户填的估时清零 —— 编译不报错，界面也看不出来。
       * 缺失 / NaN / 负数的收敛口径与 reducer 的 patch 完全一致（clampEstimateMinutes）。
       */
      estimatedMinutes: clampEstimateMinutes(rec.estimatedMinutes),
      /**
       * parentId 先占位，真正的值在下面统一回填。
       * 原因：要校验"父任务是否存在"，而存在性得等全部任务都扫完才知道 ——
       * 父任务可能排在子任务后面。校验不过就退化成顶层任务，
       * 绝不让一行任务因为指向空父级而被渲染层吞掉。
       */
      parentId: typeof rec.parentId === 'string' && rec.parentId ? rec.parentId : null,
      /**
       * 手动排序位（拖拽排序）。**必须显式写在这里**，理由同 estimatedMinutes：
       * 本函数是逐字段重建，漏一行 = 每次冷启动 / 每次云同步都把用户排好的顺序清零。
       *
       * 收敛口径：非有限数 / 负数 → 0（= 未手动排过，走自动排序）。
       * 负数必须归 0 而不是保留 —— 一个 `-3` 会压到所有正常编号前面，
       * 用户拖了半天发现"新加的反而跑到最上面"。
       */
      order: sanitizeOrder(rec.order),
      ...(fieldAt ? { fieldAt } : {}),
    });
  }
  /**
   * 孤儿收敛：parentId 指向的任务必须真实存在，且不能指向自己 ——
   * 否则渲染层按父级分组时这行会被过滤掉，等于静默丢失。
   * 校验不过就退化成顶层任务，宁可层级错，也不能数据没。
   */
  const alive = new Set(list.map((task) => task.id));
  return list.map((task) =>
    task.parentId && task.parentId !== task.id && alive.has(task.parentId)
      ? task
      : { ...task, parentId: null },
  );
}

/** 解析成毫秒；非法/缺失一律 0，保证比较永远有确定性结果 */
function toMillis(iso: unknown): number {
  if (typeof iso !== 'string' || !iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/**
 * 逐条兜底：丢弃非对象项与非法日期项。
 *
 * ⚠️ **空正文必须保留**，不能当成"没写"丢掉：它代表"用户把这篇清空了"，
 * 是个需要同步到别的设备的删除动作。丢掉的话，手机上清空了日记、电脑一同步又冒出来。
 * UI 层渲染时过滤掉空条目即可（对用户来说等于当天没写）。
 *
 * 同一天出现多篇时按 updatedAt 取新 —— 老数据可能因为历史 bug 重复，这一步收敛掉。
 */
/**
 * 闹钟字段级兜底：`at` 必须是合法 'HH:mm'，`repeat` 只接受 'none' | 'daily'。
 *
 * 返回 null 的语义是"**这条记事没有（有效的）闹钟**"，调用方**只丢 remind** ——
 * 绝不因此丢 note，也绝不因此丢 sr。理由同 sr：闹钟可以重设，
 * 笔记正文与复习进度不能重建。
 *
 * `repeat` 的非法值**回落 'none' 而不是整条丢弃**：'none' 是"仅一次"，
 * 是两者中更保守的一档（不会天天误响），比"闹钟凭空消失"对用户更友好。
 */
export function sanitizeRemind(raw: unknown): NoteRemind | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const at = typeof rec.at === 'string' ? rec.at : '';
  if (!TIME_PATTERN.test(at)) return null;
  const repeat: NoteRemind['repeat'] = rec.repeat === 'daily' ? 'daily' : 'none';
  return { at, repeat };
}

/**
 * 记事字段级兜底。
 *
 * 规则与 sanitizeDiary 一致：**不 trim 后判空丢弃** —— 用户把内容清空也算"清空了"，
 * 丢弃会让"删掉一条记事"这件事在下次同步时被误判复活（`NOTE_DELETE` 是软删除：
 * content 置空 + updatedAt 打点，这条空壳正是"它被删过"的唯一凭据）。
 * title 截 120、content 截 20000：防止异常数据把 localStorage 撑爆。
 *
 * ⚠️ 若将来有人想加一句 `if (!content) continue;`，等于把记事删除同步打回解放前，
 * 改之前先读 reducer 里 NOTE_DELETE 的说明。
 *
 * ⚠️ 这是全工程**唯一的高危改动点**（F1 复习进度挂上 Note 时）：
 * sr 必须用**条件展开**接上。下面两件事都不能做：
 *   - 写 `sr` 或 `sr: sr ?? undefined` → note 上会多出一个 sr 键，
 *     而"有没有 sr 键"正是"它是不是复习卡片"的判据，普通记事会被误判成卡片；
 *   - 为了类型过审写 `if (!sr) continue;` → 丢掉整条 note。
 *     复习进度可以重建，**笔记正文不能重建**。sr 坏就只丢 sr。
 *
 * 同理（v0.9 笔记闹钟）：`remind` 也用条件展开 —— 没有闹钟的记事**不能多出 remind 键**，
 * 否则 UI 会显示一个"空闹钟"，而关掉闹钟的动作（删键）也会失效。remind 坏只丢 remind。
 */
export function sanitizeNotes(raw: unknown): Note[] {
  if (!Array.isArray(raw)) return [];
  const now = nowIso();
  const byId = new Map<string, Note>();
  for (const item of raw) {
    const rec = asRecord(item);
    if (!rec) continue;
    const id = typeof rec.id === 'string' && rec.id ? rec.id : null;
    if (!id) continue;
    /** sr 非法 → null → 不展开这个键（只丢复习进度，note 原样活着） */
    const sr = sanitizeSr(rec.sr);
    /** remind 非法 → null → 不展开这个键（只丢闹钟，note 与 sr 都原样活着） */
    const remind = sanitizeRemind(rec.remind);
    byId.set(id, {
      id,
      title: typeof rec.title === 'string' ? rec.title.slice(0, 120) : '',
      content: typeof rec.content === 'string' ? rec.content.slice(0, 20000) : '',
      category: typeof rec.category === 'string' ? rec.category : '',
      pinned: rec.pinned === true,
      createdAt: typeof rec.createdAt === 'string' && rec.createdAt ? rec.createdAt : now,
      updatedAt: typeof rec.updatedAt === 'string' && rec.updatedAt ? rec.updatedAt : now,
      ...(sr ? { sr } : {}),
      ...(remind ? { remind } : {}),
    });
  }
  // updatedAt 新的在前：列表打开就能看到最近动过的
  return [...byId.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

/**
 * 载荷里有没有真实数据：tasks / diary / notes / focusSessions / tombstones
 * **任一非空**都算非空。
 *
 * `settings` 不算 —— 它恒有默认值，算它等于永远非空，判定就失去意义了。
 */
export function hasAnyPersistedData(payload: PersistedPayload | null | undefined): boolean {
  if (!payload) return false;
  const count = (value: unknown): number => (Array.isArray(value) ? value.length : 0);
  return (
    count(payload.tasks) > 0 ||
    count(payload.diary) > 0 ||
    count(payload.notes) > 0 ||
    count(payload.focusSessions) > 0 ||
    count(payload.tombstones) > 0
  );
}

export function sanitizeDiary(raw: unknown): DiaryEntry[] {
  if (!Array.isArray(raw)) return [];
  const now = nowIso();
  const byDate = new Map<string, DiaryEntry>();

  for (const item of raw) {
    const rec = asRecord(item);
    if (!rec) continue;
    const date = typeof rec.date === 'string' && isValidDateKey(rec.date) ? (rec.date as DateKey) : null;
    if (!date) continue;
    // 只截断长度，**不 trim 后判空丢弃**：trim 掉的空白内容也算"用户清空了"
    const content = typeof rec.content === 'string' ? rec.content.slice(0, DIARY_MAX) : '';

    const entry: DiaryEntry = {
      date,
      content,
      createdAt: typeof rec.createdAt === 'string' && rec.createdAt ? rec.createdAt : now,
      updatedAt: typeof rec.updatedAt === 'string' && rec.updatedAt ? rec.updatedAt : now,
    };
    const prev = byDate.get(date);
    if (!prev || toMillis(entry.updatedAt) >= toMillis(prev.updatedAt)) byDate.set(date, entry);
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/**
 * 墓碑兜底：id 与 deletedAt 都是合法字符串才保留，其余丢弃。
 *
 * 删除记录也是数据 —— 丢了它，被删的任务会在别的设备上复活。
 * 同 id 取 deletedAt 较新的一份，保证合并结果确定。
 */
export function sanitizeTombstones(raw: unknown): TaskTombstone[] {
  if (!Array.isArray(raw)) return [];
  const byId = new Map<string, TaskTombstone>();
  for (const item of raw) {
    const rec = asRecord(item);
    if (!rec) continue;
    const id = typeof rec.id === 'string' && rec.id ? rec.id : null;
    if (!id) continue;
    /**
     * `deletedAt` 必须是**可解析**的时间。
     *
     * 只校验"非空字符串"是不够的：一个 `"abc"` 会让 `toMillis` 得到 NaN，
     * 于是排序不确定、回收站显示 `NaN年NaN月NaN日 · NaN 天`。
     * 这种脏数据能进来（旧版本 / 手改备份 / 云端行），且不会抛错，
     * 只会在某天让人看不懂"这条还能留几天"。口径与 focusSessions 一致：
     * 解析不了就当"刚刚删的"。
     */
    const deletedAt =
      typeof rec.deletedAt === 'string' && Number.isFinite(Date.parse(rec.deletedAt))
        ? rec.deletedAt
        : nowIso();
    const stone: TaskTombstone = {
      id,
      deletedAt,
      title: typeof rec.title === 'string' ? rec.title.slice(0, 120) : '',
      date: typeof rec.date === 'string' && isValidDateKey(rec.date) ? (rec.date as DateKey) : todayKey(),
      index: Number.isFinite(Number(rec.index)) && Number(rec.index) >= 0 ? Math.trunc(Number(rec.index)) : 0,
    };
    const prev = byId.get(id);
    if (!prev || toMillis(deletedAt) >= toMillis(prev.deletedAt)) byId.set(id, stone);
  }
  /**
   * 超期清理：回收站的文案写着「保留 90 天，超期自动清理」，而代码里原来
   * **没有任何清理**——墓碑只增不减，每条都进 payload、进云同步、占配额，
   * 每行却永远显示"还剩 0 天"。承诺与行为不一致比没有承诺更糟。
   *
   * 按 `deletedAt` 距今超过 `TOMBSTONE_KEEP_DAYS` 就丢。代价说清楚：
   * 一台设备若**连续 90 天没联网**，它本地的已删任务在合并时可能复活一次
   * （墓碑没了就没有"这条被删过"的凭据）——但这个窗口比任何真实使用场景都长，
   * 而"永不清理 + 文案撒谎"是确定性的问题。
   */
  const cutoff = toMillis(nowIso()) - TOMBSTONE_KEEP_DAYS * 24 * 60 * 60 * 1000;
  const kept = [...byId.values()].filter((stone) => toMillis(stone.deletedAt) >= cutoff);

  // 新的在前：回收站按删除时间倒序展示
  return kept.sort((a, b) => toMillis(b.deletedAt) - toMillis(a.deletedAt));
}

/**
 * 专注记录兜底：id 与起止时间齐全才保留。
 *
 * 时长**按起止时间重算**，不信外部传来的 durationMs ——
 * 那是可篡改的，而且单位（秒 / 毫秒）在不同端历史上不一致过。
 */
export function sanitizeFocusSessions(raw: unknown): FocusSession[] {
  if (!Array.isArray(raw)) return [];
  const byId = new Map<string, FocusSession>();
  for (const item of raw) {
    const rec = asRecord(item);
    if (!rec) continue;
    const id = typeof rec.id === 'string' && rec.id ? rec.id : null;
    if (!id) continue;
    const startedAt = typeof rec.startedAt === 'string' && rec.startedAt ? rec.startedAt : null;
    const endedAt = typeof rec.endedAt === 'string' && rec.endedAt ? rec.endedAt : null;
    if (!startedAt || !endedAt) continue;

    const session: FocusSession = {
      id,
      taskId: typeof rec.taskId === 'string' && rec.taskId ? rec.taskId : null,
      date: typeof rec.date === 'string' && isValidDateKey(rec.date)
        ? (rec.date as DateKey)
        : todayKey(),
      startedAt,
      endedAt,
      durationMs: Math.max(0, toMillis(endedAt) - toMillis(startedAt)),
      // 逐字段重建：这里漏一行，每次冷启动/云同步都会把科目清空
      ...(typeof rec.category === 'string' && rec.category ? { category: rec.category } : {}),
    };
    const prev = byId.get(id);
    if (!prev || toMillis(endedAt) >= toMillis(prev.endedAt)) byId.set(id, session);
  }
  return [...byId.values()].sort((a, b) => toMillis(b.startedAt) - toMillis(a.startedAt));
}
