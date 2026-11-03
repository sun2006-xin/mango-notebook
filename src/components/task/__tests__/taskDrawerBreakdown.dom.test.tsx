// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskDrawer } from '../TaskDrawer';
import type { Task } from '../../../types';

/* ============================================================================
   抽屉里的「智能拆解」按钮（长期迭代）

   拆解是**本地规则**（没有服务端、没有大模型），所以"怎么拆的"必须显示出来 ——
   拆错了用户要能看懂依据、知道该删哪几条。这个按钮最容易犯的错是
   "点了有反应但不说它干了什么"，所以断言的重点是那句回话而不是按钮本身。
   ========================================================================= */

const NOW = '2026-10-30T09:00:00.000Z';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: '背单词',
    note: '',
    date: '2026-10-30',
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

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
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
});

function render(onBreakdown?: () => { added: number; reason: string } | null): void {
  act(() => {
    root?.render(
      <TaskDrawer
        task={task()}
        open
        categories={[{ id: 'c1', name: '学习' }]}
        subtasks={[]}
        onClose={() => undefined}
        onPatch={() => undefined}
        onDelete={() => undefined}
        onToggleDone={() => undefined}
        onAddSubtask={() => undefined}
        onBreakdown={onBreakdown}
        onToggleSubtask={() => undefined}
      />,
    );
  });
}

describe('TaskDrawer · 智能拆解', () => {
  it('没传 onBreakdown → 不显示按钮（子任务入口仍可用）', () => {
    render(undefined);
    expect(container.querySelector('[data-testid="subtask-breakdown"]')).toBeNull();
  });

  it('点一下 → 显示"怎么拆的"和实际加了几条', () => {
    const onBreakdown = vi.fn(() => ({ added: 4, reason: '按「记忆」类任务拆成 4 步' }));
    render(onBreakdown);

    act(() => {
      (container.querySelector('[data-testid="subtask-breakdown"]') as HTMLElement).click();
    });

    expect(onBreakdown).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('按「记忆」类任务拆成 4 步');
    expect(container.textContent).toContain('加了 4 条');
  });

  /** 一条都没加的时候不能只说"拆成 4 步" —— 那是在撒谎 */
  it('一条都没加 → 原样显示原因，不谎报"加了 N 条"', () => {
    const onBreakdown = vi.fn(() => ({ added: 0, reason: '这几步都已经有了，没有再加' }));
    render(onBreakdown);

    act(() => {
      (container.querySelector('[data-testid="subtask-breakdown"]') as HTMLElement).click();
    });

    expect(container.textContent).toContain('这几步都已经有了，没有再加');
    expect(container.textContent).not.toContain('加了 0 条');
  });

  it('返回 null（任务不存在 / 不能拆）→ 不显示任何回话', () => {
    render(() => null);
    act(() => {
      (container.querySelector('[data-testid="subtask-breakdown"]') as HTMLElement).click();
    });
    expect(container.textContent).toContain('拆完还能改'); // 仍是初始提示语
  });
});
