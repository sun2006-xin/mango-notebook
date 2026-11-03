import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../../constants';
import { reducer, createEmptyState, hydrateFromPayload } from '../reducer';
import type { AppState } from '../../types';
import type { Task } from '../../types';

/* ============================================================================
   reducer 收尾打点：字段级时钟（store/fieldClock.ts）
   ----------------------------------------------------------------------------
   这里的用例只回答一个问题：**"某个字段真的变了，就一定有它的时间戳"**。
   打点漏了不会报错、界面也看不出来 —— 只会在云同步时表现为
   "我在手机上改的东西被电脑的旧副本盖掉了"。所以按 action 类型逐条钉住。

   反面同样重要：**没变的字段绝不能被打点**。全打点等于"谁最后操作谁全赢"，
   字段级合并直接退化回整条 LWW，白忙一场。
   ========================================================================= */

const NOW = '2026-10-24T10:00:00.000Z';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: '数学真题',
    note: '',
    date: '2026-10-24',
    time: null,
    repeat: 'none',
    priority: 'medium',
    category: '学习',
    done: false,
    doneAt: null,
    parentId: null,
    estimatedMinutes: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function withTasks(tasks: Task[]): AppState {
  const base = createEmptyState();
  return {
    ...base,
    tasks,
    settings: { ...base.settings, lastSelectedDate: '2026-10-24' },
  };
}

describe('字段级时钟 · 打点', () => {
  it('TASK_PATCH 改标题 → 只给 title 打点', () => {
    const next = reducer(withTasks([task()]), {
      type: 'TASK_PATCH',
      id: 't1',
      patch: { title: '数学真题（二刷）' },
      now: NOW,
    });
    expect(next.tasks[0].fieldAt).toEqual({ title: NOW });
  });

  it('TASK_PATCH 改备注 → 只给 note 打点（标题不动就不能被打点）', () => {
    const next = reducer(withTasks([task()]), {
      type: 'TASK_PATCH',
      id: 't1',
      patch: { note: '错题第 3 题' },
      now: NOW,
    });
    expect(next.tasks[0].fieldAt).toEqual({ note: NOW });
  });

  it('TASK_PATCH 值没变（提交了同样的内容）→ 不打点，避免把时钟往前推', () => {
    const next = reducer(withTasks([task()]), {
      type: 'TASK_PATCH',
      id: 't1',
      patch: { title: '数学真题' },
      now: NOW,
    });
    expect(next.tasks[0].fieldAt).toBeUndefined();
  });

  it('TASK_TOGGLE → done 打点，doneAt 不进时钟表（跟随 done）', () => {
    const next = reducer(withTasks([task()]), { type: 'TASK_TOGGLE', id: 't1', now: NOW });
    expect(next.tasks[0].done).toBe(true);
    expect(next.tasks[0].fieldAt).toEqual({ done: NOW });
  });

  it('TASK_TOGGLE 级联子任务 → 被带动的子任务也有自己的 done 时钟', () => {
    const state = withTasks([
      task({ id: 'p1' }),
      task({ id: 'c1', parentId: 'p1' }),
      task({ id: 'other' }),
    ]);
    const next = reducer(state, { type: 'TASK_TOGGLE', id: 'p1', now: NOW });
    const byId = new Map(next.tasks.map((t) => [t.id, t]));
    expect(byId.get('c1')?.fieldAt).toEqual({ done: NOW });
    // 完全没被碰过的任务不能凭空多出时钟
    expect(byId.get('other')?.fieldAt).toBeUndefined();
  });

  it('TASK_MOVE_TO_TODAY → date 打点（多天任务的 endDate 一起打）', () => {
    const state = withTasks([task({ endDate: '2026-10-26' })]);
    const next = reducer(state, {
      type: 'TASK_MOVE_TO_TODAY',
      ids: ['t1'],
      targetDate: '2026-10-25',
      now: NOW,
    });
    expect(next.tasks[0].date).toBe('2026-10-25');
    expect(next.tasks[0].endDate).toBe('2026-10-27');
    expect(next.tasks[0].fieldAt).toEqual({ date: NOW, endDate: NOW });
  });

  it('TASK_UNDO_MOVE → 日期还原也要打点（撤销同样是一次改动）', () => {
    const state = withTasks([task({ date: '2026-10-25', updatedAt: NOW })]);
    const next = reducer(state, {
      type: 'TASK_UNDO_MOVE',
      moves: [{ id: 't1', from: '2026-10-24' }],
      now: NOW,
    });
    expect(next.tasks[0].date).toBe('2026-10-24');
    expect(next.tasks[0].fieldAt).toEqual({ date: NOW });
  });
});

describe('字段级时钟 · 不该打点的时候', () => {
  it('改设置（tasks 引用没变）→ 一条任务都不碰', () => {
    const state = withTasks([task()]);
    const next = reducer(state, { type: 'SET_THEME', theme: 'dark' });
    expect(next.tasks).toBe(state.tasks);
    expect(next.tasks[0].fieldAt).toBeUndefined();
  });

  it('HYDRATE 装进来的既有时钟不被压平（装载时每条都算"新插入"）', () => {
    const early = '2026-10-01T00:00:00.000Z';
    const late = '2026-10-05T00:00:00.000Z';
    const payload = {
      schemaVersion: 5,
      savedAt: late,
      tasks: [task({ updatedAt: late, fieldAt: { title: early, note: late } })],
      settings: createDefaultSettings('2026-10-24'),
      diary: [],
      tombstones: [],
      focusSessions: [],
      notes: [],
    };
    const next = reducer(createEmptyState(), hydrateFromPayload(payload, null));
    expect(next.tasks[0].fieldAt).toEqual({ title: early, note: late });
  });
});
