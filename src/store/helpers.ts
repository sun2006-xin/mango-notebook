import { isValidDateKey } from '../lib/date';
import { sameRows } from '../lib/equal';
import { clampEstimateMinutes } from '../lib/task';
import type { AppState, DiaryEntry, ExamGoal, Priority, Settings, Task } from '../types';

/* ============================================================================
   reducer 各域共用的纯工具

   为什么单独一个文件：`patchSettings` 的存在意义就是"改 settings 只有一条路"，
   它一旦被复制进 domains/settings.ts 之外的地方，那条纪律就没了。
   所以放在谁都能 import、但只有一份的地方。
   ========================================================================= */

/**
 * 改 settings 的**唯一写法**。
 *
 * `{ ...state, settings: { ...state.settings, x } }` 这个模式曾经在 reducer 里
 * 手抄了十几次 —— 每次都要记得同时展开 state 和 settings，漏一层就是
 * "改主题顺手把抽屉/光标状态清了"这类幽灵 bug。收敛成一个函数，改法只有一条路。
 */
export function patchSettings(state: AppState, patch: Partial<Settings>): AppState {
  return { ...state, settings: { ...state.settings, ...patch } };
}

export const withoutId = (ids: string[], id: string): string[] => ids.filter((x) => x !== id);

/** 日记按日期倒序（新在前），保证渲染顺序稳定可测 */
export function sortDiary(entries: DiaryEntry[]): DiaryEntry[] {
  return [...entries].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

const PRIORITIES: Priority[] = ['high', 'medium', 'low'];

/**
 * 补丁过滤：title 空则忽略该字段；note/time/priority/category/estimatedMinutes 逐项兜底。
 *
 * `estimatedMinutes` 必须在这里夹紧，不能只靠 UI 的 `min/max`：
 * 数字输入框在部分浏览器里允许手打 `1e9`，而且设置会经云同步从别的设备过来。
 * 口径与 storage.sanitizeTasks 完全一致（同一个 clampEstimateMinutes）。
 */
function normalizePatch(patch: Partial<Task>): Partial<Task> {
  const next: Partial<Task> = { ...patch };
  if ('title' in next) {
    const title = String(next.title ?? '').trim();
    if (!title) delete next.title;
    else next.title = title;
  }
  if ('priority' in next && !PRIORITIES.includes(next.priority as Priority)) {
    delete next.priority;
  }
  if ('estimatedMinutes' in next) {
    next.estimatedMinutes = clampEstimateMinutes(next.estimatedMinutes);
  }
  /**
   * 日期必须过格式校验。
   *
   * 抽屉里的 `<input type="date">` 被清空时给的是**空串**，而 `patch` 只是转发 ——
   * 于是 `task.date = ''` 能直接进 state：按日分组全找不到它（今日/周/日历都不显示），
   * 但 `taskLastDate() < today` 又让它被判成逾期，逾期行的时间列渲染出
   * `NaN年NaN月NaN日`。下次冷启动 `sanitizeTasks` 才会把它悄悄搬到"今天"，
   * 用户看到的是"昨天那条任务自己跳到今天了"。
   *
   * 这里丢掉非法值（保留原日期），比"写进一个谁也看不见的日期"安全得多。
   */
  if ('date' in next && !isValidDateKey(String(next.date ?? ''))) delete next.date;
  if ('endDate' in next) {
    const end = next.endDate;
    if (end !== null && end !== undefined && !isValidDateKey(String(end))) delete next.endDate;
  }
  return next;
}

export function patchTask(tasks: Task[], id: string, patch: Partial<Task>, now: string): Task[] {
  const normalized = normalizePatch(patch);
  let changed = false;
  const next = tasks.map((task) => {
    if (task.id !== id) return task;
    changed = true;
    const merged: Task = { ...task, ...normalized, updatedAt: now };
    /**
     * 多天任务的区间必须在**合并之后**再收敛一次。
     *
     * 只改 `date`（把开始日往后推）或只改 `endDate`（往前收）都可能让
     * `endDate < date`。留着这种数据，`taskCoversDate` 永不成立 ——
     * 任务会从所有视图里**静默消失**，而数据还在（用户只会觉得"我的任务没了"）。
     * 收敛成单天（endDate = date → null）比消失好一万倍。
     */
    if (merged.endDate && !(merged.endDate > merged.date)) {
      merged.endDate = null;
    }
    return merged;
  });
  return changed ? next : tasks;
}

/**
 * 两份目标列表是否等价 —— 用于 `SET_GOALS` 的幂等判断。
 *
 * 曾经的实现手抄了 `id / name / date` 三个字段。当时正好等于 `ExamGoal` 的全部字段，
 * 所以没出事；但只要 `ExamGoal` 加一个可编辑字段（比如备注），
 * 那个字段就会变成**改不动**（reducer 判"没变"→ 返回同一个 state → 界面弹回）。
 * 现在按结构比，不再维护清单。
 */
export function sameGoals(a: ExamGoal[], b: ExamGoal[]): boolean {
  return sameRows(a, b);
}
