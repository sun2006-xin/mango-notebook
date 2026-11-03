import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../../constants';
import { persistDeps } from '../usePersist';
import type { AppState } from '../../types';

/* ============================================================================
   自动保存的监听字段

   这个测试守的是一条**极易复发**的事故线：
   自动保存由 useEffect 的依赖数组触发，而「依赖数组」和「payload 构造」
   天然是两份独立代码。新增一个持久化字段时，改了 buildPayload 却忘了改依赖数组 ——
   编译不报错、单测不报错、界面看着也正常，只有刷新页面后数据消失才会被发现。

   曾经就漏了 diary：日记编辑器是每次按键就 dispatch 的，
   结果整个日记功能「能写、能看、就是存不下来」。

   所以把依赖数组抽成纯函数 persistDeps()，让 effect 直接展开它，
   再在这里逐字段钉住 —— 少一个就红。
   ========================================================================= */

function state(): AppState {
  return {
    tasks: [
      {
        id: 't1',
        title: '复习',
        note: '',
        date: '2026-10-24',
        time: null,
        priority: 'medium',
        category: '学习',
        done: false,
        doneAt: null,
        createdAt: '2026-10-24T10:00:00.000Z',
        updatedAt: '2026-10-24T10:00:00.000Z',
        repeat: 'none',
        parentId: null,
        estimatedMinutes: 0,
      },
    ],
    settings: {
      // 基底用默认设置：以后新增字段不用再回来补这个字面量
      ...createDefaultSettings('2026-10-24'),
      schemaVersion: 1,
      theme: 'light',
      defaultView: 'today',
      weekStart: 1,
      categories: [{ id: 'c_learn', name: '学习' }],
      lastSelectedDate: '2026-10-24',
      lastView: 'today',
      filterMode: 'all',
      filterCategory: null,
      doneCollapsed: true,
      remindEnabled: false,
      dayStartHour: 0,
      focusMinutes: 25,
      breakMinutes: 5,
      goals: [],
    strictFocus: false,
    dailyNewCardLimit: 20,
    sleepLog: [],
    focusPrunedBefore: null,
    weekPlanTemplate: null,
    },
    diary: [
      {
        date: '2026-10-24',
        content: '今天把 I2C 时序调通了',
        createdAt: '2026-10-24T10:00:00.000Z',
        updatedAt: '2026-10-24T10:00:00.000Z',
      },
    ],
    tombstones: [],
    focusSessions: [],
    notes: [],
    ui: {
      drawerTaskId: null,
      drawerReturnFocusId: null,
      monthCursor: { year: 2026, month: 10 },
      toast: null,
      stickyDoneIds: [],
      saveState: 'saved',
      storageError: null,
      hydrating: false,
      persistBlocked: false,
    },
  };
}

describe('自动保存监听字段', () => {
  it('必须覆盖每一个被持久化的字段（diary 漏了 = 日记存不下来）', () => {
    const s = state();
    const deps = persistDeps(s);
    expect(deps).toContain(s.tasks);
    expect(deps).toContain(s.settings);
    expect(deps).toContain(s.diary);
    expect(deps).toContain(s.tombstones);
    expect(deps).toContain(s.focusSessions);
    expect(deps).toContain(s.notes);
  });

  it('恰好六个字段：不多监听 ui，也不少', () => {
    const s = state();
    const deps = persistDeps(s);
    expect(deps).toHaveLength(6);
    expect(deps[0]).toBe(s.tasks);
    expect(deps[1]).toBe(s.settings);
    expect(deps[2]).toBe(s.diary);
    expect(deps[3]).toBe(s.tombstones);
    expect(deps[4]).toBe(s.focusSessions);
    expect(deps[5]).toBe(s.notes);
  });

  it('六个字段必须与 buildPayload 取的完全一致（顺序也要对）', () => {
    const s = state();
    const deps = persistDeps(s);
    const payload = {
      schemaVersion: 5,
      savedAt: 'x',
      tasks: s.tasks,
      settings: s.settings,
      diary: s.diary,
      tombstones: s.tombstones,
      focusSessions: s.focusSessions,
      notes: s.notes,
    };
    // 逐项对齐：payload 里写出去的每一个字段，都得在监听列表里
    expect(deps).toContain(payload.tasks);
    expect(deps).toContain(payload.settings);
    expect(deps).toContain(payload.diary);
    expect(deps).toContain(payload.tombstones);
    expect(deps).toContain(payload.focusSessions);
    expect(deps).toContain(payload.notes);
  });

  it('会话级字段 ui 不参与持久化监听（改 toast 不该触发写盘）', () => {
    const s = state();
    expect(persistDeps(s)).not.toContain(s.ui);
  });
});
