import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HYDRATE_TIMEOUT_MS, createDefaultSettings } from '../../constants';
import type { AppState, Task } from '../../types';

/* ============================================================================
   启动装载链路纯函数回归（无 jsdom：只测导出的 createInitialState /
   runNativeHydration，React 装配层不渲染）

   mock 策略：
   - storage 模块整体 mock：平台分流的两条路径由此控制（isNativeStorage），
     loadPersisted / loadPersistedAsync 的结果由 h.loadResult 喂入；
   - cloudSync 只 mock noteLocalSavedAt：避免装载真实云 SDK
     （其会话存 localStorage，node 下无此全局）。
   ========================================================================= */

const h = vi.hoisted(() => ({
  /** 平台探测开关（mock isNativeStorage 的返回值） */
  native: false,
  /** 喂给 loadPersisted / loadPersistedAsync 的装载结果 */
  loadResult: null as { payload: unknown; error: string | null; backupCreated: boolean } | null,
}));

vi.mock('../../lib/storage', () => ({
  isNativeStorage: vi.fn(() => h.native),
  loadPersisted: vi.fn(() => h.loadResult),
  loadPersistedAsync: vi.fn(async () => h.loadResult),
}));

vi.mock('../../lib/cloudSync', () => ({
  noteLocalSavedAt: vi.fn(),
}));

import { createInitialState, runNativeHydration } from '../StoreContext';
import { isNativeStorage, loadPersisted, loadPersistedAsync } from '../../lib/storage';
import type { LoadResult } from '../../lib/storage';
import { noteLocalSavedAt } from '../../lib/cloudSync';
import { createEmptyState, reducer, stateFromLoad, type AppAction } from '../reducer';

const TASK = {
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
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  parentId: null,
} as unknown as Task;

const SAVED_AT = '2026-10-24T12:00:00.000Z';

function loadWithOneTask(): LoadResult {
  return {
    payload: {
      schemaVersion: 2,
      savedAt: SAVED_AT,
      tasks: [TASK],
      settings: createDefaultSettings('2026-10-24'),
      diary: [],
      tombstones: [],
      focusSessions: [],
      notes: [],
    },
    error: null,
    backupCreated: false,
  };
}

beforeEach(() => {
  h.native = false;
  h.loadResult = null;
  vi.mocked(isNativeStorage).mockClear();
  vi.mocked(loadPersisted).mockClear();
  vi.mocked(loadPersistedAsync).mockClear();
  vi.mocked(noteLocalSavedAt).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ============================================================================
   createInitialState —— 非原生（网页 / 桌面）：与改前逐字段一致
   ========================================================================= */
describe('createInitialState —— 非原生', () => {
  it('同步装载、hydrating=false，与改前 stateFromLoad(loadPersisted()) 逐字段一致', () => {
    const load = loadWithOneTask();
    h.loadResult = load;

    const state = createInitialState();

    // 改前行为 = bootstrap() = stateFromLoad(loadPersisted())
    expect(state).toEqual(stateFromLoad(load));
    expect(state.ui.hydrating).toBe(false);
    expect(state.tasks).toHaveLength(1);
    expect(loadPersisted).toHaveBeenCalledTimes(1);
    expect(loadPersistedAsync).not.toHaveBeenCalled();
  });

  it('启动装载即登记落盘时间（登记点从 usePersist 上移后的新位置）', () => {
    h.loadResult = loadWithOneTask();
    createInitialState();
    expect(noteLocalSavedAt).toHaveBeenCalledWith(SAVED_AT);
  });

  it('空库（payload=null）不登记落盘时间', () => {
    h.loadResult = { payload: null, error: null, backupCreated: false };
    const state = createInitialState();
    expect(state.tasks).toEqual([]);
    expect(state.ui.storageError).toBeNull();
    expect(noteLocalSavedAt).not.toHaveBeenCalled();
  });
});

/* ============================================================================
   createInitialState —— 原生（APK 新链路）：hydrating 空态
   ========================================================================= */
describe('createInitialState —— 原生', () => {
  it('hydrating=true 空态，初始化阶段不读任何存储', () => {
    h.native = true;
    const state = createInitialState();
    expect(state.ui.hydrating).toBe(true);
    expect(state.tasks).toEqual([]);
    expect(state.diary).toEqual([]);
    expect(state.settings.categories).toHaveLength(4);
    expect(loadPersisted).not.toHaveBeenCalled();
    expect(loadPersistedAsync).not.toHaveBeenCalled(); // 装载在 effect 里跑
  });
});

/* ============================================================================
   runNativeHydration —— 异步装载 + HYDRATE + 登记
   ========================================================================= */
describe('runNativeHydration —— 正常路径', () => {
  it('dispatch HYDRATE 且 hydrating=false、登记真实 savedAt', async () => {
    h.native = true;
    h.loadResult = loadWithOneTask();
    const dispatched: AppAction[] = [];

    await runNativeHydration((action) => {
      dispatched.push(action);
    });

    expect(loadPersistedAsync).toHaveBeenCalledTimes(1);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.type).toBe('HYDRATE');

    // 过一遍真 reducer：门控标记被打开、数据装进状态
    const hydrating: AppState = {
      ...createEmptyState(),
      ui: { ...createEmptyState().ui, hydrating: true },
    };
    const after = reducer(hydrating, dispatched[0] as AppAction);
    expect(after.ui.hydrating).toBe(false);
    expect(after.tasks).toHaveLength(1);
    expect(after.tasks[0]?.title).toBe('数学真题');

    // 登记的是真实落盘时间，不是"现在"
    expect(noteLocalSavedAt).toHaveBeenCalledWith(SAVED_AT);
  });

  it('空库装载：dispatch 空态 HYDRATE，storageError 为 null', async () => {
    h.native = true;
    h.loadResult = { payload: null, error: null, backupCreated: false };
    const dispatched: AppAction[] = [];

    await runNativeHydration((action) => dispatched.push(action));

    const after = reducer(createEmptyState(), dispatched[0] as AppAction);
    expect(after.tasks).toEqual([]);
    expect(after.ui.storageError).toBeNull();
    expect(after.ui.hydrating).toBe(false);
    expect(noteLocalSavedAt).not.toHaveBeenCalled();
  });

  it('corrupt 装载：HYDRATE 带错误文案（与 stateFromLoad 同源）', async () => {
    h.native = true;
    h.loadResult = { payload: null, error: 'corrupt', backupCreated: true };
    const dispatched: AppAction[] = [];

    await runNativeHydration((action) => dispatched.push(action));

    const after = reducer(createEmptyState(), dispatched[0] as AppAction);
    expect(after.ui.storageError).toBe('数据读取失败，已重置（原始数据已备份）');
  });

  it('装载成功后清理超时定时器（无悬挂句柄）', async () => {
    vi.useFakeTimers();
    try {
      h.native = true;
      h.loadResult = loadWithOneTask();
      await runNativeHydration(() => {});
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ============================================================================
   runNativeHydration —— 超时兜底 + 迟到丢弃（R5）
   ========================================================================= */
describe('runNativeHydration —— 超时兜底（重试一次，仍失败则只读）', () => {
  /**
   * v0.29.2 修正的关键点：超时**不再**直接给一个可编辑的空应用。
   *
   * 旧行为实测后果：空态 + 门控打开 + `usePersist` 照常落盘，用户随手加一条
   * 任务就把盘上那份真实数据整包覆盖了，而 Toast 还写着"本次改动不会保存"。
   * 现在：先重试一次（存储常常只是慢），两次都读不出来才降级为**只读**
   * （`persistBlocked`），并由全局写盘闸门拦住所有保存。
   */
  it('第一次超时 → 不急着兜底，先重试', async () => {
    vi.useFakeTimers();
    try {
      h.native = true;
      h.loadResult = null;
      const resolves: Array<(value: LoadResult) => void> = [];
      vi.mocked(loadPersistedAsync).mockImplementation(
        () =>
          new Promise<LoadResult>((resolve) => {
            resolves.push(resolve);
          }),
      );

      const dispatched: AppAction[] = [];
      const done = runNativeHydration((action) => dispatched.push(action));

      await vi.advanceTimersByTimeAsync(HYDRATE_TIMEOUT_MS + 10);
      // 第一次超时：只发起重试，不 dispatch 空态
      expect(dispatched).toHaveLength(0);
      expect(vi.mocked(loadPersistedAsync).mock.calls.length).toBe(2);

      // 第二次成功 → 装载真实数据
      resolves[1](loadWithOneTask());
      await done;
      expect(dispatched).toHaveLength(1);
      const action = dispatched[0];
      expect(action.type).toBe('HYDRATE');
      if (action.type !== 'HYDRATE') return;
      expect(action.tasks).toHaveLength(1);
      expect(action.persistBlocked).toBe(false);
      expect(noteLocalSavedAt).toHaveBeenCalledWith(SAVED_AT);
    } finally {
      vi.useRealTimers();
    }
  });

  it('两次都超时 → 只读兜底（persistBlocked），迟到的真实结果被丢弃', async () => {
    vi.useFakeTimers();
    try {
      h.native = true;
      h.loadResult = null;
      const resolves: Array<(value: LoadResult) => void> = [];
      vi.mocked(loadPersistedAsync).mockImplementation(
        () =>
          new Promise<LoadResult>((resolve) => {
            resolves.push(resolve);
          }),
      );

      const dispatched: AppAction[] = [];
      const done = runNativeHydration((action) => dispatched.push(action));

      await vi.advanceTimersByTimeAsync(HYDRATE_TIMEOUT_MS + 10);
      expect(dispatched).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(HYDRATE_TIMEOUT_MS + 10);
      await done;

      expect(dispatched).toHaveLength(1);
      const fallback = dispatched[0];
      expect(fallback.type).toBe('HYDRATE');
      if (fallback.type !== 'HYDRATE') return;
      // 关键：只读，否则空态会覆盖盘上那份数据
      expect(fallback.persistBlocked).toBe(true);
      expect(fallback.storageError).toContain('只读');

      // 迟到的真实结果：直接丢弃，不再 dispatch、不登记落盘时间
      resolves.forEach((resolve) => resolve(loadWithOneTask()));
      await Promise.resolve();
      expect(dispatched).toHaveLength(1);
      expect(noteLocalSavedAt).not.toHaveBeenCalled();

      // 兜底态本身是合法空态，且门控打开（不会把用户永远卡在启动页）
      const after = reducer(createEmptyState(), fallback);
      expect(after.tasks).toEqual([]);
      expect(after.ui.hydrating).toBe(false);
      expect(after.ui.persistBlocked).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
