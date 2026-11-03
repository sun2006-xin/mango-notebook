import { useEffect } from 'react';
import { nowIso } from '../lib/date';
import { dueHabitTasks } from '../lib/habits';
import { useAppDispatch, useAppState } from '../store/StoreContext';
import type { DateKey } from '../types';

/* ============================================================================
   习惯 → 今日任务（长期迭代「习惯与任务联动」）

   什么时候生成：**挂载时 + 跨天时 + 用户刚打开开关时**。三种都落在同一个
   effect 里 —— 它依赖 `today` / `habits` / `habitTaskLog`，这三样任一变化
   都会重跑一次判定。

   为什么不会重复生成（这个问题必须先回答，否则就是一个刷屏 bug）：
   `dueHabitTasks` 只返回"今天还没派过"的习惯，而派过就会被写进
   `settings.habitTaskLog`。所以这一轮 dispatch 完，下一轮判定结果必为空，
   effect 自然停下 —— 自我终止，不需要额外的 ref 记"今天处理过了"。

   ⚠️ 为什么**不用** `useRef` 存一个 lastDate 来防重：
   那样"用户今天第一次打开开关"这个场景会被漏掉（日期没变，但该生成的东西
   变了）。用流水判定则天然覆盖它，而且跨设备也对（另一台已经派过的，
   同步过来之后这边不会再派一遍）。
   ========================================================================= */

export function useHabitAutoTask(today: DateKey): void {
  const { settings } = useAppState();
  const dispatch = useAppDispatch();
  const { habits, habitTaskLog } = settings;

  useEffect(() => {
    // 判定是纯函数且很便宜（8 个习惯上限），不值得为此加 memo
    const due = dueHabitTasks({ habits, habitTaskLog, date: today });
    if (due.length === 0) return;
    dispatch({ type: 'HABIT_TASK_GENERATE', date: today, now: nowIso() });
  }, [dispatch, today, habits, habitTaskLog]);
}
