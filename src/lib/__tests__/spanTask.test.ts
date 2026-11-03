import { describe, expect, it } from 'vitest';
import {
  MAX_SPAN_INDEX_DAYS,
  buildWeekColumns,
  createTask,
  getDayProgress,
  getOverdueTasks,
  getTasksForDate,
  groupDayTasks,
  indexByDate,
  taskCoversDate,
  taskLastDate,
  taskSpanDays,
} from '../task';
import { sanitizeTasks } from '../sanitize';
import { planTaskMove } from '../drag';
import { createEmptyState, reducer } from '../../store/reducer';
import type { DateKey, Task } from '../../types';

/* ============================================================================
   多天任务（跨天区间）

   口径（全站统一）：
   - `date` = 开始日，`endDate` = 最后一天（含）；空 = 单天
   - 区间内**每一天**都出现在列表里，也都计入那天的进度分母
   - **逾期按最后一天算**，不是开始日（否则 30 天任务从第 2 天就"逾期"）
   ========================================================================= */

const D1 = '2026-10-30' as DateKey;
const D3 = '2026-11-01' as DateKey;
const D5 = '2026-11-03' as DateKey;
const NOWI = '2026-10-30T09:00:00.000Z';

function mk(id: string, date: DateKey, endDate: DateKey | null = null, extra: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    note: '',
    date,
    endDate,
    time: null,
    repeat: 'none',
    priority: 'medium',
    category: '学习',
    done: false,
    doneAt: null,
    createdAt: NOWI,
    updatedAt: NOWI,
    parentId: null,
    estimatedMinutes: 0,
    ...extra,
  };
}

describe('taskLastDate / taskCoversDate / taskSpanDays', () => {
  it('单天任务：最后一天就是 date，跨度 1', () => {
    const task = mk('a', D1);
    expect(taskLastDate(task)).toBe(D1);
    expect(taskSpanDays(task)).toBe(1);
  });

  it('跨天任务：闭区间，首尾都覆盖', () => {
    const task = mk('a', D1, D5);
    expect(taskLastDate(task)).toBe(D5);
    expect(taskSpanDays(task)).toBe(5);
    expect(taskCoversDate(task, D1)).toBe(true);
    expect(taskCoversDate(task, D3)).toBe(true);
    expect(taskCoversDate(task, D5)).toBe(true);
  });

  it('区间外不覆盖', () => {
    const task = mk('a', D1, D5);
    expect(taskCoversDate(task, '2026-10-29' as DateKey)).toBe(false);
    expect(taskCoversDate(task, '2026-11-04' as DateKey)).toBe(false);
  });

  it('脏数据（endDate 早于 date）按单天处理，绝不让任务消失', () => {
    const broken = mk('a', D5, D1);
    expect(taskLastDate(broken)).toBe(D5);
    expect(taskSpanDays(broken)).toBe(1);
    expect(taskCoversDate(broken, D5)).toBe(true);
  });

  it('endDate === date 视为单天（不产生"跨 1 天"的怪标记）', () => {
    expect(taskSpanDays(mk('a', D1, D1))).toBe(1);
  });
});

describe('列表与进度：区间内每天都算', () => {
  const tasks = [mk('span', D1, D5), mk('one', D3)];

  it('getTasksForDate 在中间那天同时给出跨天任务和当天任务', () => {
    expect(getTasksForDate(tasks, D3).map((t) => t.id).sort()).toEqual(['one', 'span']);
  });

  it('进度分母含跨天任务（"今天共 2 项"里有 1 项在推进）', () => {
    expect(getDayProgress(tasks, D3)).toEqual({ done: 0, total: 2, percent: 0 });
  });

  it('开始日与结束日之外不算进去', () => {
    expect(getTasksForDate(tasks, '2026-11-04' as DateKey)).toEqual([]);
  });

  it('groupDayTasks 的待办段也含跨天任务', () => {
    const group = groupDayTasks({
      tasks,
      date: D3,
      today: D3,
      mode: 'all',
      category: null,
      stickyDoneIds: [],
      includeOverdue: false,
    });
    expect(group.open.map((t) => t.id).sort()).toEqual(['one', 'span']);
  });

  it('周视图：跨天任务出现在它覆盖的每一列', () => {
    const columns = buildWeekColumns(
      [mk('span', D1, D5)],
      [D1, D3, D5, '2026-11-04' as DateKey],
      D3,
      D3,
    );
    expect(columns.map((c) => c.tasks.length)).toEqual([1, 1, 1, 0]);
  });
});

describe('逾期：按最后一天算', () => {
  it('还没到结束日 → 不算逾期（这是多天任务的核心价值）', () => {
    expect(getOverdueTasks([mk('a', '2026-10-20' as DateKey, D5)], D3)).toEqual([]);
  });

  it('结束日已过 → 才算逾期', () => {
    expect(getOverdueTasks([mk('a', '2026-10-20' as DateKey, D1)], D3).map((t) => t.id)).toEqual([
      'a',
    ]);
  });

  it('已完成的不算逾期', () => {
    const done = mk('a', '2026-10-20' as DateKey, D1, { done: true, doneAt: NOWI });
    expect(getOverdueTasks([done], D3)).toEqual([]);
  });
});

describe('indexByDate 展开跨度', () => {
  it('跨天任务出现在每个覆盖日的桶里', () => {
    const index = indexByDate([mk('span', D1, D3)]);
    expect([...index.keys()].sort()).toEqual([D1, '2026-10-31', D3].sort());
    expect(index.get('2026-10-31')?.map((t) => t.id)).toEqual(['span']);
  });

  it('超长跨度有上限兜底（脏数据不该把内存打爆）', () => {
    const crazy = mk('bad', '2026-01-01' as DateKey, '2099-12-31' as DateKey);
    const index = indexByDate([crazy]);
    expect(index.size).toBeLessThanOrEqual(MAX_SPAN_INDEX_DAYS);
  });
});

describe('持久化与写入收敛', () => {
  it('sanitizeTasks 保留合法 endDate，清掉早于开始日的', () => {
    const list = sanitizeTasks([
      { id: 'a', title: 'A', date: D1, endDate: D5 },
      { id: 'b', title: 'B', date: D5, endDate: D1 },
      { id: 'c', title: 'C', date: D1, endDate: '不是日期' },
    ]);
    expect(list.map((t) => t.endDate)).toEqual([D5, null, null]);
  });

  it('createTask：非法 / 早于开始日 / 等于开始日 → 单天', () => {
    expect(createTask({ title: 'x', date: D1, endDate: D3 }, NOWI, D1).endDate).toBe(D3);
    expect(createTask({ title: 'x', date: D1, endDate: D1 }, NOWI, D1).endDate).toBe(null);
    // 早于开始日（D1 = 10-30，这里给 10-29）→ 单天
    expect(createTask({ title: 'x', date: D1, endDate: '2026-10-29' as DateKey }, NOWI, D1).endDate).toBe(null);
  });

  it('TASK_PATCH 把开始日推到结束日之后 → 收敛成单天（而不是让任务消失）', () => {
    const base = createEmptyState();
    const s0 = { ...base, tasks: [mk('a', D1, D3)] };
    const s1 = reducer(s0, { type: 'TASK_PATCH', id: 'a', patch: { date: D5 }, now: NOWI });
    expect(s1.tasks[0]?.date).toBe(D5);
    expect(s1.tasks[0]?.endDate).toBe(null);
    // 且它仍然出现在 D5 那天
    expect(getTasksForDate(s1.tasks, D5).map((t) => t.id)).toEqual(['a']);
  });
});

describe('移动时保持跨度', () => {
  it('拖到另一天：区间整体平移，跨度不变', () => {
    const tasks = [mk('a', D1, D3)]; // 10-30 → 11-01（3 天）
    const plan = planTaskMove(tasks, 'a', { kind: 'day', date: '2026-11-10' as DateKey }, NOWI);
    expect(plan.tasks[0]?.date).toBe('2026-11-10');
    expect(plan.tasks[0]?.endDate).toBe('2026-11-12');
    expect(taskSpanDays(plan.tasks[0] as Task)).toBe(3);
  });

  it('批量「移到今天」也保持跨度', () => {
    const base = createEmptyState();
    const s0 = { ...base, tasks: [mk('a', D1, D3)] };
    const s1 = reducer(s0, {
      type: 'TASK_MOVE_TO_TODAY',
      ids: ['a'],
      targetDate: '2026-11-10' as DateKey,
      now: NOWI,
    });
    expect(s1.tasks[0]?.endDate).toBe('2026-11-12');
  });

  it('撤销「移到今天」把区间也搬回去', () => {
    const base = createEmptyState();
    const s0 = { ...base, tasks: [mk('a', D1, D3)] };
    const s1 = reducer(s0, {
      type: 'TASK_MOVE_TO_TODAY',
      ids: ['a'],
      targetDate: '2026-11-10' as DateKey,
      now: NOWI,
    });
    const s2 = reducer(s1, {
      type: 'TASK_UNDO_MOVE',
      moves: [{ id: 'a', from: D1, endDate: D3 }],
      now: NOWI,
    });
    expect(s2.tasks[0]?.date).toBe(D1);
    expect(s2.tasks[0]?.endDate).toBe(D3);
  });

  it('撤销能还原成"没有结束日"（null 不是"没传"）', () => {
    const base = createEmptyState();
    const s0 = { ...base, tasks: [mk('a', D1, D3)] };
    const s1 = reducer(s0, {
      type: 'TASK_MOVE_TO_TODAY',
      ids: ['a'],
      targetDate: '2026-11-10' as DateKey,
      now: NOWI,
    });
    const s2 = reducer(s1, {
      type: 'TASK_UNDO_MOVE',
      moves: [{ id: 'a', from: D1, endDate: null }],
      now: NOWI,
    });
    expect(s2.tasks[0]?.endDate).toBe(null);
    expect(taskSpanDays(s2.tasks[0] as Task)).toBe(1);
  });
});
