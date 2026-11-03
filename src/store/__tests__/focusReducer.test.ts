import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../../constants';
import { createEmptyState, hydrateFromLoad, reducer, stateFromLoad } from '../reducer';
import type { AppState, FocusSession, Task, TaskTombstone } from '../../types';

/* ============================================================================
   专注记录 / 回收站 / 日界 相关的 reducer 行为
   ========================================================================= */

const NOW = '2026-10-26T10:00:00.000Z';

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    note: '',
    date: '2026-10-26',
    time: null,
    repeat: 'none',
    priority: 'medium',
    category: '学习',
    done: false,
    doneAt: null,
    parentId: null,
    estimatedMinutes: 0,
    createdAt: '2026-10-26T01:00:00.000Z',
    updatedAt: '2026-10-26T01:00:00.000Z',
    ...overrides,
  };
}

function session(id: string, overrides: Partial<FocusSession> = {}): FocusSession {
  return {
    id,
    taskId: null,
    date: '2026-10-26',
    startedAt: '2026-10-26T09:00:00.000Z',
    endedAt: '2026-10-26T09:25:00.000Z',
    durationMs: 25 * 60000,
    ...overrides,
  };
}

function stone(id: string, overrides: Partial<TaskTombstone> = {}): TaskTombstone {
  return {
    id,
    deletedAt: NOW,
    title: id,
    date: '2026-10-26',
    index: 0,
    ...overrides,
  };
}

function state(overrides: Partial<AppState> = {}): AppState {
  return { ...createEmptyState(), ...overrides };
}

describe('FOCUS_LOG', () => {
  it('记一段专注', () => {
    const next = reducer(state(), { type: 'FOCUS_LOG', session: session('f1') });
    expect(next.focusSessions).toHaveLength(1);
    expect(next.focusSessions[0]?.id).toBe('f1');
  });

  /**
   * 幂等：网络重放 / 连点会送出同一条记录两次。
   * 时长数据错了用户基本发现不了，所以必须在这里挡住。
   */
  it('同 id 再来一次被忽略（幂等，防重放）', () => {
    const first = reducer(state(), { type: 'FOCUS_LOG', session: session('f1') });
    const second = reducer(first, { type: 'FOCUS_LOG', session: session('f1') });
    expect(second).toBe(first);
    expect(second.focusSessions).toHaveLength(1);
  });

  it('id 为空的记录不写入', () => {
    const next = reducer(state(), {
      type: 'FOCUS_LOG',
      session: { ...session(''), id: '' },
    });
    expect(next.focusSessions).toHaveLength(0);
  });
});

describe('FOCUS_DELETE', () => {
  it('按 id 精确删除', () => {
    const before = state({ focusSessions: [session('f1'), session('f2')] });
    const next = reducer(before, { type: 'FOCUS_DELETE', id: 'f1' });
    expect(next.focusSessions.map((s) => s.id)).toEqual(['f2']);
  });

  it('不存在时返回同一个对象（不触发无谓保存）', () => {
    const before = state({ focusSessions: [session('f1')] });
    expect(reducer(before, { type: 'FOCUS_DELETE', id: 'ghost' })).toBe(before);
  });
});

describe('设置项夹紧范围', () => {
  /**
   * 设置会经云同步从别的设备过来。一个 dayStartHour=99 会把"今天"
   * 直接算到 4 天前 —— 全站日期错乱，比功能缺失严重得多。
   */
  it('SET_DAY_START 超出 0–6 被夹住', () => {
    const base = state();
    expect(reducer(base, { type: 'SET_DAY_START', hour: 99 }).settings.dayStartHour).toBe(6);
    expect(reducer(base, { type: 'SET_DAY_START', hour: -3 }).settings.dayStartHour).toBe(0);
    expect(reducer(base, { type: 'SET_DAY_START', hour: 4 }).settings.dayStartHour).toBe(4);
  });

  it('SET_DAY_START 非数字回落 0', () => {
    const base = state();
    expect(reducer(base, { type: 'SET_DAY_START', hour: Number.NaN }).settings.dayStartHour).toBe(0);
  });

  it('SET_FOCUS_MINUTES 夹在 1–180', () => {
    const base = state();
    expect(reducer(base, { type: 'SET_FOCUS_MINUTES', minutes: 0 }).settings.focusMinutes).toBe(1);
    expect(reducer(base, { type: 'SET_FOCUS_MINUTES', minutes: 999 }).settings.focusMinutes).toBe(180);
  });

  it('SET_BREAK_MINUTES 允许 0（不休息）', () => {
    const base = state();
    expect(reducer(base, { type: 'SET_BREAK_MINUTES', minutes: 0 }).settings.breakMinutes).toBe(0);
    expect(reducer(base, { type: 'SET_BREAK_MINUTES', minutes: 999 }).settings.breakMinutes).toBe(60);
  });

  it('值没变时返回同一个对象', () => {
    const base = state();
    expect(reducer(base, { type: 'SET_DAY_START', hour: 0 })).toBe(base);
  });
});

describe('HYDRATE：可选字段不能把已有数据洗掉', () => {
  const base = state({
    tasks: [task('a')],
    tombstones: [stone('gone')],
    focusSessions: [session('f1')],
  });
  const settings = createDefaultSettings('2026-10-26');

  it('不传 tombstones / focusSessions 时保留现有值', () => {
    const next = reducer(base, {
      type: 'HYDRATE',
      tasks: [task('b')],
      settings,
      storageError: null,
    });
    expect(next.tasks.map((t) => t.id)).toEqual(['b']);
    expect(next.tombstones.map((t) => t.id)).toEqual(['gone']);
    expect(next.focusSessions.map((s) => s.id)).toEqual(['f1']);
  });

  it('显式传空数组时才是真的清空', () => {
    const next = reducer(base, {
      type: 'HYDRATE',
      tasks: [],
      settings,
      tombstones: [],
      focusSessions: [],
      notes: [],
      storageError: null,
    });
    expect(next.tombstones).toEqual([]);
    expect(next.focusSessions).toEqual([]);
  });
});

describe('TASK_DELETE：级联删除并各留一条墓碑', () => {
  const base = state({
    tasks: [task('p'), task('c1', { parentId: 'p' }), task('c2', { parentId: 'p' }), task('other')],
  });

  it('父和子一起消失，别的不受影响', () => {
    const next = reducer(base, { type: 'TASK_DELETE', id: 'p', now: NOW });
    expect(next.tasks.map((t) => t.id)).toEqual(['other']);
  });

  it('三条墓碑都留（少一条 → 同步后那个子任务会复活）', () => {
    const next = reducer(base, { type: 'TASK_DELETE', id: 'p', now: NOW });
    expect(next.tombstones.map((t) => t.id).sort()).toEqual(['c1', 'c2', 'p']);
    expect(next.tombstones.every((t) => t.deletedAt === NOW)).toBe(true);
  });
});

describe('TOMBSTONE_RESTORE / TOMBSTONE_CLEAR', () => {
  it('恢复 = 插回任务 + 移除墓碑（留墓碑会被再删一次）', () => {
    const base = state({ tombstones: [stone('gone', { title: '旧任务', index: 0 })] });
    const next = reducer(base, { type: 'TOMBSTONE_RESTORE', id: 'gone', now: NOW });
    expect(next.tasks.map((t) => t.id)).toEqual(['gone']);
    expect(next.tasks[0]?.title).toBe('旧任务');
    expect(next.tombstones).toEqual([]);
  });

  it('对端又建了同 id 任务时只清墓碑，不插重复', () => {
    const base = state({ tasks: [task('gone')], tombstones: [stone('gone')] });
    const next = reducer(base, { type: 'TOMBSTONE_RESTORE', id: 'gone', now: NOW });
    expect(next.tasks).toHaveLength(1);
    expect(next.tombstones).toEqual([]);
  });

  it('墓碑不存在时原样返回', () => {
    const base = state({ tombstones: [stone('a')] });
    expect(reducer(base, { type: 'TOMBSTONE_RESTORE', id: 'nope', now: NOW })).toBe(base);
  });

  it('清空回收站', () => {
    const base = state({ tombstones: [stone('a'), stone('b')] });
    expect(reducer(base, { type: 'TOMBSTONE_CLEAR' }).tombstones).toEqual([]);
  });
});

describe('TASK_TOGGLE：sticky 只记被直接点的那个', () => {
  it('勾父任务时，被级联带动的子任务不进 sticky', () => {
    const base = state({ tasks: [task('p'), task('c1', { parentId: 'p' })] });
    const next = reducer(base, { type: 'TASK_TOGGLE', id: 'p', now: NOW });
    expect(next.ui.stickyDoneIds).toEqual(['p']);
  });

  it('勾子任务时 sticky 只含它自己', () => {
    const base = state({ tasks: [task('p'), task('c1', { parentId: 'p' })] });
    const next = reducer(base, { type: 'TASK_TOGGLE', id: 'c1', now: NOW });
    expect(next.ui.stickyDoneIds).toEqual(['c1']);
  });
});

describe('TASK_ADD：子任务只准挂一层', () => {
  it('往子任务下加子任务 → 自动升到祖父同级', () => {
    const base = state({ tasks: [task('p'), task('c1', { parentId: 'p' })] });
    const next = reducer(base, {
      type: 'TASK_ADD',
      task: task('c2', { parentId: 'c1' }),
    });
    expect(next.tasks.find((t) => t.id === 'c2')?.parentId).toBe('p');
  });

  it('父任务不存在 → 退化为顶层，不留孤儿指针', () => {
    const base = state({ tasks: [] });
    const next = reducer(base, {
      type: 'TASK_ADD',
      task: task('x', { parentId: 'ghost' }),
    });
    expect(next.tasks[0]?.parentId).toBeNull();
  });
});

/* ============================================================================
   装载动作：所有字段都必须带回来
   ----------------------------------------------------------------------------
   这条守的是一个只在安卓上发作的事故：
   StoreContext 曾经手抄过一份 `hydrateAction`，只写了 tasks/settings/diary，
   漏了 tombstones 与 focusSessions。APK 走的是异步装载那条路（本地是
   SharedPreferences，只能异步读），于是**每次冷启动**回收站和专注记录都清空。
   网页端走的是 stateFromLoad，字段是全的 —— 所以网页上永远复现不出来。
   ========================================================================= */
describe('hydrateFromLoad：装载必须带回全部持久化字段', () => {
  const payload = {
    schemaVersion: 4,
    savedAt: '2026-10-26T10:00:00.000Z',
    tasks: [task('a')],
    settings: createDefaultSettings('2026-10-26'),
    diary: [{ date: '2026-10-26', content: 'x', createdAt: NOW, updatedAt: NOW }],
    tombstones: [stone('gone')],
    focusSessions: [session('f1')],
    notes: [
      { id: 'note1', title: 'I2C 时序', content: 'WHO_AM_I = 0x68', category: 'c_tech',
        pinned: false, createdAt: NOW, updatedAt: NOW },
    ],
  };

  it('墓碑与专注记录都在（漏了 = 安卓每次冷启动丢数据）', () => {
    const next = reducer(createEmptyState(), hydrateFromLoad({ payload, error: null, backupCreated: false }));
    expect(next.tasks.map((t) => t.id)).toEqual(['a']);
    expect(next.tombstones.map((t) => t.id)).toEqual(['gone']);
    expect(next.focusSessions.map((s) => s.id)).toEqual(['f1']);
    expect(next.diary).toHaveLength(1);
    // 记事本同样必须回来：漏了它 = 升级后用户的记事全部消失
    expect(next.notes.map((n) => n.id)).toEqual(['note1']);
  });

  it('stateFromLoad 与 hydrateFromLoad 结果必须一致（同一份事实，两种出口）', () => {
    const load = { payload, error: null, backupCreated: false } as const;
    const viaState = stateFromLoad(load);
    const viaAction = reducer(createEmptyState(), hydrateFromLoad(load));
    expect(viaState.tasks).toEqual(viaAction.tasks);
    expect(viaState.tombstones).toEqual(viaAction.tombstones);
    expect(viaState.focusSessions).toEqual(viaAction.focusSessions);
    expect(viaState.notes).toEqual(viaAction.notes);
  });
});

describe('DATA_CLEAR_ALL：清空时连专注记录一起清', () => {
  it('任务 / 日记 / 墓碑 / 专注记录全部归零', () => {
    const base = state({
      tasks: [task('a')],
      diary: [{ date: '2026-10-26', content: 'x', createdAt: NOW, updatedAt: NOW }],
      tombstones: [stone('b')],
      focusSessions: [session('f1')],
    });
    const next = reducer(base, { type: 'DATA_CLEAR_ALL' });
    expect(next.tasks).toEqual([]);
    expect(next.diary).toEqual([]);
    expect(next.tombstones).toEqual([]);
    expect(next.focusSessions).toEqual([]);
  });
});
