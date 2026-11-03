import { describe, expect, it } from 'vitest';
import { createEmptyState, reducer } from '../reducer';
import type { AppState, Task } from '../../types';

/* ============================================================================
   归档：删掉 before 之前已完成的任务
   落点：① 只删已完成的，未完成的天塌下来也不能被归档吃掉；
   ② 没有可归档的必须返回同一对象（否则每次保存都白写一次）。
   ========================================================================= */

const NOW = '2026-10-24T10:00:00.000Z';

function task(id: string, date: string, done: boolean): Task {
  return {
    id,
    title: id,
    note: '',
    date,
    time: null,
    repeat: 'none',
    priority: 'medium',
    category: '学习',
    done,
    doneAt: done ? `${date}T12:00:00.000Z` : null,
    createdAt: NOW,
    updatedAt: NOW,
    parentId: null,
    estimatedMinutes: 0,
  };
}

function stateWith(tasks: Task[]): AppState {
  return { ...createEmptyState(), tasks };
}

describe('ARCHIVE_DONE', () => {
  it('只删 30 天前已完成的；未完成的留着', () => {
    const state = stateWith([
      task('old-done', '2026-08-01', true),
      task('old-open', '2026-08-01', false),
      task('new-done', '2026-10-20', true),
    ]);
    const next = reducer(state, { type: 'ARCHIVE_DONE', before: '2026-09-24', now: '2026-10-25T00:00:00.000Z' });
    expect(next.tasks.map((t) => t.id)).toEqual(['old-open', 'new-done']);
  });

  it('边界：正好等于 before 的那天不删', () => {
    const state = stateWith([task('edge', '2026-09-24', true)]);
    const next = reducer(state, { type: 'ARCHIVE_DONE', before: '2026-09-24', now: '2026-10-25T00:00:00.000Z' });
    expect(next.tasks).toHaveLength(1);
  });

  it('没有可归档的 → 返回同一对象（避免无谓保存）', () => {
    const state = stateWith([task('keep', '2026-10-24', true)]);
    const next = reducer(state, { type: 'ARCHIVE_DONE', before: '2026-09-24', now: '2026-10-25T00:00:00.000Z' });
    expect(next).toBe(state);
  });

  it('全归档掉 → tasks 为空但其它状态不动', () => {
    const state = stateWith([task('a', '2026-01-01', true), task('b', '2026-02-01', true)]);
    const next = reducer(state, { type: 'ARCHIVE_DONE', before: '2026-09-24', now: '2026-10-25T00:00:00.000Z' });
    expect(next.tasks).toEqual([]);
    expect(next.settings).toBe(state.settings);
    expect(next.diary).toBe(state.diary);
  });
});
