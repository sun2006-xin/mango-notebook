import { describe, expect, it } from 'vitest';
import {
  applyTaskMove,
  edgeScrollVelocity,
  nextOrderForDate,
  planTaskMove,
  resolveDropTarget,
  sameDropTarget,
} from '../drag';
import type { DropBox, DropGeometry } from '../drag';
import { compareOpenTasks, createTask, taskOrder } from '../task';
import { sanitizeTasks } from '../sanitize';
import type { DateKey, Task } from '../../types';

/* ============================================================================
   拖拽的纯逻辑。
   本项目的测试环境没有 DOM，交互层（useDragSort）没法在这里验证；
   所以真正会出错的部分 —— 插到哪、编号怎么发、撤销还原什么 —— 全部压在这里钉死。
   ========================================================================= */

const D1 = '2026-11-02' as DateKey;
const D2 = '2026-11-03' as DateKey;
const NOW = '2026-11-02T09:00:00.000Z';

function mk(id: string, date: DateKey, extra: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    note: '',
    date,
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
    ...extra,
  };
}

function ids(tasks: Task[], date: DateKey): string[] {
  return tasks.filter((t) => t.date === date && !t.parentId).sort(compareOpenTasks).map((t) => t.id);
}

describe('taskOrder / nextOrderForDate / isOrderedDay', () => {
  it('缺省 / 非法一律 0（0 = 未手动排过，走自动排序）', () => {
    expect(taskOrder(mk('a', D1))).toBe(0);
    expect(taskOrder(mk('a', D1, { order: Number.NaN }))).toBe(0);
  });

  it('没排过的日子新建任务拿 0 —— 保持自动排序，不会把九点的任务挤到后面', () => {
    const tasks = [mk('a', D1), mk('b', D1)];
    expect(nextOrderForDate(tasks, D1)).toBe(0);
    expect(nextOrderForDate(tasks, D1)).toBe(0);
  });

  it('排过的日子新建任务拿 max+1 —— 排队尾，不顶掉用户排好的顺序', () => {
    const tasks = [mk('a', D1, { order: 1 }), mk('b', D1, { order: 2 })];
    expect(nextOrderForDate(tasks, D1)).toBe(3);
    expect(nextOrderForDate(tasks, D1)).toBe(3);
  });

  it('子任务不参与当天的顶层编号', () => {
    const tasks = [mk('p', D1, { order: 5 }), mk('c', D1, { parentId: 'p', order: 9 })];
    expect(nextOrderForDate(tasks, D1)).toBe(6);
  });
});

describe('planTaskMove · 改日期', () => {
  it('拖到另一天：只改日期，那天的排序方式不变', () => {
    const tasks = [mk('a', D1), mk('b', D2, { order: 1 }), mk('c', D2, { order: 2 })];
    const plan = planTaskMove(tasks, 'a', { kind: 'day', date: D2 }, NOW);
    expect(ids(plan.tasks, D2)).toEqual(['b', 'c', 'a']);
    // 没重排：b / c 的编号原样
    expect(plan.tasks.find((t) => t.id === 'b')?.order).toBe(1);
    expect(plan.tasks.find((t) => t.id === 'c')?.order).toBe(2);
    /* 挪进一个"已经手动排过序"的日子 → 排队尾（max+1）。
       沿用旧的 0 会让它跳过队插到最前面，把那天排好的顺序顶乱。 */
    expect(plan.tasks.find((t) => t.id === 'a')?.order).toBe(3);
  });

  it('挪进没排过序的日子 → 保持 0，让那天的自动排序去安排它', () => {
    const tasks = [mk('a', D1), mk('b', D2, { time: '09:00' }), mk('c', D2)];
    const plan = planTaskMove(tasks, 'a', { kind: 'day', date: D2 }, NOW);
    expect(taskOrder(plan.tasks.find((t) => t.id === 'a') as Task)).toBe(0);
    // 没时间的 a 落在有时间的 b 之后、与 c 之间按创建序 —— 自动排序的原有口径不变
    expect(ids(plan.tasks, D2)).toEqual(['b', 'a', 'c']);
  });

  it('子任务跟着父任务改日期（父改子不改，子会从父底下消失）', () => {
    const tasks = [mk('p', D1), mk('c1', D1, { parentId: 'p' }), mk('c2', D1, { parentId: 'p' })];
    const plan = planTaskMove(tasks, 'p', { kind: 'day', date: D2 }, NOW);
    expect(plan.tasks.filter((t) => t.date === D2).map((t) => t.id)).toEqual(['p', 'c1', 'c2']);
  });

  it('不存在的 id / 空日期 → 原样返回同一个引用', () => {
    const tasks = [mk('a', D1)];
    expect(planTaskMove(tasks, 'nope', { kind: 'day', date: D2 }, NOW).tasks).toBe(tasks);
    expect(planTaskMove(tasks, 'a', { kind: 'day', date: '' as DateKey }, NOW).tasks).toBe(tasks);
  });
});

describe('planTaskMove · 手动排序', () => {
  it('插到某条之前 → 目标日整段连续编号 1..n', () => {
    const tasks = [mk('a', D1), mk('b', D1), mk('c', D1)];
    const plan = planTaskMove(tasks, 'c', { kind: 'before', date: D1, beforeId: 'a' }, NOW);
    expect(ids(plan.tasks, D1)).toEqual(['c', 'a', 'b']);
    // 编号按**新顺序**连续发（数组本身的下标顺序不变，所以按 id 查）
    expect(plan.tasks.map((t) => `${t.id}:${taskOrder(t)}`)).toEqual(['a:2', 'b:3', 'c:1']);
  });

  it('放到末尾（end）→ 排到最后一位', () => {
    const tasks = [mk('a', D1), mk('b', D1), mk('c', D1)];
    const plan = planTaskMove(tasks, 'a', { kind: 'end', date: D1 }, NOW);
    expect(ids(plan.tasks, D1)).toEqual(['b', 'c', 'a']);
  });

  it('beforeId 不存在 → 落末尾，而不是插到下标 -1', () => {
    const tasks = [mk('a', D1), mk('b', D1)];
    const plan = planTaskMove(tasks, 'a', { kind: 'before', date: D1, beforeId: 'gone' }, NOW);
    expect(ids(plan.tasks, D1)).toEqual(['b', 'a']);
  });

  it('**拖回原位必须是真的没发生**（不重排、不写盘、不弹提示）', () => {
    const tasks = [mk('a', D1), mk('b', D1), mk('c', D1)];
    // a 本来就在 b 前面，再"插到 b 前面" = 原地不动
    const plan = planTaskMove(tasks, 'a', { kind: 'before', date: D1, beforeId: 'b' }, NOW);
    expect(plan.tasks).toBe(tasks);
    expect(plan.moves).toEqual([]);
  });

  it('空日不转手动排序（只有一条时编号毫无意义）', () => {
    const tasks = [mk('a', D1)];
    const plan = planTaskMove(tasks, 'a', { kind: 'end', date: D1 }, NOW);
    expect(plan.tasks).toBe(tasks);
  });

  it('只重排目标日，其余日子的编号一概不动', () => {
    const tasks = [mk('a', D1, { order: 1 }), mk('x', D2, { order: 1 }), mk('y', D2, { order: 2 })];
    const plan = planTaskMove(tasks, 'a', { kind: 'end', date: D2 }, NOW);
    expect(taskOrder(plan.tasks.find((t) => t.id === 'x') as Task)).toBe(1);
    expect(taskOrder(plan.tasks.find((t) => t.id === 'y') as Task)).toBe(2);
    expect(ids(plan.tasks, D2)).toEqual(['x', 'y', 'a']);
  });

  it('数组长度与其它任务的引用都不变（没被碰过的行不该重渲）', () => {
    const other = mk('z', D2);
    const tasks = [mk('a', D1), mk('b', D1), other];
    const plan = planTaskMove(tasks, 'a', { kind: 'before', date: D1, beforeId: 'b' }, NOW);
    expect(plan.tasks).toHaveLength(3);
    expect(plan.tasks[2]).toBe(other);
  });
});

describe('planTaskMove · 撤销快照', () => {
  it('快照含**所有**被改编号的任务，不只被拖的那条', () => {
    const tasks = [mk('a', D1, { order: 1 }), mk('b', D1, { order: 2 }), mk('c', D1, { order: 3 })];
    const plan = planTaskMove(tasks, 'c', { kind: 'before', date: D1, beforeId: 'a' }, NOW);
    expect(plan.moves).toEqual([
      { id: 'a', from: D1, order: 1, endDate: null },
      { id: 'b', from: D1, order: 2, endDate: null },
      { id: 'c', from: D1, order: 3, endDate: null },
    ]);
  });

  it('跨天移动的快照带上原来的那一天', () => {
    const tasks = [mk('a', D1), mk('b', D2)];
    const plan = planTaskMove(tasks, 'a', { kind: 'day', date: D2 }, NOW);
    expect(plan.moves).toEqual([{ id: 'a', from: D1, order: 0, endDate: null }]);
  });

  it('快照不含只被刷新 updatedAt 的任务', () => {
    const tasks = [mk('a', D1), mk('b', D2)];
    const plan = planTaskMove(tasks, 'a', { kind: 'day', date: D1 }, NOW);
    expect(plan.moves).toEqual([]);
    expect(plan.tasks).toBe(tasks);
  });
});

describe('resolveDropTarget（纯几何）', () => {
  function geo(days: DropBox[], rows: DropBox[], draggedId: string): DropGeometry {
    return { days, rows, draggedId };
  }
  const day = (date: string, box: Partial<DropBox> = {}): DropBox => ({
    key: date,
    date: date as DateKey,
    top: 0,
    bottom: 400,
    left: 0,
    right: 200,
    ...box,
  });
  const row = (id: string, date: string, top: number): DropBox => ({
    key: id,
    date: date as DateKey,
    top,
    bottom: top + 48,
    left: 0,
    right: 200,
  });

  it('落在第一行上半 → 插到它前面', () => {
    const g = geo([day(D1)], [row('a', D1, 0), row('b', D1, 48)], 'c');
    expect(resolveDropTarget(g, 100, 10)).toEqual({ kind: 'before', date: D1, beforeId: 'a' });
  });

  it('越过中线才算插到下一行前面（比用上沿更符合直觉）', () => {
    const g = geo([day(D1)], [row('a', D1, 0), row('b', D1, 48)], 'c');
    // y=40 还在 a 的中线(24)之下 → 插到 b 前面
    expect(resolveDropTarget(g, 100, 40)).toEqual({ kind: 'before', date: D1, beforeId: 'b' });
  });

  it('落在最后一行下面但仍在列内 → 末尾', () => {
    const g = geo([day(D1)], [row('a', D1, 0), row('b', D1, 48)], 'c');
    expect(resolveDropTarget(g, 100, 300)).toEqual({ kind: 'end', date: D1 });
  });

  it('空列 → 只改日期（保持那天的自动排序）', () => {
    const g = geo([day(D1)], [], 'c');
    expect(resolveDropTarget(g, 100, 300)).toEqual({ kind: 'day', date: D1 });
  });

  it('落在所有列之外 → null（松手无效）', () => {
    const g = geo([day(D1)], [row('a', D1, 0)], 'c');
    expect(resolveDropTarget(g, 900, 10)).toBeNull();
  });

  it('被拖的那条自己不参与插入位判定', () => {
    const g = geo([day(D1)], [row('a', D1, 0), row('b', D1, 48)], 'a');
    expect(resolveDropTarget(g, 100, 10)).toEqual({ kind: 'before', date: D1, beforeId: 'b' });
  });

  it('先找列再找行：另一天的行不会干扰判定', () => {
    const g = geo(
      [day(D1, { left: 0, right: 100 }), day(D2, { left: 100, right: 200 })],
      [row('a', D1, 0), row('x', D2, 0)],
      'c',
    );
    expect(resolveDropTarget(g, 150, 10)).toEqual({ kind: 'before', date: D2, beforeId: 'x' });
  });
});

describe('sameDropTarget', () => {
  it('null 与 null 相同；落点没变就不 setState', () => {
    expect(sameDropTarget(null, null)).toBe(true);
    expect(sameDropTarget(null, { kind: 'end', date: D1 })).toBe(false);
    expect(sameDropTarget({ kind: 'before', date: D1, beforeId: 'a' }, { kind: 'before', date: D1, beforeId: 'a' })).toBe(true);
    expect(sameDropTarget({ kind: 'before', date: D1, beforeId: 'a' }, { kind: 'before', date: D1, beforeId: 'b' })).toBe(false);
    expect(sameDropTarget({ kind: 'end', date: D1 }, { kind: 'end', date: D2 })).toBe(false);
  });
});

describe('存储层保序', () => {
  it('sanitizeTasks 保留 order；负数 / 非法归 0', () => {
    const list = sanitizeTasks([
      { id: 'a', title: 'A', date: D1, order: 3 },
      { id: 'b', title: 'B', date: D1, order: -2 },
      { id: 'c', title: 'C', date: D1, order: 'x' },
      { id: 'd', title: 'D', date: D1 },
    ]);
    expect(list.map((t) => t.order)).toEqual([3, 0, 0, 0]);
  });

  it('createTask 新建给 0（真正的号由 reducer 按当天现状补发）', () => {
    expect(createTask({ title: 'x', date: D1 }, NOW, D1).order).toBe(0);
  });
});

describe('applyTaskMove 是 planTaskMove 的便捷包装', () => {
  it('无变化时返回原引用', () => {
    const tasks = [mk('a', D1)];
    expect(applyTaskMove(tasks, 'a', { kind: 'end', date: D1 }, NOW)).toBe(tasks);
  });
});

describe('edgeScrollVelocity（边缘自动滚动）', () => {
  const H = 800; // 视口高 800，触发区 72

  it('视口中部不滚', () => {
    expect(edgeScrollVelocity(400, 0, H)).toBe(0);
    expect(edgeScrollVelocity(100, 0, H)).toBe(0);
    expect(edgeScrollVelocity(700, 0, H)).toBe(0);
  });

  it('顶部触发区 → 负数（向上滚），越贴边越快', () => {
    const near = edgeScrollVelocity(60, 0, H); // 刚进触发区
    const deep = edgeScrollVelocity(5, 0, H); // 快贴边
    expect(near).toBeLessThan(0);
    expect(deep).toBeLessThan(near);
    // 贴到最上沿 = 满速
    expect(edgeScrollVelocity(0, 0, H)).toBe(-12);
  });

  it('底部触发区 → 正数（向下滚），贴边满速', () => {
    expect(edgeScrollVelocity(H - 5, 0, H)).toBeGreaterThan(0);
    expect(edgeScrollVelocity(H, 0, H)).toBe(12);
  });

  it('速度随深度线性增长（一进区就给满速会直接飞过头）', () => {
    // 触发区中点 ≈ 半速
    expect(edgeScrollVelocity(36, 0, H)).toBe(-6);
    expect(edgeScrollVelocity(H - 36, 0, H)).toBe(6);
  });

  it('指针跑到视口外也不越界（拖到窗口上方会被浏览器裁掉，速度仍应封顶）', () => {
    expect(edgeScrollVelocity(-200, 0, H)).toBe(-12);
    expect(edgeScrollVelocity(H + 200, 0, H)).toBe(12);
  });

  it('视口高度异常 / 0 → 不滚（宁可不动，也不能算出 Infinity）', () => {
    expect(edgeScrollVelocity(10, 0, 0)).toBe(0);
    expect(edgeScrollVelocity(10, 0, Number.NaN)).toBe(0);
  });

  it('触发区超过视口一半时收敛到一半（矮窗口里不会全程都在滚）', () => {
    // 视口只有 100：触发区被压到 50，所以 y=52 已经出了上触发区、也在下触发区边缘 → 0
    expect(edgeScrollVelocity(20, 0, 100)).toBeLessThan(0);
    expect(edgeScrollVelocity(52, 0, 100)).toBe(0);
  });
});
