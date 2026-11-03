// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskDrawer } from '../TaskDrawer';
import { createEmptyState, reducer } from '../../../store/reducer';
import type { AppAction } from '../../../store/actions';
import type { AppState, DateKey, Task } from '../../../types';

/* ============================================================================
   抽屉编辑的端到端验证：输入 → dispatch → reducer → 受控回填

   为什么必须端到端：抽屉里每个字段都是**受控输入**（`value={task.title}`）。
   链路任何一环断掉，表面症状都一样 ——"输入框里打不进字 / 打完又跳回去"，
   而用户只会说"任务无法编辑"。

   这条测试接的是**真 reducer**（不是假 store），所以能同时覆盖：
   ① TASK_PATCH 有没有被某个域吞掉；② normalizePatch 有没有把值删掉；
   ③ 回填时抽屉拿到的 task 是不是新对象。
   ========================================================================= */

let container: HTMLDivElement;
let root: Root;
let state: AppState;
let dispatch: (action: AppAction) => void;

const TODAY = '2026-10-30' as DateKey;

function seed(): AppState {
  const base = createEmptyState();
  const task: Task = {
    id: 't1',
    title: '高数第三章',
    note: '',
    date: TODAY,
    time: null,
    repeat: 'none',
    priority: 'medium',
    category: '学习',
    done: false,
    doneAt: null,
    createdAt: '2026-10-30T00:00:00.000Z',
    updatedAt: '2026-10-30T00:00:00.000Z',
    parentId: null,
    estimatedMinutes: 0,
  };
  return {
    ...base,
    tasks: [task],
    settings: { ...base.settings, lastSelectedDate: TODAY, categories: [{ id: 'c1', name: '学习' }] },
    ui: { ...base.ui, drawerTaskId: 't1' },
  };
}

function render(): void {
  act(() => {
    root.render(
      <Shell />,
    );
  });
}

/** 极简 store：useState 持有状态，dispatch 走真 reducer */
function Shell() {
  const [current, setCurrent] = useState<AppState>(seed);
  state = current;
  dispatch = (action) => setCurrent(reducer(current, action));
  const task = current.tasks.find((item) => item.id === current.ui.drawerTaskId) ?? null;
  return (
    <TaskDrawer
      task={task}
      open
      categories={current.settings.categories}
      subtasks={[]}
      onClose={() => {}}
      onPatch={(patch) => dispatch({ type: 'TASK_PATCH', id: 't1', patch, now: '2026-10-30T10:00:00.000Z' })}
      onDelete={() => {}}
      onToggleDone={() => {}}
    />
  );
}

function input(selector: string): HTMLInputElement | HTMLTextAreaElement {
  const element = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null;
  if (!element) throw new Error(`找不到 ${selector}`);
  return element;
}

function type(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  render();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('抽屉编辑（真 reducer）', () => {
  /**
   * v0.29.9 起标题 / 备注是**防抖提交**（350ms）：
   * 输入框立刻回显（打字不卡），落库延后。
   *
   * 所以这三条从"每次 onChange 都进 state"改成"**最终一定不丢**"：
   * 静默期结束后落库 + 卸载前补交。原来那条断言的其实是性能问题的成因本身。
   */
  it('改标题 → 输入框立刻回显，静默期后落进 state', () => {
    vi.useFakeTimers();
    try {
      type(input('#dr-title'), '高数第四章');
      // 立刻回显（这是"打字不卡"的前提）
      expect(input('#dr-title').value).toBe('高数第四章');
      // 还没到静默期：store 仍是旧值
      expect(state.tasks[0]?.title).toBe('高数第三章');

      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(state.tasks[0]?.title).toBe('高数第四章');
    } finally {
      vi.useRealTimers();
    }
  });

  it('逐字输入：打字不卡、且最后一句一定落到 state（防抖合并）', () => {
    vi.useFakeTimers();
    try {
      const box = input('#dr-title');
      for (const value of ['高', '高数', '高数第', '高数第四']) {
        type(box, value);
        expect(box.value).toBe(value); // 每次都能立刻看到自己打的字
        act(() => {
          vi.advanceTimersByTime(100); // 一直在静默期内，不落库
        });
      }
      expect(state.tasks[0]?.title).toBe('高数第三章');

      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(state.tasks[0]?.title).toBe('高数第四'); // 只提交最后一次
    } finally {
      vi.useRealTimers();
    }
  });

  it('改备注 → 静默期后落库', () => {
    vi.useFakeTimers();
    try {
      type(input('#dr-note'), 'P78 第 5 题');
      expect(input('#dr-note').value).toBe('P78 第 5 题');
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(state.tasks[0]?.note).toBe('P78 第 5 题');
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * 关抽屉那一刻的最后一个字也不能丢（v0.29.9 实测踩到过）。
   *
   * `patchDrawerTask` 的第一行是 `if (!ui.drawerTaskId) return`：一关抽屉，
   * 这个 id 就没了，任何**迟到**的提交都会被静默丢弃 —— 而防抖提交天然是迟到的。
   * 症状：改名后立刻点关闭，标题回到旧值（冒烟脚本当场抓到的）。
   * 修法是关闭前先 flush，这条用例守的就是那个顺序。
   */
  it('防抖还没到点就关闭 → 值仍然落进 state（关之前先补交）', () => {
    vi.useFakeTimers();
    try {
      type(input('#dr-title'), '关得太快了');
      // 计时器还没到点
      expect(state.tasks[0]?.title).toBe('高数第三章');

      const closeBtn = [...document.querySelectorAll('button')].find(
        (btn) => btn.getAttribute('aria-label') === '关闭',
      );
      expect(closeBtn, '没找到关闭按钮').toBeTruthy();
      act(() => closeBtn?.click());

      expect(state.tasks[0]?.title).toBe('关得太快了');
    } finally {
      vi.useRealTimers();
    }
  });

  it('改结束日 → 变成多天任务（区间落进 state）', () => {
    const endInput = document.querySelector('[data-testid="drawer-end-date"]') as HTMLInputElement | null;
    expect(endInput).not.toBeNull();
    type(endInput as HTMLInputElement, '2026-11-02');
    expect(state.tasks[0]?.date).toBe(TODAY);
    expect(state.tasks[0]?.endDate).toBe('2026-11-02');
  });

  it('把开始日推过结束日 → 自动收敛成单天（任务不会消失）', () => {
    const endInput = document.querySelector('[data-testid="drawer-end-date"]') as HTMLInputElement | null;
    type(endInput as HTMLInputElement, '2026-11-02');
    const startInput = document.querySelector('input[type="date"]') as HTMLInputElement;
    type(startInput, '2026-11-05');
    expect(state.tasks[0]?.endDate).toBe(null);
  });

  it('改日期 → 状态更新', () => {
    const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement | null;
    expect(dateInput).not.toBeNull();
    type(dateInput as HTMLInputElement, '2026-11-02');
    expect(state.tasks[0]?.date).toBe('2026-11-02');
  });
});
