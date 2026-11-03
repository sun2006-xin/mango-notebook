import type { DateKey, DayGroup, DayProgress, Task } from '../types';
import {
  getDayProgress,
  getTasksForDate,
  groupFromDayTasks,
  type GroupDayTasksArgs,
} from './task';

/* ============================================================================
   今日页的派生数据（单入口 + 引用稳定）
   ----------------------------------------------------------------------------
   这个文件解决两个具体问题，都不是"感觉慢"：

   ① **重复扫描**：原来今日页分别算 `progress` / `dayTasks` / `group`，
      而 `groupDayTasks` 内部又把 `getTasksForDate` 走了一遍 ——
      一次任务编辑下来，同一张表被 filter 了三遍（外加 overdue 再扫一遍）。
      这里一次取出当日原始数组，喂给两处。

   ② **引用不稳定**：如果每次调用都新建 `{group, dayTasks, progress}`，
      下游 `TaskList` 的 `memo` 永远不会命中 —— 哪怕数据一模一样。
      这里用**单条缓存**（按输入引用比较）保证"输入没变 → 返回同一个对象"，
      于是 UI 层的浅比较才真正起作用。

   为什么单条缓存就够：这个选择器是"当前视图"的派生，同一时刻只有一个活跃视图 +
   一种筛选组合。多视图并存时最多各命中各的失败，代价只是多算一次，不会错。

   ⚠️ 缓存成立的前提是**输入不可变**（store 里的数组都是替换而非原地改）。
   这条纪律由 reducer 保证：任何任务变更都产生新数组。
   ========================================================================= */

export interface DayViewInput extends GroupDayTasksArgs {
  /** 用于 progress 的口径与 group 一致（同步当天） */
  date: DateKey;
}

export interface DayView {
  /** 当日（含跨天覆盖）的全部任务，未套筛选 */
  dayTasks: Task[];
  /** 按 mode / category 过滤后的分组 */
  group: DayGroup;
  /** 已完成 / 总数（与 group 同源，避免头部数字与列表不一致） */
  progress: DayProgress;
}

/** 测试探针：真正算过几次（缓存命中不增加） */
export let __dayViewScans = 0;

/** 仅供测试：清空缓存与计数 */
export function __resetDayView(): void {
  cache = null;
  __dayViewScans = 0;
}

let cache: {
  key: readonly unknown[];
  value: DayView;
} | null = null;

function cacheKey(input: DayViewInput): readonly unknown[] {
  return [
    input.tasks,
    input.date,
    input.today,
    input.mode,
    input.category,
    input.stickyDoneIds,
    input.includeOverdue,
  ];
}

function sameKey(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === b[i]) continue;
    /**
     * 数组（目前只有 `stickyDoneIds`）按**内容**比较，不按引用。
     *
     * 理由：调用方很容易写 `stickyDoneIds: []` 这样的字面量（每次渲染都是新数组），
     * 那样缓存永远不命中 —— 而且失效是**静默**的，只是白算一遍，没有任何报错。
     * 这个数组很短（最多几条），逐项比较的代价远小于重算一次分组。
     */
    const av = a[i];
    const bv = b[i];
    if (Array.isArray(av) && Array.isArray(bv) && av.length === bv.length) {
      /**
       * 只对**基础类型数组**做逐项比较（`stickyDoneIds` 就是这种）。
       * 任务数组不能这么做：500 条逐项比一次，等于把刚省下的那次 filter 又花回去了。
       */
      const primitive = av.length === 0 || typeof av[0] !== 'object';
      if (primitive) {
        let same = true;
        for (let k = 0; k < av.length; k += 1) {
          if (av[k] !== bv[k]) {
            same = false;
            break;
          }
        }
        if (same) continue;
      }
    }
    return false;
  }
  return true;
}

/**
 * 今日视图需要的全部派生数据。
 *
 * 返回对象的引用只在输入变化时改变 —— 这是 `TaskList` / `TaskRow` 的 `memo`
 * 能不能生效的前提。
 */
export function selectDayView(input: DayViewInput): DayView {
  const key = cacheKey(input);
  if (cache && sameKey(cache.key, key)) return cache.value;

  __dayViewScans += 1;

  // 一次取出当日任务：既给 progress，也给分组（内部不再重复 filter）
  const dayTasks = getTasksForDate(input.tasks, input.date);
  const group = groupFromDayTasks(dayTasks, input);
  const done = dayTasks.filter((t) => t.done).length;
  const total = dayTasks.length;
  const progress: DayProgress = {
    done,
    total,
    percent: total === 0 ? null : Math.round((done / total) * 100),
  };

  const value: DayView = { dayTasks, group, progress };
  cache = { key, value };
  return value;
}

/** 保持与 `getDayProgress` 完全同口径（供测试对撞） */
export function dayProgressOf(tasks: Task[], date: DateKey): DayProgress {
  return getDayProgress(tasks, date);
}
