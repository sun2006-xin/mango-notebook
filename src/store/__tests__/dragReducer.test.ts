import { describe, expect, it } from 'vitest';
import { createEmptyState, reducer, type AppAction } from '../reducer';
import { planTaskMove } from '../../lib/drag';
import { compareOpenTasks, taskOrder } from '../../lib/task';
import type { AppState, DateKey, Task } from '../../types';

/* ============================================================================
   拖拽在 reducer 层的语义（纯逻辑，无需 DOM）
   ========================================================================= */

const NOW = '2026-11-02T09:00:00.000Z';
const D1 = '2026-11-02' as DateKey;
const D2 = '2026-11-03' as DateKey;

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: '数学真题',
    note: '',
    date: D1,
    time: null,
    repeat: 'none',
    priority: 'medium',
    category: '学习',
    done: false,
    doneAt: null,
    parentId: null,
    estimatedMinutes: 0,
    createdAt: NOW,
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

function withTasks(tasks: Task[]): AppState {
  const base = createEmptyState();
  return { ...base, tasks, settings: { ...base.settings, lastSelectedDate: D1 } };
}

const run = (state: AppState, action: AppAction): AppState => reducer(state, action);

/** 某天的顶层任务按视觉顺序的 id */
function order(tasks: Task[], date: DateKey): string[] {
  return tasks.filter((t) => t.date === date && !t.parentId).sort(compareOpenTasks).map((t) => t.id);
}

describe('TASK_MOVE', () => {
  it('落点无效 → 返回同一个 state（不写盘、不同步）', () => {
    const s0 = withTasks([task({ id: 'a' }), task({ id: 'b' })]);
    const s1 = run(s0, { type: 'TASK_MOVE', id: 'a', target: { kind: 'before', date: D1, beforeId: 'b' }, now: NOW });
    expect(Object.is(s0, s1)).toBe(true);
  });

  it('改日期 + 刷新 updatedAt', () => {
    const s0 = withTasks([task({ id: 'a', date: D1 })]);
    const s1 = run(s0, { type: 'TASK_MOVE', id: 'a', target: { kind: 'day', date: D2 }, now: NOW });
    expect(s1.tasks[0]?.date).toBe(D2);
    expect(s1.tasks[0]?.updatedAt).toBe(NOW);
  });

  it('子任务跟着父任务一起改日期', () => {
    const s0 = withTasks([
      task({ id: 'p', date: D1 }),
      task({ id: 'c', date: D1, parentId: 'p' }),
    ]);
    const s1 = run(s0, { type: 'TASK_MOVE', id: 'p', target: { kind: 'day', date: D2 }, now: NOW });
    expect(s1.tasks.map((t) => t.date)).toEqual([D2, D2]);
  });

  it('列表内排序：目标日转成连续编号', () => {
    const s0 = withTasks([
      task({ id: 'a', date: D1 }),
      task({ id: 'b', date: D1 }),
      task({ id: 'c', date: D1 }),
    ]);
    const s1 = run(s0, { type: 'TASK_MOVE', id: 'c', target: { kind: 'before', date: D1, beforeId: 'a' }, now: NOW });
    expect(order(s1.tasks, D1)).toEqual(['c', 'a', 'b']);
    expect(s1.tasks.map((t) => taskOrder(t)).sort()).toEqual([1, 2, 3]);
  });
});

describe('拖拽撤销（端到端往返）', () => {
  it('排序位与日期一起还原，且还原后视觉顺序与拖拽前逐条一致', () => {
    const before = [
      task({ id: 'a', date: D1, order: 1, createdAt: '2026-11-01T00:00:00.000Z' }),
      task({ id: 'b', date: D1, order: 2, createdAt: '2026-11-01T00:00:01.000Z' }),
      task({ id: 'c', date: D1, order: 3, createdAt: '2026-11-01T00:00:02.000Z' }),
    ];
    const s0 = withTasks(before);
    const target = { kind: 'before', date: D1, beforeId: 'a' } as const;
    const plan = planTaskMove(before, 'c', target, NOW);

    const s1 = run(s0, { type: 'TASK_MOVE', id: 'c', target, now: NOW });
    expect(order(s1.tasks, D1)).toEqual(['c', 'a', 'b']);

    const s2 = run(s1, { type: 'TASK_UNDO_MOVE', moves: plan.moves, now: NOW });
    expect(order(s2.tasks, D1)).toEqual(['a', 'b', 'c']);
    expect(s2.tasks.map((t) => taskOrder(t))).toEqual([1, 2, 3]);
  });

  it('跨天移动的撤销把任务放回原来那天', () => {
    const before = [task({ id: 'a', date: D1 }), task({ id: 'x', date: D2, order: 1 })];
    const s0 = withTasks(before);
    const target = { kind: 'day', date: D2 } as const;
    const plan = planTaskMove(before, 'a', target, NOW);

    const s1 = run(s0, { type: 'TASK_MOVE', id: 'a', target, now: NOW });
    expect(order(s1.tasks, D2)).toEqual(['x', 'a']);

    const s2 = run(s1, { type: 'TASK_UNDO_MOVE', moves: plan.moves, now: NOW });
    expect(s2.tasks.find((t) => t.id === 'a')?.date).toBe(D1);
  });
});

describe('TASK_ADD 的排序位补发', () => {
  it('这天没排过 → 0（保持自动排序，行为与加排序功能前一致）', () => {
    const s0 = withTasks([task({ id: 'a', date: D1 })]);
    const s1 = run(s0, { type: 'TASK_ADD', task: task({ id: 'new', date: D1 }) });
    expect(taskOrder(s1.tasks[1] as Task)).toBe(0);
  });

  it('这天排过 → max+1（排队尾，不顶掉用户排好的顺序）', () => {
    const s0 = withTasks([
      task({ id: 'a', date: D1, order: 1 }),
      task({ id: 'b', date: D1, order: 2 }),
    ]);
    const s1 = run(s0, { type: 'TASK_ADD', task: task({ id: 'new', date: D1 }) });
    expect(taskOrder(s1.tasks[2] as Task)).toBe(3);
    expect(order(s1.tasks, D1)).toEqual(['a', 'b', 'new']);
  });

  it('子任务恒为 0（它只在父任务底下与兄弟排序）', () => {
    const s0 = withTasks([task({ id: 'p', date: D1, order: 1 })]);
    const s1 = run(s0, { type: 'TASK_ADD', task: task({ id: 'c', date: D1, parentId: 'p' }) });
    expect(taskOrder(s1.tasks[1] as Task)).toBe(0);
  });

  it('从回收站恢复也补发（否则 0 会让它跳到列表最前面）', () => {
    const s0: AppState = {
      ...withTasks([task({ id: 'a', date: D1, order: 1 }), task({ id: 'b', date: D1, order: 2 })]),
      tombstones: [{ id: 'gone', deletedAt: NOW, title: '恢复了', date: D1, index: 2 }],
    };
    const s1 = run(s0, { type: 'TOMBSTONE_RESTORE', id: 'gone', now: NOW });
    expect(taskOrder(s1.tasks[2] as Task)).toBe(3);
    expect(order(s1.tasks, D1)).toEqual(['a', 'b', 'gone']);
  });
});
