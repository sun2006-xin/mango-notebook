import { sanitizeHabits } from '../../lib/sanitize';
import { toggleHabitCheck } from '../../lib/habits';
import { sameRows } from '../../lib/equal';
import type { AppAction } from '../actions';
import { patchSettings } from '../helpers';
import type { AppState, Habit } from '../../types';

/* ============================================================================
   习惯域（F12）

   数据住在 `settings.habits` / `settings.habitChecks`（理由见 types.ts 的注释：
   刻意不新增顶层集合，那样要动 SCHEMA_VERSION、migrate 链和备份格式）。

   单独一个文件而不是并进 domains/settings.ts：settings.ts 已经有近 300 行、
   管着十几项配置，习惯这一块是**一组带联动关系的字段**（删习惯要连带清打卡），
   放在一起会淹掉那条联动。
   ========================================================================= */

/**
 * 两份习惯列表是否等价 —— 用于 `SET_HABITS` 的幂等判断。
 *
 * ⚠️ 这里**刻意不再手抄字段清单**。
 *
 * 原始实现写了 `id / name / archivedAt / autoTask` 四行比较，加 `autoTask` 时
 * 漏了第四行，后果是**那个开关再也点不动**：reducer 判"内容没变"→ 返回同一个 state
 * → 界面上的开关弹回原样，而且不报错、不打日志。
 * 手抄清单与类型定义是两份代码，必然会漂移；改成按结构比之后，加字段自动纳入。
 *
 * 两侧都是 `sanitizeHabits` 的产物（state 装载时一次、action 进来再一次），
 * 字段形态已经归一，所以浅比较足够、也不会因为"某侧缺 key"而误判。
 */
function sameHabits(a: Habit[], b: Habit[]): boolean {
  return sameRows(a, b);
}

export function reduceHabits(state: AppState, action: AppAction): AppState | null {
  switch (action.type) {
    case 'SET_HABITS': {
      const habits = sanitizeHabits(action.habits);
      if (sameHabits(state.settings.habits, habits)) return state;

      /**
       * 删掉一个习惯时，它的打卡记录**和生成流水**都必须一起清 ——
       * 否则那些记录既不会被渲染，又会跟着云同步在设备之间来回传，永远删不干净。
       * 清理放在这里（而不是 UI），是因为任何一条改 habits 的路径都该享有同一口径。
       *
       * 生成流水（`habitTaskLog`）容易被漏：它不参与任何界面渲染，
       * 漏了不会有任何可见症状 —— 只会在云端载荷里越积越多。
       */
      const alive = new Set(habits.map((habit) => habit.id));
      const habitChecks = state.settings.habitChecks.filter((check) => alive.has(check.habitId));
      const habitTaskLog = state.settings.habitTaskLog.filter((entry) => alive.has(entry.habitId));

      return patchSettings(state, { habits, habitChecks, habitTaskLog });
    }

    case 'HABIT_TOGGLE_CHECK': {
      /**
       * 只允许给**存在的**习惯打卡：孤儿打卡是纯粹的数据垃圾
       * （sanitize 会把它丢掉，于是"点了没反应"——那比直接不动更让人困惑）。
       * 已归档的习惯也允许撤回/补记：历史补录是合理需求。
       */
      if (!state.settings.habits.some((habit) => habit.id === action.habitId)) return state;
      const habitChecks = toggleHabitCheck(
        state.settings.habitChecks,
        action.habitId,
        action.date,
      );
      if (habitChecks === state.settings.habitChecks) return state;
      return patchSettings(state, { habitChecks });
    }

    case 'SET_RECAP_SEEN': {
      if (typeof action.date !== 'string' || !action.date) return state;
      if (state.settings.lastRecapSeen === action.date) return state;
      return patchSettings(state, { lastRecapSeen: action.date });
    }

    default:
      return null;
  }
}
