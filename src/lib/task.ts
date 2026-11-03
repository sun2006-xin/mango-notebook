import {
  DEFAULT_CATEGORIES,
  ESTIMATE_MINUTES_MAX,
  NOTE_MAX,
  PRIORITY_META,
  TIME_PATTERN,
  TITLE_MAX,
  WEEK_MAX_ROWS,
} from '../constants';
import { addDays, diffDays } from './date';
import type {
  DateKey,
  DayCell,
  DayGroup,
  DayProgress,
  DayStatus,
  FilterMode,
  Priority,
  Repeat,
  Task,
  TaskInput,
  WeekColumn,
} from '../types';
import { isValidDateKey } from './date';

/* ============================================================================
   任务纯函数（ARCHITECTURE §4.2）
   本文件不依赖 React / window / localStorage，全部可单测。
   ========================================================================= */

/** 标题为空白时抛出，由 UI 捕获做输入框抖动 */
export class EmptyTitleError extends Error {
  constructor() {
    super('标题不能为空');
    this.name = 'EmptyTitleError';
  }
}

/** crypto.randomUUID 不可用时降级（老浏览器 / 非安全上下文） */
function createId(): string {
  const maybeCrypto = globalThis.crypto as Crypto | undefined;
  if (maybeCrypto && typeof maybeCrypto.randomUUID === 'function') {
    return maybeCrypto.randomUUID();
  }
  return `t_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

const PRIORITY_VALUES: Priority[] = ['high', 'medium', 'low'];
const REPEAT_VALUES: Repeat[] = ['none', 'daily', 'weekly', 'monthly'];

function normalizePriority(value: unknown): Priority {
  return PRIORITY_VALUES.includes(value as Priority) ? (value as Priority) : 'medium';
}

/** 非法/缺失一律回落 'none' —— 老任务没有这个字段，必须兼容 */
function normalizeRepeat(value: unknown): Repeat {
  return REPEAT_VALUES.includes(value as Repeat) ? (value as Repeat) : 'none';
}

/**
 * 「预计用时（分钟）」的唯一收敛口径。
 *
 * 规则：非有限数（NaN / Infinity / undefined / 纯文本）→ 0；
 * 有限数 → 截断取整 + 夹紧到 `[0, ESTIMATE_MINUTES_MAX]`。
 *
 * 为什么单独抽出来：同一份数据有**四条**入口都会带它进来 ——
 * 表单（createTask）、抽屉 patch（reducer 的 normalizePatch）、
 * 本地/云端载荷（storage 的 sanitizeTasks）、以及别的手改 JSON。
 * 四条各写一遍 clamp，迟早出现"能存 9999 但改一下变 100000"的不一致。
 *
 * ⚠️ 负数与时区无关地一律归 0：一个 `-30` 会让今日预算求和变小，
 * 用户看到的是"预计时间比实际任务还少"，比归零更难解释。
 */
export function clampEstimateMinutes(raw: unknown): number {
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) return 0;
  return Math.min(ESTIMATE_MINUTES_MAX, Math.max(0, Math.trunc(value)));
}

/**
 * 由表单输入构造完整 Task。
 * - title.trim() 为空 → 抛 EmptyTitleError
 * - note 截 500；time 不合法 → null；date 不合法 → 回落 fallbackDate
 * - priority 不在枚举 → 'medium'；category 空 → 第一个预设分类
 * - estimatedMinutes 不传 / 非法 → 0（未估时，见 clampEstimateMinutes）
 */
export function createTask(input: TaskInput, now: string, fallbackDate: DateKey): Task {
  const title = String(input.title ?? '').trim();
  if (!title) throw new EmptyTitleError();

  const note = String(input.note ?? '').slice(0, NOTE_MAX);
  const rawTime = input.time ?? null;
  const time = rawTime !== null && TIME_PATTERN.test(rawTime) ? rawTime : null;
  const date = input.date && isValidDateKey(input.date) ? input.date : fallbackDate;
  /**
   * 结束日：不合法 / 早于开始日 → `null`（退化成单天任务）。
   * 早于开始日必须收敛掉，否则 `taskCoversDate` 永不成立 —— 任务会凭空消失，
   * 而且是从列表里"静默消失"，最难查。
   */
  const rawEnd = input.endDate ?? null;
  const endDate = rawEnd && isValidDateKey(rawEnd) && rawEnd > date ? rawEnd : null;
  const category = String(input.category ?? '').trim() || (DEFAULT_CATEGORIES[0] as { name: string }).name;

  return {
    id: createId(),
    title: title.slice(0, TITLE_MAX),
    note,
    date,
    endDate,
    time,
    repeat: normalizeRepeat(input.repeat),
    priority: normalizePriority(input.priority),
    category,
    done: false,
    doneAt: null,
    createdAt: now,
    updatedAt: now,
    // 新建默认顶层；挂到某条任务下由调用方补 parentId
    parentId: null,
    // 留空 = 0 = 未估时（表单允许留空，这是最常用的一档）
    estimatedMinutes: clampEstimateMinutes(input.estimatedMinutes),
    /**
     * 排序位：**新建一律 0（= 未手动排过，走自动排序）**。
     * 真正的号由 reducer 的 TASK_ADD 按目标日的现状补发 ——
     * 这里发号会漏掉"这天已经手动排过序"的判断（createTask 看不到其它任务）。
     */
    order: 0,
  };
}

/**
 * 排序位的唯一读法（`Task.order`）。
 *
 * 老数据 / 云端旧载荷没有这个字段，业务代码里散落 `?? 0` 迟早漏一处 ——
 * 统一走这个函数，`0` 的语义（= 未手动排过，走自动排序）也才有唯一解释。
 */
export function taskOrder(task: Task): number {
  return typeof task.order === 'number' && Number.isFinite(task.order) ? task.order : 0;
}

/**
 * 待办区排序（六级稳定排序）：
 * ① **手动排序位**（`Task.order`，小者在前）；
 * ② 有时间者在前；③ 都有时间 → time 升序；④ 都无时间 → 优先级 rank 升序；
 * ⑤ createdAt 升序；⑥ id 升序兜底。
 *
 * 为什么第 ① 级是"无条件优先"而不是"只有两边都手动过才比"：
 * 手动排序位是**连续编号**的（拖拽后目标日会被编成 1..n，见 lib/drag.ts），
 * 未手动排过的日子全为 0 —— 于是"全 0 的一天"自然退化成原来的五级自动排序，
 * 不需要在比较器里再判断一次"这天排过没有"。
 *
 * 注意：本函数**不读 done 字段** —— sticky 项混排后必然回到原位（§9 U6）。
 */
export function compareOpenTasks(a: Task, b: Task): number {
  const byOrder = taskOrder(a) - taskOrder(b);
  if (byOrder !== 0) return byOrder;

  const aTimed = a.time !== null;
  const bTimed = b.time !== null;
  if (aTimed !== bTimed) return aTimed ? -1 : 1;

  if (aTimed && bTimed && a.time !== b.time) {
    return (a.time as string) < (b.time as string) ? -1 : 1;
  }
  if (!aTimed && !bTimed) {
    const byPriority = PRIORITY_META[a.priority].rank - PRIORITY_META[b.priority].rank;
    if (byPriority !== 0) return byPriority;
  }
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 已完成区排序：doneAt 降序（null 视为最旧）→ createdAt 升序 → id */
export function compareDoneTasks(a: Task, b: Task): number {
  const aDone = a.doneAt;
  const bDone = b.doneAt;
  if (aDone !== bDone) {
    if (!aDone) return 1;
    if (!bDone) return -1;
    return aDone > bDone ? -1 : 1;
  }
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 某日全部任务（原序，不排序；供进度统计） */
export function getTasksForDate(tasks: Task[], date: DateKey): Task[] {
  return tasks.filter((t) => taskCoversDate(t, date));
}

/* ============================================================================
   多天任务（跨天区间）
   ----------------------------------------------------------------------------
   `date` = 开始日，`endDate` = 最后一天（含），闭区间；`endDate` 为空 = 单天。
   这三个函数是**唯一读法** —— 业务代码里不要再手写 `task.date === date`，
   那样跨天任务会在某些页面出现、某些页面不出现，这种不一致极难排查。
   ========================================================================= */

/** 任务的最后一天（单天任务就是 `date`）。脏数据（endDate < date）按 date 处理 */
export function taskLastDate(task: Task): DateKey {
  const end = task.endDate;
  if (typeof end === 'string' && isValidDateKey(end) && end > task.date) return end;
  return task.date;
}

/** 这个任务是否覆盖某一天（闭区间） */
export function taskCoversDate(task: Task, date: DateKey): boolean {
  if (!task || typeof task.date !== 'string') return false;
  return date >= task.date && date <= taskLastDate(task);
}

/** 跨度天数（含首尾）；单天任务 = 1 */
export function taskSpanDays(task: Task): number {
  return diffDays(taskLastDate(task), task.date) + 1;
}

/**
 * 逾期集合：**最后一天**已过且未完成，最老的在上。
 *
 * 按 `taskLastDate` 判而不是开始日：一个 30 天的任务从第 2 天起就进逾期区，
 * 等于逼人把它拆成 30 条 —— 那和多天任务的意义正好相反。
 */
export function getOverdueTasks(tasks: Task[], today: DateKey): Task[] {
  return tasks
    .filter((t) => taskLastDate(t) < today && !t.done)
    .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : compareOpenTasks(a, b)));
}

/**
 * 渲染前筛选：只影响渲染，不改数据。
 * mode='open' 时 sticky 项也不显示（用户明确要求只看未完成）。
 */
export function applyFilter(tasks: Task[], mode: FilterMode, category: string | null): Task[] {
  return tasks.filter((t) => {
    if (category && t.category !== category) return false;
    if (mode === 'open') return !t.done;
    if (mode === 'done') return t.done;
    return true;
  });
}

export interface GroupDayTasksArgs {
  tasks: Task[];
  date: DateKey;
  today: DateKey;
  mode: FilterMode;
  category: string | null;
  stickyDoneIds: string[];
  includeOverdue: boolean;
}

/**
 * 分组 + 排序总入口。
 * sticky 口径（§9 U6）：本次会话勾选且仍属该日的任务**与未完成项一起**送进
 * compareOpenTasks 混排后写入 open（不是追加到末尾），另投影一份到 sticky。
 */
export function groupDayTasks(args: GroupDayTasksArgs): DayGroup {
  return groupFromDayTasks(getTasksForDate(args.tasks, args.date), args);
}

/**
 * 同 `groupDayTasks`，但**由调用方提供当日原始任务**（未过滤）。
 *
 * 为什么要有这一版：原实现内部把 `getTasksForDate(tasks, date)` 调了**两次**
 * （一次给顶层列表、一次给子任务归组），而调用方（今日页）自己又算了一遍
 * `dayTasks` —— 一次任务编辑下来，同一张表被 filter 了三遍。
 * 把"取当日任务"提到外面，就能一次遍历喂两处。
 */
export function groupFromDayTasks(dayTasksRaw: Task[], args: GroupDayTasksArgs): DayGroup {
  const { tasks, date, today, mode, category, stickyDoneIds, includeOverdue } = args;
  const dayTasks = applyFilter(dayTasksRaw, mode, category);

  /**
   * 子任务不参与顶层排序：它们挂在父任务下面。
   * 顶层口径只看 parentId 为空的任务 —— 否则子任务会像独立待办一样
   * 在列表里再出现一次（父任务下面一遍、顶层又一遍）。
   */
  const topLevel = dayTasks.filter((t) => !t.parentId);

  const stickySet = new Set(stickyDoneIds);
  const sticky = mode === 'all' ? topLevel.filter((t) => t.done && stickySet.has(t.id)) : [];
  const stickyIds = new Set(sticky.map((t) => t.id));

  const open = [...topLevel.filter((t) => !t.done), ...sticky].sort(compareOpenTasks);
  const done = topLevel.filter((t) => t.done && !stickyIds.has(t.id)).sort(compareDoneTasks);

  const overdue =
    includeOverdue && date === today && mode !== 'done'
      ? getOverdueTasks(tasks, today).filter((t) => !t.parentId && (!category || t.category === category))
      : [];

  /**
   * 子任务按父归组。
   *
   * 注意这里用的是**未经分类筛选**的当日任务，只套 mode（待办/已完成）：
   * 分类是"父任务"的属性，子任务跟着父走。如果也套 category 筛选，
   * 一条被单独改过分类的子任务会在父任务的分类视图里凭空消失 ——
   * 用户既看不到它、也想不到是筛选造成的。父任务被筛掉时子任务自然不渲染，
   * 因为渲染入口是父任务本身。
   */
  const childrenByParent: Record<string, Task[]> = {};
  for (const task of dayTasksRaw) {
    if (!task.parentId) continue;
    if (mode === 'open' && task.done) continue;
    if (mode === 'done' && !task.done) continue;
    const bucket = childrenByParent[task.parentId];
    if (bucket) bucket.push(task);
    else childrenByParent[task.parentId] = [task];
  }
  for (const key of Object.keys(childrenByParent)) {
    childrenByParent[key]?.sort(compareOpenTasks);
  }

  return { overdue, open, done, sticky, childrenByParent };
}

/**
 * 周视图单列排序：未完成在前（避免已完成占住前 4 个坑），
 * 同组内回落 compareOpenTasks；sticky 不特殊处理。
 */
export function compareWeekColumnTasks(a: Task, b: Task): number {
  if (a.done !== b.done) return a.done ? 1 : -1;
  return compareOpenTasks(a, b);
}

/**
 * 周视图唯一数据入口。
 * progress 必须与今日视图头部、侧栏共用 getDayProgress（同源一致）。
 */
export function buildWeekColumns(
  tasks: Task[],
  days: DateKey[],
  today: DateKey,
  selected: DateKey,
  maxRows: number = WEEK_MAX_ROWS,
): WeekColumn[] {
  /**
   * 一次建索引，而不是每天各扫一遍全表。
   * 原实现是 7 次 getTasksForDate + 7 次 getDayProgress = **14 次 O(n) 扫描**；
   * indexByDate 本来就是为了消掉这种重复扫描而存在的，一直没被这条路径用上。
   * 现在变成 O(n) 一次 + O(1) 查询，顺手也把"同一天被 filter 两遍"的重算去掉了。
   */
  const index = indexByDate(tasks);

  return days.map((key) => {
    // slice() 后再排：index 里的数组是原引用，就地 sort 会打乱其它视图的顺序
    const all = (index.get(key) ?? []).slice().sort(compareWeekColumnTasks);
    const done = all.filter((task) => task.done).length;
    const total = all.length;
    return {
      key,
      day: Number(key.slice(8, 10)),
      isToday: key === today,
      isSelected: key === selected,
      tasks: all.slice(0, maxRows),
      overflow: Math.max(0, total - maxRows),
      progress: { done, total, percent: total === 0 ? null : Math.round((done / total) * 100) },
      isEmpty: total === 0,
    };
  });
}

/**
 * 「已完成 · N」的 N（§9 U7）：done + sticky。
 * sticky 项渲染在待办区但它**是已完成的**，不计入就会出现「进度 9/12、已完成 8」的错位。
 */
export function countDoneInView(group: DayGroup): number {
  return group.done.length + group.sticky.length;
}

/** 当日进度：total 含已完成与 sticky；percent 在 total=0 时为 null */
export function getDayProgress(tasks: Task[], date: DateKey): DayProgress {
  const list = getTasksForDate(tasks, date);
  const done = list.filter((t) => t.done).length;
  const total = list.length;
  return { done, total, percent: total === 0 ? null : Math.round((done / total) * 100) };
}

/** 月历四态 */
export function getDayStatus(tasks: Task[], date: DateKey): DayStatus {
  const { done, total } = getDayProgress(tasks, date);
  if (total === 0) return 'empty';
  if (done === total) return 'all-done';
  if (done === 0) return 'none-done';
  return 'partial';
}

/**
 * 一次遍历建日索引（日历 / 周视图的唯一数据入口）。
 *
 * **跨天任务会出现在它覆盖的每一天的桶里** —— 这正是"日索引"该有的语义：
 * 调用方只想知道"这一天有哪些任务"，不需要再自己判区间。
 *
 * 代价：一个 30 天的任务会写 30 次。用 `MAX_SPAN_INDEX_DAYS` 兜底，
 * 免得一条脏数据（endDate 写成 2099 年）把内存打爆 —— 宁可少画几天，
 * 也不能让日历页直接卡死。
 */
export const MAX_SPAN_INDEX_DAYS = 366;

export function indexByDate(tasks: Task[]): Map<DateKey, Task[]> {
  const map = new Map<DateKey, Task[]>();
  for (const task of tasks) {
    if (!task || typeof task.date !== 'string') continue;
    const last = taskLastDate(task);
    let cursor = task.date;
    for (let guard = 0; guard < MAX_SPAN_INDEX_DAYS; guard += 1) {
      const bucket = map.get(cursor);
      if (bucket) bucket.push(task);
      else map.set(cursor, [task]);
      if (cursor >= last) break;
      cursor = addDays(cursor, 1);
    }
  }
  return map;
}

/** 42 格四态（只查 cells 里出现过的 key） */
export function getMonthStatusMap(
  index: Map<DateKey, Task[]>,
  cells: DayCell[],
): Map<DateKey, DayStatus> {
  const statusMap = new Map<DateKey, DayStatus>();
  for (const cell of cells) {
    const list = index.get(cell.key);
    if (!list || list.length === 0) {
      statusMap.set(cell.key, 'empty');
      continue;
    }
    const done = list.filter((t) => t.done).length;
    statusMap.set(
      cell.key,
      done === list.length ? 'all-done' : done === 0 ? 'none-done' : 'partial',
    );
  }
  return statusMap;
}

/**
 * 按预设顺序输出分类计数（空分类也保留 count 0）。
 * `date` 为 null 时统计全部任务（设置页「分类」区块用）；
 * 传具体日期时只统计该日（统计概览用）。
 * 注：§4.2 原签名只列了 (tasks, date)，实现上必须再拿到预设清单才能保证
 * 「按预设顺序 + 空分类保留」，故追加 categories 参数（向后兼容的超集）。
 */
export function countByCategory(
  tasks: Task[],
  date: DateKey | null,
  categories: { name: string }[],
): { name: string; count: number }[] {
  const scoped = date === null ? tasks : tasks.filter((t) => t.date === date);
  const counters = new Map<string, number>();
  for (const c of categories) counters.set(c.name, 0);
  for (const t of scoped) {
    counters.set(t.category, (counters.get(t.category) ?? 0) + 1);
  }
  return categories.map((c) => ({ name: c.name, count: counters.get(c.name) ?? 0 }));
}

/**
 * 体积估算：只做 UTF-8 字节数 → KB 换算（保留 1 位小数）。
 * 入参是**已序列化的 JSON 字符串**（序列化留给调用方，本层保持纯函数）。
 */
export function estimateStorageKb(json: string): number {
  const bytes = new TextEncoder().encode(json).length;
  return Math.round((bytes / 1024) * 10) / 10;
}

/**
 * 今天**已到点且未完成**的任务 —— 到期提醒的候选集。
 * `nowKey` 为 'HH:mm'（24 小时制补零），字符串可直接比较，不必转时间戳。
 * 早于当前时刻的都算"该提醒"：打开应用时一次性让用户看到今天已过期待办。
 */
export function tasksDueForReminder(tasks: Task[], today: DateKey, nowKey: string): Task[] {
  if (!Array.isArray(tasks)) return [];
  return tasks.filter(
    (task) =>
      !task.done && task.date === today && typeof task.time === 'string' && task.time <= nowKey,
  );
}

/* ============================================================================
   子任务（只支持一层：父 → 子，子不能再有子）
   ========================================================================= */

/** 直接子任务，按待办区口径排序 */
export function getChildTasks(tasks: Task[], parentId: string): Task[] {
  if (!Array.isArray(tasks)) return [];
  return tasks.filter((t) => t.parentId === parentId).sort(compareOpenTasks);
}

/** 顶层任务（parentId 为空的任务） */
export function getTopLevelTasks(tasks: Task[]): Task[] {
  if (!Array.isArray(tasks)) return [];
  return tasks.filter((t) => !t.parentId);
}

/** 父任务行上要显示的小进度：'2/5' 用的原始数据；没有子任务时 total=0 */
export function getSubtaskProgress(tasks: Task[], parentId: string): { done: number; total: number } {
  const children = getChildTasks(tasks, parentId);
  return { done: children.filter((c) => c.done).length, total: children.length };
}

/**
 * 新任务的父 id 归一化：子任务不能再有子任务。
 *
 * 为什么在这里拦而不是只在 UI 拦：数据会经云同步从别的设备过来，
 * 对端的 UI 规则未必和我们一致。存储层（storage.ts）已做孤儿收敛兜底，
 * 这里是**写入前**的第二道 —— 让"两层以上"根本产生不出来。
 */
export function normalizeParentId(tasks: Task[], parentId: string | null | undefined): string | null {
  if (typeof parentId !== 'string' || !parentId) return null;
  const parent = tasks.find((t) => t.id === parentId);
  if (!parent) return null;
  // 父任务自己也是子任务 → 挂到祖父
  if (!parent.parentId) return parentId;
  /**
   * 祖父必须**真实存在**才能挂。否则返回 parent.parentId 会凭空造出一个
   * 指向不存在任务的指针（孤儿），只能等存储层的收敛逻辑去救 ——
   * 那已经是"坏了再修"，不如这里就不让它坏。
   */
  return tasks.some((t) => t.id === parent.parentId) ? parent.parentId : null;
}

/**
 * 勾选联动（纯函数，返回新数组；id 不存在则原样返回）。
 *
 * 两条规则，都是为了避免"父子状态互相打脸"：
 * ① 向下级联：勾父 → 所有子一起勾；取消父 → 所有子一起取消。
 *    否则会出现"父任务已完成，底下 4 个子任务还绿着"的鬼畜画面。
 * ② 向上汇总：子任务全勾完 → 父自动完成；任一子被取消 → 父退回未完成。
 *    否则进度条会说"5/5 完成"，父任务却还站在待办区。
 *
 * 只联动一层：嵌套只有一层，不存在"祖父被改"的传播问题。
 */
export function applyTaskToggle(tasks: Task[], id: string, now: string): Task[] {
  if (!Array.isArray(tasks)) return tasks;
  const target = tasks.find((t) => t.id === id);
  if (!target) return tasks;

  const nextDone = !target.done;
  const childIds = new Set(
    tasks.filter((t) => t.parentId === id).map((t) => t.id),
  );

  let next = tasks.map((task) => {
    const affected = task.id === id || childIds.has(task.id);
    if (!affected) return task;
    return {
      ...task,
      done: nextDone,
      doneAt: nextDone ? now : null,
      updatedAt: now,
    };
  });

  // 向上汇总：只有"自己是个子任务"时才需要重算父任务
  if (target.parentId) {
    const parentId = target.parentId;
    const siblings = next.filter((t) => t.parentId === parentId);
    const allDone = siblings.length > 0 && siblings.every((t) => t.done);

    const parent = next.find((t) => t.id === parentId);
    if (parent && parent.done !== allDone) {
      const updatedParent: Task = {
        ...parent,
        done: allDone,
        doneAt: allDone ? now : null,
        updatedAt: now,
      };
      next = next.map((t) => (t.id === parentId ? updatedParent : t));
    }
  }

  return next;
}

/* ============================================================================
   完成率趋势（设置页图表用）
   ========================================================================= */

export interface TrendPoint {
  date: DateKey;
  done: number;
  total: number;
  /** total=0 时为 null（图表上画成"无数据"，不画成 0%） */
  percent: number | null;
}

/**
 * 最近 N 天的完成率（含今天，从旧到新）。
 * 没有任务的日子 percent=null —— 画成 0% 会让"休息日"看起来像"全都没做完"。
 */
export function buildCompletionTrend(tasks: Task[], today: DateKey, days: number): TrendPoint[] {
  if (!Array.isArray(tasks)) return [];
  const points: TrendPoint[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = addDays(today, -offset);
    // 跨天任务覆盖的每一天都算进分母（与今日进度同口径）
    const dayTasks = tasks.filter((task) => taskCoversDate(task, date));
    const done = dayTasks.filter((task) => task.done).length;
    points.push({
      date,
      done,
      total: dayTasks.length,
      percent: dayTasks.length === 0 ? null : Math.round((done / dayTasks.length) * 100),
    });
  }
  return points;
}

/**
 * 两条任务是否算"同一次重复"（勾完以后判要不要生成下一份用的）。
 *
 * 只比标题是不够的：同一天可以有两条同名重复任务（「跑步」07:00 每天 +
 * 「跑步」20:00 每天）。勾完 07:00 那条会生成明天 07:00 的；再勾 20:00 那条时，
 * 只比标题会命中刚生成的那条 → 判成"已存在"直接跳过 → 20:00 这条链**静默断掉**，
 * 用户只能每周自己补建。所以时间 / 分类 / 优先级一起比。
 *
 * 真正根治要加 `seriesId`（重复链 id），那会动持久化字段与迁移链，属后续工作。
 */
export function isSameRepeatOccurrence(a: Task, b: Task): boolean {
  return (
    a.date === b.date &&
    a.title === b.title &&
    (a.time ?? '') === (b.time ?? '') &&
    (a.category ?? '') === (b.category ?? '') &&
    a.priority === b.priority
  );
}
