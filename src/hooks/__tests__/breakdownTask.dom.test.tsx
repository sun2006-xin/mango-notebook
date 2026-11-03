// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* ============================================================================
   拆解 → 子任务（长期迭代「任务拆解」的落库环）

   规则在 `lib/breakdown.ts`（纯函数，已单独测）。这里测的是**接线**：
   拆出来的每一步有没有真的变成一条子任务，而且带对该带的东西
   （`parentId` / 父任务的日期 / 自己的估时）。

   两个容易漏、漏了又很难发现的点：
   ① 子任务必须带 `parentId` —— 不带就变成当天的顶层任务，用户看到的是
      "拆了一下，清单里多出四条散的任务"；
   ② 同标题的步骤要跳过 —— 不给的话连点两次就出两份，用户只能一条条删。
   ========================================================================= */

const mocks = vi.hoisted(() => ({
  state: null as unknown,
  dispatch: vi.fn(),
  toast: { show: vi.fn(), dismiss: vi.fn() },
}));

vi.mock('../../store/StoreContext', () => ({
  useAppState: () => mocks.state,
  useAppDispatch: () => mocks.dispatch,
}));
vi.mock('../useToast', () => ({ useToast: () => mocks.toast }));

const { useTaskActions } = await import('../useTaskActions');
const { createDefaultSettings } = await import('../../constants');

const TODAY = '2026-10-24';
const NOW = '2026-10-24T09:00:00.000Z';

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1',
    title: '背单词',
    note: '',
    date: TODAY,
    time: null,
    repeat: 'none',
    priority: 'medium',
    category: '学习',
    done: false,
    doneAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    parentId: null,
    estimatedMinutes: 0,
    order: 0,
    ...overrides,
  };
}

function setState(tasks: unknown[]): void {
  mocks.state = {
    tasks,
    notes: [],
    diary: [],
    focusSessions: [],
    tombstones: [],
    settings: createDefaultSettings(TODAY),
    ui: {
      drawerTaskId: null,
      drawerReturnFocusId: null,
      monthCursor: { year: 2026, month: 9 },
      toast: null,
      stickyDoneIds: [],
      saveState: 'idle',
      storageError: null,
      hydrating: false,
    },
  };
}

let container: HTMLDivElement;
let root: Root | null = null;
let actions: ReturnType<typeof useTaskActions> | null = null;

function Probe(): null {
  actions = useTaskActions(TODAY);
  return null;
}

beforeEach(() => {
  mocks.dispatch.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  container.remove();
  actions = null;
});

function mount(): void {
  act(() => {
    root?.render(<Probe />);
  });
}

describe('breakdownTask', () => {
  it('把每条步骤变成子任务（带 parentId、父任务日期、自己的估时）', () => {
    setState([task({ title: '背单词', estimatedMinutes: 60 })]);
    mount();

    let result: { added: number; reason: string } | null = null;
    act(() => {
      result = actions?.breakdownTask('t1') ?? null;
    });

    expect(result).not.toBeNull();
    expect(result!.added).toBe(4);
    expect(result!.reason).toContain('记忆');

    expect(mocks.dispatch).toHaveBeenCalledTimes(4);
    const added = mocks.dispatch.mock.calls.map((call) => call[0] as Record<string, unknown>);
    for (const action of added) {
      expect(action.type).toBe('TASK_ADD');
      const payload = action.task as Record<string, unknown>;
      expect(payload.parentId).toBe('t1');
      expect(payload.date).toBe(TODAY);
    }
    const total = added.reduce(
      (sum, action) => sum + Number((action.task as { estimatedMinutes: number }).estimatedMinutes),
      0,
    );
    expect(total).toBe(60); // 拆完估时总和不变，今日预算不会膨胀
  });

  it('同标题的步骤已经存在 → 那一步跳过（4 步只加 3 条）', () => {
    setState([
      task({ title: '背单词' }),
      task({ id: 's1', title: '过一遍新词', parentId: 't1' }),
    ]);
    mount();

    let result: { added: number; reason: string } | null = null;
    act(() => {
      result = actions?.breakdownTask('t1') ?? null;
    });

    expect(result!.added).toBe(3);
    expect(mocks.dispatch).toHaveBeenCalledTimes(3);
    const titles = mocks.dispatch.mock.calls.map(
      (call) => (call[0] as { task: { title: string } }).task.title,
    );
    expect(titles).not.toContain('过一遍新词');
  });

  it('所有步骤都已存在 → 一条都不加，并说明原因', () => {
    setState([
      task({ title: '背单词' }),
      task({ id: 's1', title: '过一遍新词', parentId: 't1' }),
      task({ id: 's2', title: '遮住中文回想', parentId: 't1' }),
      task({ id: 's3', title: '默写或跟读一遍', parentId: 't1' }),
      task({ id: 's4', title: '标出没记住的', parentId: 't1' }),
    ]);
    mount();

    let result: { added: number; reason: string } | null = null;
    act(() => {
      result = actions?.breakdownTask('t1') ?? null;
    });
    expect(result!.added).toBe(0);
    expect(result!.reason).toContain('都已经有了');
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('目标是子任务 → null（只准一层，不再往下拆）', () => {
    setState([task({ title: '背单词' }), task({ id: 's1', title: '过一遍新词', parentId: 't1' })]);
    mount();

    let result: unknown = 'unset';
    act(() => {
      result = actions?.breakdownTask('s1');
    });
    expect(result).toBeNull();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('任务不存在 → null', () => {
    setState([]);
    mount();

    let result: unknown = 'unset';
    act(() => {
      result = actions?.breakdownTask('nope');
    });
    expect(result).toBeNull();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('标题为空 → 0 条，并说明原因（不静默无反应）', () => {
    setState([task({ title: '   ' })]);
    mount();

    let result: { added: number; reason: string } | null = null;
    act(() => {
      result = actions?.breakdownTask('t1') ?? null;
    });
    expect(result!.added).toBe(0);
    expect(result!.reason).toContain('标题为空');
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
});
