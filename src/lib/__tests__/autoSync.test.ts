import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_VERSION, createDefaultSettings } from '../../constants';
import type { PersistedPayload } from '../../types';

/* ============================================================================
   后台自动同步（用户报的"同步有时候不管用"）+ 失败提示节流（"老弹没权限"）

   为什么这两个要一起测：它们本来就是同一条链路上的两端 ——
   自动同步是"让同步真的会发生"，节流是"让失败不至于变成提示洪水"。

   mock 方式与 cloudSync.runtime.test.ts 同源：假 cloud SDK，不发真实网络请求。
   ========================================================================= */

type DbCall = {
  table: string;
  op: 'select' | 'insert' | 'update' | 'delete';
  payload: Record<string, unknown> | null;
};

const h = vi.hoisted(() => ({
  session: null as { user: { id: string; phone: string | null } } | null,
  results: [] as Array<{ data?: unknown; error?: unknown }>,
  calls: [] as DbCall[],
}));

vi.mock('../cloud', () => {
  const build = (table: string): unknown => {
    const call: DbCall = { table, op: 'select', payload: null };
    const builder: Record<string, unknown> = {
      select: () => builder,
      insert: (payload: Record<string, unknown>) => {
        call.op = 'insert';
        call.payload = payload;
        return builder;
      },
      update: (payload: Record<string, unknown>) => {
        call.op = 'update';
        call.payload = payload;
        return builder;
      },
      delete: () => {
        call.op = 'delete';
        return builder;
      },
      eq: () => builder,
      order: () => builder,
      limit: () => builder,
      then: (onOk: (v: unknown) => unknown, onErr: (e: unknown) => unknown) => {
        h.calls.push({ ...call });
        const next = h.results.shift() ?? { data: [], error: null };
        return Promise.resolve(next).then(onOk, onErr);
      },
    };
    return builder;
  };

  return {
    SYNC_TABLE: 'todo_sync',
    cloud: {
      auth: {
        getSession: async () => ({ data: h.session ? { user: h.session.user } : null, error: null }),
        onAuthStateChange: () => () => undefined,
        signOut: async () => undefined,
      },
      database: { from: (table: string) => build(table) },
    },
  };
});

const {
  AUTO_SYNC_PAUSED_MESSAGE,
  getAutoSyncFailures,
  isAutoSyncPaused,
  noteSyncFailure,
  resetAutoSyncFailures,
  runAutoSync,
  runSync,
  setCloudErrorHandler,
  setCloudMergeHandler,
} = await import('../cloudSync');

const ONE_TASK = [
  {
    id: 't1',
    title: '别丢了我',
    note: '',
    date: '2026-10-24',
    time: '09:00',
    priority: 'high',
    category: '学习',
    done: false,
    doneAt: null,
    createdAt: '2026-10-24T01:00:00.000Z',
    updatedAt: '2026-10-24T01:00:00.000Z',
  },
] as unknown[];

function payloadAt(savedAt: string, tasks: unknown[] = []): PersistedPayload {
  return {
    schemaVersion: SCHEMA_VERSION,
    savedAt,
    tasks: tasks as PersistedPayload['tasks'],
    settings: createDefaultSettings('2026-10-24'),
    diary: [],
    tombstones: [],
    focusSessions: [],
    notes: [],
  };
}

function signIn(): void {
  h.session = { user: { id: 'u_1', phone: '13812345678' } };
}

/** runAutoSync 有 15s 最小间隔：每次调用前把时钟往前推，模拟"真的过了一会儿" */
let clock = 1_700_000_000_000;
function advance(): void {
  clock += 20_000;
  vi.setSystemTime(clock);
}

/**
 * 每个用例之间把时钟推过 5 分钟的提示冷却期。
 *
 * 提示节流（`lastNotifiedAt`）是**模块级**状态，跨用例存活 —— 前一个用例
 * 若已经弹过同一句话，后面断言"只弹一次"的用例会因为还在冷却期而拿到 0 条。
 * 那不是被测代码的问题，是测试之间的状态泄漏，所以在这里隔开。
 */
function nextCase(): void {
  clock += 600_000;
  vi.setSystemTime(clock);
}

let messages: string[] = [];
let merged: PersistedPayload[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  nextCase();
  h.session = null;
  h.results = [];
  h.calls = [];
  messages = [];
  merged = [];
  resetAutoSyncFailures();
  noteSyncFailure(); // 清掉上一轮可能残留的 syncing
  setCloudErrorHandler((m) => messages.push(m));
  setCloudMergeHandler((p) => merged.push(p));
});

afterEach(() => {
  setCloudErrorHandler(null);
  setCloudMergeHandler(null);
  vi.useRealTimers();
});

describe('后台自动同步：不动本机也能收到另一台设备的改动', () => {
  it('云端独有数据 → 自动同步把合并结果交回本机（用户不点「立即同步」也会发生）', async () => {
    signIn();
    const remote = payloadAt('2026-10-24T10:00:00.000Z', ONE_TASK);
    h.results = [{ data: [{ id: 7, payload: remote, saved_at: '2026-10-24T10:00:00.000Z' }] }];

    advance();
    const outcome = await runAutoSync(() => payloadAt('2026-10-24T09:00:00.000Z', []));

    expect(outcome?.status).toBe('pulled');
    expect(merged).toHaveLength(1);
    expect(merged[0].tasks).toHaveLength(1);
    expect(merged[0].tasks[0].title).toBe('别丢了我');
  });

  it('两边内容一致 → 什么都不做，也不回调 hydrate（不制造保存环）', async () => {
    signIn();
    const same = payloadAt('2026-10-24T10:00:00.000Z', ONE_TASK);
    h.results = [{ data: [{ id: 7, payload: same, saved_at: '2026-10-24T10:00:00.000Z' }] }];

    advance();
    const outcome = await runAutoSync(() => payloadAt('2026-10-24T09:00:00.000Z', ONE_TASK));

    expect(outcome?.status).toBe('unchanged');
    expect(merged).toHaveLength(0);
  });

  it('未登录是合法状态：不算失败，也不把自动同步推进停摆', async () => {
    advance();
    const outcome = await runAutoSync(() => payloadAt('2026-10-24T09:00:00.000Z', ONE_TASK));

    expect(outcome?.status).toBe('signed-out');
    expect(getAutoSyncFailures()).toBe(0);
    expect(isAutoSyncPaused()).toBe(false);
    expect(h.calls).toHaveLength(0); // 一次云端调用都不发
  });

  it('最小间隔保护：连续两次调用，第二次直接跳过（事件风暴不能打爆云端）', async () => {
    signIn();
    h.results = [{ data: [] }];

    advance();
    await runAutoSync(() => payloadAt('2026-10-24T09:00:00.000Z', ONE_TASK));
    const afterFirst = h.calls.length;

    // 不推进时钟：立刻再来一次
    const second = await runAutoSync(() => payloadAt('2026-10-24T09:00:00.000Z', ONE_TASK));

    expect(second).toBeNull();
    expect(h.calls.length).toBe(afterFirst);
  });
});

describe('App 装配（源码级）：自动同步真的挂上了', () => {
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '');
  }
  const src = stripComments(readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8'));

  it('useAutoSync 挂在 App 上，且本机载荷走 buildPersistedPayload 这个唯一出口', () => {
    expect(src).toContain('useAutoSync(getLocalForSync)');
    expect(src).toContain('const payload = buildPersistedPayload(state);');
  });

  it('从未落盘 + 0 任务的设备判成"新设备"（不让空数据盖掉云端）', () => {
    expect(src).toContain('const savedAt = getLocalSavedAt();');
    expect(src).toContain('if (savedAt === null && state.tasks.length === 0) return null;');
  });

  it('后台合并保留本机当前视图（否则 60 秒一次同步会把正在写的页面抢走）', () => {
    expect(src).toContain('lastView: viewRef.current');
  });

  it('载荷的 savedAt 用真实落盘时间，不是「现在」', () => {
    /**
     * `mergeSnapshots` 用 local.savedAt 判 localNewer。若每次同步都拿 `new Date()`，
     * 本机就永远"比云端新"，另一台设备改的日界/默认视图/周起始日/分类顺序
     * 永远传不过来，还会被本机覆盖回去 —— 用户看到的是"设置改了不同步"。
     */
    expect(src).toContain('return savedAt ? { ...payload, savedAt } : payload;');
  });
});

describe('失败提示节流 + 连续失败停摆（"经常跳出没权限"）', () => {
  /** 每次失败都喂一个 RLS 拒绝（42501）—— 就是用户看到的"无权操作此数据" */
  function feedPermissionDenied(): void {
    h.results = [{ error: { message: 'new row violates row-level security policy', code: '42501' } }];
  }

  it('同一个后台错误连来两次，只提示一次', async () => {
    signIn();

    feedPermissionDenied();
    advance();
    await runAutoSync(() => payloadAt('2026-10-24T09:00:00.000Z', ONE_TASK));

    feedPermissionDenied();
    advance();
    await runAutoSync(() => payloadAt('2026-10-24T09:00:00.000Z', ONE_TASK));

    expect(messages.filter((m) => m === '无权操作此数据')).toHaveLength(1);
  });

  it('连续失败到上限 → 停摆，并明确告知一次"暂时不可用"', async () => {
    signIn();
    for (let i = 0; i < 3; i += 1) {
      feedPermissionDenied();
      advance();
      await runAutoSync(() => payloadAt('2026-10-24T09:00:00.000Z', ONE_TASK));
    }

    expect(isAutoSyncPaused()).toBe(true);
    expect(messages).toContain(AUTO_SYNC_PAUSED_MESSAGE);
  });

  it('停摆后不再发请求：每次保存都撞墙会把失败放大成网络风暴', async () => {
    signIn();
    for (let i = 0; i < 3; i += 1) {
      feedPermissionDenied();
      advance();
      await runAutoSync(() => payloadAt('2026-10-24T09:00:00.000Z', ONE_TASK));
    }
    const before = h.calls.length;

    advance();
    const outcome = await runAutoSync(() => payloadAt('2026-10-24T09:00:00.000Z', ONE_TASK));

    expect(outcome).toBeNull();
    expect(h.calls.length).toBe(before);
  });

  it('用户手动同步成功一次即解除停摆（设置页点「立即同步」是唯一出路）', async () => {
    signIn();
    for (let i = 0; i < 3; i += 1) {
      feedPermissionDenied();
      advance();
      await runAutoSync(() => payloadAt('2026-10-24T09:00:00.000Z', ONE_TASK));
    }
    expect(isAutoSyncPaused()).toBe(true);

    // 用户点「立即同步」→ runSync；两边内容一致 → unchanged（成功，且不需要写云端）
    const same = payloadAt('2026-10-24T10:00:00.000Z', ONE_TASK);
    h.results = [{ data: [{ id: 7, payload: same, saved_at: '2026-10-24T10:00:00.000Z' }] }];
    const outcome = await runSync(payloadAt('2026-10-24T09:00:00.000Z', ONE_TASK));

    expect(outcome.status).toBe('unchanged');
    expect(isAutoSyncPaused()).toBe(false);
    expect(getAutoSyncFailures()).toBe(0);
  });
});
