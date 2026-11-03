import { stampChangedFields } from '../lib/fieldClock';
import type { AppState } from '../types';

/* ============================================================================
   reducer 收尾：给改动过的任务字段打时间戳
   ----------------------------------------------------------------------------
   为什么放在 reducer 出口统一做，而不是让每个 action 自己写：

   域文件里有 40 多处会改任务（TASK_PATCH / TOGGLE / MOVE / MOVE_TO_TODAY /
   UNDO_MOVE / RESTORE / WEEK_PLAN_APPLY / …，还有 lib 里的 applyTaskToggle、
   applyTaskMove、patchTask）。逐个手写 `fieldAt` 打点**必然漏**，而且漏了
   编译不报错、界面看不出来 —— 只在"我在手机上改的备注被电脑的改动吃掉了"
   时暴露（和当初漏 persistDeps 的日记是同一类事故）。

   放在这里只需要守住一条性质：**只要可同步字段真的变了，就一定有对应时钟**。
   由 `src/store/__tests__/fieldClock.test.ts` 对多类 action 逐条验证。
   ========================================================================= */

/**
 * 给 `next.tasks` 里"内容确实变了"的任务补上字段时钟。
 *
 * 三条早退，保证绝大多数 dispatch 零成本：
 * - `tasks` 数组引用没变（改设置 / 改 ui）→ 直接返回；
 * - 任务对象引用没变（没被这条 action 碰过）→ 原样返回；
 * - 值一个字段都没变（对象被无意义重建）→ 原样返回，**不写时钟**
 *   （写了就等于把所有字段的时间往前推，字段级合并会退化成整条 LWW）。
 *
 * 新插入的任务（`before` 里没有）**不打点**：新建 / 从回收站恢复的任务
 * 应当保持"整条都算 updatedAt"，由合并侧回落到 `updatedAt` 即可；
 * 在这里补点反而会把 HYDRATE 装进来的既有字段时间全部压平
 * （装载时 prev.tasks 是空数组，每条都算"新插入"）。
 */
export function withFieldClocks(prev: AppState, next: AppState): AppState {
  if (next.tasks === prev.tasks) return next;
  if (next.tasks.length === 0) return next;

  const before = new Map(prev.tasks.map((task) => [task.id, task]));
  let touched = false;
  const tasks = next.tasks.map((task) => {
    const old = before.get(task.id);
    if (!old || old === task) return task;
    const stamps = stampChangedFields(old, task);
    if (!stamps) return task;
    touched = true;
    return { ...task, fieldAt: { ...task.fieldAt, ...stamps } };
  });

  return touched ? { ...next, tasks } : next;
}
