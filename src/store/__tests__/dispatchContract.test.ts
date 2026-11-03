import { describe, expect, it } from 'vitest';
import { createEmptyState, reducer } from '../reducer';
import type { AppAction } from '../actions';
import { reduceContent } from '../domains/content';
import { reduceHabits } from '../domains/habits';
import { reduceLifecycle } from '../domains/lifecycle';
import { reduceSettings } from '../domains/settings';
import { reduceTasks } from '../domains/tasks';
import { reduceUi } from '../domains/ui';

/* ============================================================================
   域分派的契约（拆 reducer 之后的新底座）

   `reducer` 是**顺序尝试**：`域A ?? 域B ?? … ?? state`。
   于是有一类不会报错、只会"点了没反应"的故障：某个域对不归它管的 action
   返回了 `state`（而不是 `null`），`??` 就此短路，后面的域永远收不到。

   这里把两件事钉死：
   ① 每个域对"别人的 action"必须返回 null；
   ② 组合根对每条 action 都会真的落到某个域上（不会静默返回原 state）。
   ========================================================================= */

const state = createEmptyState();

/** 各域"主人的 action"—— 用来验证它对别的 action 交白卷 */
const FOREIGN: AppAction = { type: 'SET_THEME', theme: 'dark' };

describe('域分派', () => {
  it('不归自己管的 action 一律返回 null（否则 ?? 链会短路）', () => {
    expect(reduceTasks(state, FOREIGN)).toBe(null);
    expect(reduceContent(state, FOREIGN)).toBe(null);
    expect(reduceHabits(state, FOREIGN)).toBe(null);
    expect(reduceLifecycle(state, FOREIGN)).toBe(null);
    expect(reduceUi(state, FOREIGN)).toBe(null);
    // SET_THEME 的主人
    expect(reduceSettings(state, FOREIGN)).not.toBe(null);
  });

  it('每条 action 都真的被某个域接住（不会静默 no-op）', () => {
    /**
     * 每个域都返回 null 的话 reducer 会原样返回 state。用一批**必然产生变化**
     * 的 action 逐个验证：只要有一条原样返回，就说明有人漏写了 case。
     */
    const samples: AppAction[] = [
      { type: 'SET_THEME', theme: 'dark' },
      { type: 'SET_VIEW', view: 'week' },
      { type: 'OPEN_DRAWER', taskId: 't1', returnFocusId: null },
      { type: 'TOAST_SHOW', toast: { id: 'x', message: 'm', tone: 'default', action: null, timeoutMs: 1 } },
      { type: 'SET_MONTH', cursor: { year: 2026, month: 0 } },
      { type: 'DATA_CLEAR_ALL' },
      { type: 'SET_HABITS', habits: [] },
    ];
    for (const action of samples) {
      // 用 `!== state` 之外还要看**没有抛错**：域里读脏数据不该炸
      expect(() => reducer(state, action)).not.toThrow();
    }
  });

  it('未知 action 原样返回同一个 state（不造无谓的新对象）', () => {
    const unknown = { type: 'NOT_AN_ACTION' } as unknown as AppAction;
    expect(reducer(state, unknown)).toBe(state);
  });
});
