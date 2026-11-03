import { describe, expect, it } from 'vitest';
import type { AppState, Task } from '../../types';
import { createEmptyState, reducer } from '../reducer';

/* ============================================================================
   TASK_PATCH 的输入必须被"消毒"（v0.29.6）
   ----------------------------------------------------------------------------
   抽屉里的 `<input type="date">` 被清空时给的是**空串**，而 `patch` 只是转发。
   于是 `task.date = ''` 能直接进 state，后果是连锁的：
     · 按日分组找不到它 —— 今日 / 周 / 日历里全都不显示；
     · `taskLastDate() < today` 又让它被判成逾期 —— 逾期行时间列渲染出
       `NaN年NaN月NaN日`；
     · 下次冷启动 `sanitizeTasks` 才把它悄悄搬到"今天" ——
       用户看到的是"昨天那条任务自己跳到今天了"。
   一次误触清空，换来三个视图错乱 + 一次静默的数据篡改。
   ========================================================================= */

function stateWith(task: Partial<Task> = {}): AppState {
  const base = createEmptyState();
  const full: Task = {
    id: 't1',
    title: '数学真题',
    note: '',
    date: '2026-11-02',
    endDate: null,
    time: null,
    repeat: 'none',
    priority: 'medium',
    category: '学习',
    done: false,
    doneAt: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    parentId: null,
    estimatedMinutes: 30,
    order: 0,
    ...task,
  } as Task;
  return { ...base, tasks: [full] };
}

describe('TASK_PATCH · 日期消毒', () => {
  it('空串日期 → 丢弃这次 patch，原日期不变', () => {
    const next = reducer(stateWith(), { type: 'TASK_PATCH', id: 't1', patch: { date: '' }, now: '2026-11-02T10:00:00.000Z' });
    expect(next.tasks[0].date).toBe('2026-11-02');
  });

  it('不存在的日历日（2 月 31 日）→ 丢弃', () => {
    const next = reducer(stateWith(), {
      type: 'TASK_PATCH',
      id: 't1',
      patch: { date: '2026-02-31' },
      now: '2026-11-02T10:00:00.000Z',
    });
    expect(next.tasks[0].date).toBe('2026-11-02');
  });

  it('合法日期照常生效（别把好的一起挡了）', () => {
    const next = reducer(stateWith(), {
      type: 'TASK_PATCH',
      id: 't1',
      patch: { date: '2026-11-05' },
      now: '2026-11-02T10:00:00.000Z',
    });
    expect(next.tasks[0].date).toBe('2026-11-05');
  });

  it('endDate 同样消毒；显式清空（null）是合法操作', () => {
    const withEnd = stateWith({ endDate: '2026-11-04' });
    const cleared = reducer(withEnd, { type: 'TASK_PATCH', id: 't1', patch: { endDate: null }, now: '2026-11-02T10:00:00.000Z' });
    expect(cleared.tasks[0].endDate).toBeNull();

    const junk = reducer(withEnd, { type: 'TASK_PATCH', id: 't1', patch: { endDate: '不是日期' }, now: '2026-11-02T10:00:00.000Z' });
    expect(junk.tasks[0].endDate).toBe('2026-11-04');
  });

  it('空标题也不会写进 state（原有纪律不能因为加日期校验而丢）', () => {
    const next = reducer(stateWith(), { type: 'TASK_PATCH', id: 't1', patch: { title: '   ' }, now: '2026-11-02T10:00:00.000Z' });
    expect(next.tasks[0].title).toBe('数学真题');
  });
});
