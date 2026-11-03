import { describe, expect, it } from 'vitest';
import type { Task } from '../../types';
import { createDefaultSettings } from '../../constants';
import { todayKey } from '../../lib/date';
import { getTasksForDate } from '../../lib/task';
import {
  createEmptyState,
  reducer,
  stateFromLoad,
  storageErrorMessage,
  type AppAction,
} from '../reducer';
import type { AppState } from '../../types';

/* ============================================================================
   §3.4 Reducer：不可变更新 + 每个 action 的语义
   ========================================================================= */

const NOW = '2026-10-24T10:00:00.000Z';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: '数学真题',
    note: '',
    date: '2026-10-24',
    time: '09:00',
    repeat: 'none',
    priority: 'high',
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

const run = (state: AppState, action: AppAction): AppState => reducer(state, action);

describe('不可变更新（Object.is 抽查）', () => {
  it('TASK_ADD 产生新的 tasks 数组且不改原 state', () => {
    const s0 = withTasks([task()]);
    const added = task({ id: 't2', title: '英语阅读' });
    const s1 = run(s0, { type: 'TASK_ADD', task: added });

    expect(Object.is(s0, s1)).toBe(false);
    expect(Object.is(s0.tasks, s1.tasks)).toBe(false);
    expect(s0.tasks).toHaveLength(1);
    expect(s1.tasks).toHaveLength(2);
    expect(Object.is(s0.tasks[0], s1.tasks[0])).toBe(true);
  });

  it('TASK_PATCH 只替换命中的那条', () => {
    const s0 = withTasks([task({ id: 'a' }), task({ id: 'b' })]);
    const s1 = run(s0, { type: 'TASK_PATCH', id: 'b', patch: { title: '改名' }, now: NOW });

    expect(Object.is(s0.tasks, s1.tasks)).toBe(false);
    expect(Object.is(s0.tasks[0], s1.tasks[0])).toBe(true);
    expect(Object.is(s0.tasks[1], s1.tasks[1])).toBe(false);
    expect(s1.tasks[1]?.title).toBe('改名');
    expect(s1.tasks[1]?.updatedAt).toBe(NOW);
  });

  it('未知 id 的 TASK_PATCH 原样返回同一个 state', () => {
    const s0 = withTasks([task()]);
    expect(run(s0, { type: 'TASK_PATCH', id: 'nope', patch: { title: 'x' }, now: NOW })).toBe(s0);
  });
});

describe('TASK_TOGGLE（勾选 / sticky / doneAt）', () => {
  it('勾选：done=true、写 doneAt、进入 sticky', () => {
    const s0 = withTasks([task()]);
    const s1 = run(s0, { type: 'TASK_TOGGLE', id: 't1', now: NOW });

    expect(s1.tasks[0]?.done).toBe(true);
    expect(s1.tasks[0]?.doneAt).toBe(NOW);
    expect(s1.tasks[0]?.updatedAt).toBe(NOW);
    expect(s1.ui.stickyDoneIds).toEqual(['t1']);
    expect(Object.is(s0.tasks[0], s1.tasks[0])).toBe(false);
  });

  it('取消勾选：done=false、doneAt=null、移出 sticky', () => {
    const s0 = run(withTasks([task()]), { type: 'TASK_TOGGLE', id: 't1', now: NOW });
    const s1 = run(s0, { type: 'TASK_TOGGLE', id: 't1', now: NOW });

    expect(s1.tasks[0]?.done).toBe(false);
    expect(s1.tasks[0]?.doneAt).toBeNull();
    expect(s1.ui.stickyDoneIds).toEqual([]);
  });

  it('同一 id 反复勾选不会在 sticky 里重复', () => {
    let state = withTasks([task()]);
    state = run(state, { type: 'TASK_TOGGLE', id: 't1', now: NOW });
    state = run(state, { type: 'TASK_TOGGLE', id: 't1', now: NOW });
    state = run(state, { type: 'TASK_TOGGLE', id: 't1', now: NOW });
    expect(state.ui.stickyDoneIds).toEqual(['t1']);
  });
});

describe('TASK_PATCH 的字段兜底', () => {
  it('title 为空则忽略该字段（其余字段仍生效）', () => {
    const s0 = withTasks([task()]);
    const s1 = run(s0, {
      type: 'TASK_PATCH',
      id: 't1',
      patch: { title: '   ', priority: 'low' },
      now: NOW,
    });
    expect(s1.tasks[0]?.title).toBe('数学真题');
    expect(s1.tasks[0]?.priority).toBe('low');
  });

  it('非法优先级被忽略', () => {
    const s0 = withTasks([task()]);
    const s1 = run(s0, {
      type: 'TASK_PATCH',
      id: 't1',
      patch: { priority: 'urgent' as never },
      now: NOW,
    });
    expect(s1.tasks[0]?.priority).toBe('high');
  });
});

describe('TASK_DELETE / TASK_RESTORE', () => {
  it('删除时清 sticky，并在抽屉正编辑该条时关抽屉', () => {
    const s0: AppState = {
      ...withTasks([task({ id: 'a' }), task({ id: 'b' })]),
      ui: { ...createEmptyState().ui, stickyDoneIds: ['a'], drawerTaskId: 'a' },
    };
    const s1 = run(s0, { type: 'TASK_DELETE', id: 'a', now: '2026-10-25T10:00:00.000Z' });

    expect(s1.tasks.map((t) => t.id)).toEqual(['b']);
    expect(s1.ui.stickyDoneIds).toEqual([]);
    expect(s1.ui.drawerTaskId).toBeNull();
  });

  it('撤销删除按原位置插回，除 updatedAt 外字段与 id 原样', () => {
    const a = task({ id: 'a' });
    const b = task({ id: 'b' });
    const c = task({ id: 'c' });
    const s0 = withTasks([a, b, c]);
    const s1 = run(s0, { type: 'TASK_DELETE', id: 'b', now: '2026-10-25T10:00:00.000Z' });
    const s2 = run(s1, { type: 'TASK_RESTORE', task: b, index: 1, now: '2026-10-26T10:00:00.000Z' });

    expect(s2.tasks.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    // 唯一不能"原样"的字段就是 updatedAt，见下一条用例
    expect(s2.tasks[1]).toEqual({ ...b, updatedAt: '2026-10-26T10:00:00.000Z' });
  });

  it('撤销必须刷新 updatedAt，否则云端墓碑会把它再删一次', () => {
    /**
     * 真实事故：删任务时留下墓碑（deletedAt = 删除那一刻），撤销回来的任务
     * 若沿用删除前的旧 updatedAt（必然早于 deletedAt），合并时 applyTombstones
     * 判"这条已删" → 用户以为撤销成功，下一秒同步后真丢了。
     */
    const deletedAt = '2026-10-25T10:00:00.000Z';
    const before = task({ id: 'b', updatedAt: '2026-10-20T00:00:00.000Z' });
    const s0 = withTasks([before]);
    const s1 = run(s0, { type: 'TASK_DELETE', id: 'b', now: deletedAt });
    const stone = s1.tombstones.find((t) => t.id === 'b');
    expect(stone).toBeTruthy();
    const restoredAt = '2026-10-25T10:00:05.000Z';
    const s2 = run(s1, { type: 'TASK_RESTORE', task: before, index: 0, now: restoredAt });
    expect(new Date(s2.tasks[0].updatedAt).getTime()).toBeGreaterThan(new Date(stone!.deletedAt).getTime());
  });

  it('index 超界时 append', () => {
    const s0 = withTasks([task({ id: 'a' })]);
    const s1 = run(s0, { type: 'TASK_DELETE', id: 'a', now: '2026-10-25T10:00:00.000Z' });
    const s2 = run(s1, {
      type: 'TASK_RESTORE',
      task: task({ id: 'a' }),
      index: 99,
      now: '2026-10-26T10:00:00.000Z',
    });
    expect(s2.tasks.map((t) => t.id)).toEqual(['a']);
  });

  it('撤销把选中日切回任务原日期（U5）', () => {
    const s0: AppState = {
      ...withTasks([]),
      settings: { ...createDefaultSettings(todayKey()), lastSelectedDate: '2026-11-05' },
    };
    const restored = task({ id: 'z', date: '2026-10-02' });
    const s1 = run(s0, {
      type: 'TASK_RESTORE',
      task: restored,
      index: 0,
      now: '2026-10-26T10:00:00.000Z',
    });
    expect(s1.settings.lastSelectedDate).toBe('2026-10-02');
    expect(s1.ui.monthCursor).toEqual({ year: 2026, month: 9 });
  });
});

describe('TASK_PATCH 改日期（抽屉里最常见的操作）', () => {
  it('改日期后从当日移出、出现在目标日，字段与 id 不变', () => {
    const s0 = withTasks([task({ id: 'a', date: '2026-10-24' }), task({ id: 'b', date: '2026-10-24' })]);
    const s1 = run(s0, {
      type: 'TASK_PATCH',
      id: 'a',
      patch: { date: '2026-10-26' },
      now: NOW,
    });

    expect(getTasksForDate(s1.tasks, '2026-10-24').map((t) => t.id)).toEqual(['b']);
    expect(getTasksForDate(s1.tasks, '2026-10-26').map((t) => t.id)).toEqual(['a']);
    expect(s1.tasks[0]?.id).toBe('a');
    expect(s1.tasks[0]?.updatedAt).toBe(NOW);
  });

  it('改回原日期能还原（撤销式往返）', () => {
    const s0 = withTasks([task({ id: 'a', date: '2026-10-24' })]);
    const moved = run(s0, { type: 'TASK_PATCH', id: 'a', patch: { date: '2026-10-26' }, now: NOW });
    const back = run(moved, { type: 'TASK_PATCH', id: 'a', patch: { date: '2026-10-24' }, now: NOW });
    expect(getTasksForDate(back.tasks, '2026-10-24').map((t) => t.id)).toEqual(['a']);
    expect(getTasksForDate(back.tasks, '2026-10-26')).toHaveLength(0);
  });
});

describe('TASK_MOVE_TO_TODAY / TASK_UNDO_MOVE', () => {
  const tasks = [task({ id: 'a', date: '2026-10-20' }), task({ id: 'b', date: '2026-10-21' })];

  it('批量改日期并刷新 updatedAt', () => {
    const s1 = run(withTasks(tasks), {
      type: 'TASK_MOVE_TO_TODAY',
      ids: ['a', 'b'],
      targetDate: '2026-10-24',
      now: NOW,
    });
    expect(s1.tasks.map((t) => t.date)).toEqual(['2026-10-24', '2026-10-24']);
    expect(s1.tasks[0]?.updatedAt).toBe(NOW);
  });

  it('撤销逐条还原原日期', () => {
    const s0 = withTasks(tasks);
    const s1 = run(s0, {
      type: 'TASK_MOVE_TO_TODAY',
      ids: ['a', 'b'],
      targetDate: '2026-10-24',
      now: NOW,
    });
    const s2 = run(s1, {
      type: 'TASK_UNDO_MOVE',
      moves: [
        { id: 'a', from: '2026-10-20' },
        { id: 'b', from: '2026-10-21' },
      ],
      now: NOW,
    });
    expect(s2.tasks.map((t) => t.date)).toEqual(['2026-10-20', '2026-10-21']);
  });
});

describe('日期 / 视图 / 筛选', () => {
  it('SET_SELECTED_DATE 清 sticky 并同步 monthCursor', () => {
    const s0: AppState = { ...withTasks([task()]), ui: { ...createEmptyState().ui, stickyDoneIds: ['t1'] } };
    const s1 = run(s0, { type: 'SET_SELECTED_DATE', date: '2026-12-01' });
    expect(s1.settings.lastSelectedDate).toBe('2026-12-01');
    expect(s1.ui.stickyDoneIds).toEqual([]);
    expect(s1.ui.monthCursor).toEqual({ year: 2026, month: 11 });
  });

  it('SHIFT_DATE ±1 与 SHIFT_WEEK ±7', () => {
    const s0 = withTasks([task()]);
    expect(run(s0, { type: 'SHIFT_DATE', delta: 1 }).settings.lastSelectedDate).toBe('2026-10-25');
    expect(run(s0, { type: 'SHIFT_DATE', delta: -1 }).settings.lastSelectedDate).toBe('2026-10-23');
    expect(run(s0, { type: 'SHIFT_WEEK', delta: 1 }).settings.lastSelectedDate).toBe('2026-10-31');
    expect(run(s0, { type: 'SHIFT_WEEK', delta: -1 }).settings.lastSelectedDate).toBe('2026-10-17');
  });

  it('SET_VIEW 写 lastView（含 week）', () => {
    const s1 = run(withTasks([]), { type: 'SET_VIEW', view: 'week' });
    expect(s1.settings.lastView).toBe('week');
  });

  it('SET_FILTER 只影响渲染字段', () => {
    const s0 = withTasks([]);
    const s1 = run(s0, { type: 'SET_FILTER', mode: 'open' });
    expect(s1.settings.filterMode).toBe('open');
    expect(s1.settings.filterCategory).toBeNull();
    const s2 = run(s1, { type: 'SET_FILTER', category: '工作' });
    expect(s2.settings.filterMode).toBe('open');
    expect(s2.settings.filterCategory).toBe('工作');
    expect(s2.tasks).toBe(s0.tasks);
  });

  it('TOGGLE_DONE_COLLAPSED 同时清 sticky', () => {
    const s0: AppState = {
      ...withTasks([task()]),
      settings: { ...createEmptyState().settings, doneCollapsed: true },
      ui: { ...createEmptyState().ui, stickyDoneIds: ['t1'] },
    };
    const s1 = run(s0, { type: 'TOGGLE_DONE_COLLAPSED' });
    expect(s1.settings.doneCollapsed).toBe(false);
    expect(s1.ui.stickyDoneIds).toEqual([]);
  });
});

describe('分类增删改', () => {
  it('CATEGORY_ADD 去重（同 id 或同名都忽略）', () => {
    const s0 = withTasks([]);
    const first = run(s0, { type: 'CATEGORY_ADD', id: 'c_new', name: '健身' });
    expect(first.settings.categories).toHaveLength(5);
    expect(run(first, { type: 'CATEGORY_ADD', id: 'c_new2', name: '健身' })).toBe(first);
    expect(run(first, { type: 'CATEGORY_ADD', id: 'c_new', name: '阅读' })).toBe(first);
  });

  it('CATEGORY_RENAME 级联重写任务的 category 与筛选值', () => {
    const s0: AppState = {
      ...withTasks([task({ category: '学习' })]),
      settings: { ...createEmptyState().settings, filterCategory: '学习' },
    };
    const s1 = run(s0, { type: 'CATEGORY_RENAME', id: 'c_learn', name: '考研' });
    expect(s1.settings.categories.find((c) => c.id === 'c_learn')?.name).toBe('考研');
    expect(s1.tasks[0]?.category).toBe('考研');
    expect(s1.settings.filterCategory).toBe('考研');
  });

  it('CATEGORY_REMOVE 把该分类下的任务回落到「其他」', () => {
    const s0 = withTasks([task({ category: '工作' })]);
    const s1 = run(s0, { type: 'CATEGORY_REMOVE', id: 'c_work' });
    expect(s1.settings.categories.map((c) => c.name)).toEqual(['学习', '生活', '其他']);
    expect(s1.tasks[0]?.category).toBe('其他');
  });

  it('删掉「其他」时回落到第一个分类', () => {
    const s0 = withTasks([task({ category: '其他' })]);
    const s1 = run(s0, { type: 'CATEGORY_REMOVE', id: 'c_other' });
    expect(s1.tasks[0]?.category).toBe('学习');
  });
});

describe('抽屉 / Toast / 保存态 / 清空 / 水合', () => {
  it('OPEN_DRAWER / CLOSE_DRAWER', () => {
    const s1 = run(withTasks([]), { type: 'OPEN_DRAWER', taskId: 't1', returnFocusId: 't1' });
    expect(s1.ui.drawerTaskId).toBe('t1');
    expect(s1.ui.drawerReturnFocusId).toBe('t1');
    const s2 = run(s1, { type: 'CLOSE_DRAWER' });
    expect(s2.ui.drawerTaskId).toBeNull();
  });

  it('TOAST_DISMISS 只关匹配 id（旧定时器不会关掉新 toast）', () => {
    const toast = {
      id: 'toast_1',
      message: '已删除「数学真题」',
      tone: 'default' as const,
      action: null,
      timeoutMs: 5000,
    };
    const s1 = run(withTasks([]), { type: 'TOAST_SHOW', toast });
    expect(s1.ui.toast?.id).toBe('toast_1');

    const stale = run(s1, { type: 'TOAST_DISMISS', id: 'toast_0' });
    expect(stale).toBe(s1);

    const cleared = run(s1, { type: 'TOAST_DISMISS', id: 'toast_1' });
    expect(cleared.ui.toast).toBeNull();

    const next = run(s1, { type: 'TOAST_SHOW', toast: { ...toast, id: 'toast_2' } });
    expect(next.ui.toast?.id).toBe('toast_2');
  });

  it('UI_SAVE_STATE 记录保存态与错误文案', () => {
    const s1 = run(withTasks([]), {
      type: 'UI_SAVE_STATE',
      saveState: 'error',
      error: '本地空间不足',
    });
    expect(s1.ui.saveState).toBe('error');
    expect(s1.ui.storageError).toBe('本地空间不足');
  });

  it('UI_SAVE_STATE 不传 error 时保留上一次的错误文案', () => {
    const errored = run(withTasks([]), {
      type: 'UI_SAVE_STATE',
      saveState: 'error',
      error: '本地空间不足',
    });
    const saved = run(errored, { type: 'UI_SAVE_STATE', saveState: 'saved' });
    expect(saved.ui.saveState).toBe('saved');
    expect(saved.ui.storageError).toBe('本地空间不足');
    const cleared = run(saved, { type: 'UI_SAVE_STATE', saveState: 'idle', error: null });
    expect(cleared.ui.storageError).toBeNull();
  });

  it('DATA_CLEAR_ALL 清空任务并重置设置但保留主题', () => {
    const s0: AppState = {
      ...withTasks([task()]),
      settings: { ...createEmptyState().settings, theme: 'dark' },
    };
    const s1 = run(s0, { type: 'DATA_CLEAR_ALL' });
    expect(s1.tasks).toEqual([]);
    expect(s1.settings.theme).toBe('dark');
    expect(s1.settings.filterMode).toBe('all');
    expect(s1.ui.stickyDoneIds).toEqual([]);
  });

  it('HYDRATE 装载任务与设置', () => {
    const settings = { ...createDefaultSettings(todayKey()), lastView: 'week' as const };
    const s1 = run(createEmptyState(), {
      type: 'HYDRATE',
      tasks: [task()],
      settings,
      storageError: null,
    });
    expect(s1.tasks).toHaveLength(1);
    expect(s1.settings.lastView).toBe('week');
    expect(s1.ui.storageError).toBeNull();
  });

  it('stateFromLoad：损坏数据 → 空态 + 错误文案', () => {
    const s1 = stateFromLoad({ payload: null, error: 'corrupt', backupCreated: true });
    expect(s1.tasks).toEqual([]);
    expect(s1.ui.storageError).toContain('数据读取失败');
    expect(s1.ui.storageError).toContain('已备份');
  });

  it('stateFromLoad：正常数据原样装载', () => {
    const settings = createDefaultSettings(todayKey());
    const s1 = stateFromLoad({
      payload: { schemaVersion: 1, savedAt: NOW, tasks: [task()], settings, diary: [], tombstones: [], focusSessions: [], notes: [] },
      error: null,
      backupCreated: false,
    });
    expect(s1.tasks).toHaveLength(1);
    expect(s1.ui.storageError).toBeNull();
  });

  it('storageErrorMessage 三档文案', () => {
    expect(storageErrorMessage(null, false)).toBeNull();
    expect(storageErrorMessage('future-version', true)).toContain('更高版本');
    expect(storageErrorMessage('unavailable', false)).toContain('不可用');
  });
});
