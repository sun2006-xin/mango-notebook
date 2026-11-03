// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_VERSION, createDefaultSettings } from '../../constants';
import type { PersistedPayload } from '../../types';

/* ============================================================================
   离线写入队列（⑦）· 与云同步的接线
   ----------------------------------------------------------------------------
   要守住的四个行为（每一条都对应一个真实场景）：

   ① **离线时不撞墙**：不发请求、不累计失败次数。
      （原来是"照试不误"：地铁里待 3 分钟就把自动同步试到停摆。）
   ② **离线的改动落盘**：outbox 记一笔，刷新之后依然知道"还有东西没上去"。
   ③ **网络恢复能自己跑起来**：解除停摆 + 立刻补推，不用用户手点。
   ④ **送达即清空**：队列空了，设置页那个"N 条待上传"才会消失。

   mock 方式与 autoSync.test.ts / cloudSync.runtime.test.ts 同源：假 cloud SDK，
   不发真实网络请求。
   ========================================================================= */

type DbCall = {
  table: string;
  op: 'select' | 'insert' | 'update' | 'delete';
  payload: Record<string, unknown> | null;
};

const h = vi.hoisted(() => ({
  session: null as { user: { id: string; phone: string | null } } | null,
  sessionThrows: false,
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
    SYNC_HISTORY_TABLE: 'todo_sync_history',
    isCloudRuntimeAvailable: () => true,
    cloud: {
      auth: {
        getSession: async () => {
          if (h.sessionThrows) throw new Error('Failed to fetch');
          return { data: h.session ? { user: h.session.user } : null, error: null };
        },
        onAuthStateChange: () => () => undefined,
        signOut: async () => undefined,
      },
      database: { from: (table: string) => build(table) },
    },
  };
});

const {
  getAutoSyncFailures,
  isAutoSyncPaused,
  noteSyncFailure,
  resetAutoSyncFailures,
  resumeAutoSync,
  runAutoSync,
  runSync,
  flushCloudPush,
  scheduleCloudPush,
} = await import('../cloudSync');
const { clearOutbox, getPendingCount, hasPendingOutbox, readOutbox } = await import('../outbox');

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

/** 模拟浏览器离线 / 在线（jsdom 的 navigator.onLine 是只读 getter，得重定义） */
function setOnline(online: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', { value: online, configurable: true });
}

let clock = 1_700_000_000_000;
function advance(): void {
  clock += 20_000;
  vi.setSystemTime(clock);
}

beforeEach(() => {
  vi.useFakeTimers();
  clock += 600_000;
  vi.setSystemTime(clock);
  h.session = null;
  h.sessionThrows = false;
  h.results = [];
  h.calls = [];
  localStorage.clear();
  clearOutbox();
  resetAutoSyncFailures();
  noteSyncFailure();
  setOnline(true);
});

afterEach(() => {
  vi.useRealTimers();
  setOnline(true);
});

describe('离线：不发请求、不累计失败、改动落盘', () => {
  it('flushCloudPush 离线 → 一个请求都不发，outbox 记一条 offline', async () => {
    signIn();
    setOnline(false);

    scheduleCloudPush(payloadAt('2026-10-24T10:00:00.000Z', ONE_TASK));
    const result = await flushCloudPush();

    expect(result).toBeNull();
    expect(h.calls).toHaveLength(0);
    expect(getPendingCount()).toBe(1);
    expect(readOutbox().entries[0].reason).toBe('offline');
  });

  it('runAutoSync 离线 → 直接放过，失败计数不动（不会把自动同步试到停摆）', async () => {
    signIn();
    setOnline(false);

    for (let i = 0; i < 5; i += 1) {
      advance();
      const outcome = await runAutoSync(() => payloadAt('2026-10-24T10:00:00.000Z', ONE_TASK));
      expect(outcome).toBeNull();
    }

    expect(getAutoSyncFailures()).toBe(0);
    expect(isAutoSyncPaused()).toBe(false);
    expect(h.calls).toHaveLength(0);
  });

  it('离线的那次尝试不消耗最小间隔：网络一恢复就能立刻跑', async () => {
    signIn();
    setOnline(false);
    advance();
    await runAutoSync(() => payloadAt('2026-10-24T10:00:00.000Z', ONE_TASK));

    // 网络恢复，时间只走了 1 秒（仍在 15s 最小间隔内）
    setOnline(true);
    clock += 1_000;
    vi.setSystemTime(clock);
    h.results = [{ data: [{ id: 7, payload: payloadAt('2026-10-24T09:00:00.000Z', ONE_TASK), saved_at: '2026-10-24T09:00:00.000Z' }] }];

    const outcome = await runAutoSync(() => payloadAt('2026-10-24T10:00:00.000Z', ONE_TASK));
    expect(outcome?.status).toBe('unchanged');
  });

  it('空设备（一条数据都没有）失败不记队列：不该显示"1 条待上传"', async () => {
    signIn();
    h.results = [{ data: null, error: { code: 'PGRST301', message: 'boom' } }];

    scheduleCloudPush(payloadAt('2026-10-24T10:00:00.000Z', []));
    await flushCloudPush();

    expect(hasPendingOutbox()).toBe(false);
  });
});

describe('网络抖过之后：队列留着，送达即清空', () => {
  it('拉取失败 → 记一条 error（刷新之后还知道没送上去）', async () => {
    signIn();
    h.results = [{ data: null, error: { code: 'PGRST301', message: 'boom' } }];

    scheduleCloudPush(payloadAt('2026-10-24T10:00:00.000Z', ONE_TASK));
    await flushCloudPush();

    expect(getPendingCount()).toBe(1);
    expect(readOutbox().entries[0].reason).toBe('error');
  });

  it('下一次推送成功 → 队列清空', async () => {
    signIn();
    h.results = [{ data: null, error: { code: 'PGRST301', message: 'boom' } }];
    scheduleCloudPush(payloadAt('2026-10-24T10:00:00.000Z', ONE_TASK));
    await flushCloudPush();
    expect(hasPendingOutbox()).toBe(true);

    h.results = [{ data: [] }, { data: [] }, { data: [{ id: 1 }] }];
    const result = await flushCloudPush();

    expect(result?.status).toBe('ok');
    expect(hasPendingOutbox()).toBe(false);
  });

  it('runSync 推送成功也会清空（手动「立即同步」同样算送达）', async () => {
    signIn();
    h.results = [{ data: null, error: { code: 'PGRST301', message: 'boom' } }];
    await runSync(payloadAt('2026-10-24T10:00:00.000Z', ONE_TASK));
    expect(hasPendingOutbox()).toBe(true);

    // 云端没有数据 → push-local，一次 insert
    h.results = [{ data: [] }, { data: [] }, { data: [{ id: 9 }] }];
    const outcome = await runSync(payloadAt('2026-10-24T10:00:00.000Z', ONE_TASK));

    expect(outcome.status).toBe('pushed');
    expect(hasPendingOutbox()).toBe(false);
  });

  it('稳定态（云端内容一模一样）也算送达 → 清空', async () => {
    signIn();
    const cloud = payloadAt('2026-10-24T10:00:00.000Z', ONE_TASK);
    h.results = [{ data: null, error: { code: 'PGRST301', message: 'boom' } }];
    await runSync(payloadAt('2026-10-24T10:00:00.000Z', ONE_TASK));
    expect(hasPendingOutbox()).toBe(true);

    h.results = [{ data: [{ id: 7, payload: cloud, saved_at: '2026-10-24T10:00:00.000Z' }] }];
    const outcome = await runSync(payloadAt('2026-10-24T10:00:00.000Z', ONE_TASK));

    expect(outcome.status).toBe('unchanged');
    expect(hasPendingOutbox()).toBe(false);
  });
});

describe('停摆与恢复（在线但一直失败）', () => {
  it('连续失败 3 次 → 停摆；resumeAutoSync 后能再跑（online 事件就是这么做的）', async () => {
    signIn();
    h.sessionThrows = true; // 在线但请求一直失败（热点没网 / 云端 500）

    for (let i = 0; i < 3; i += 1) {
      advance();
      await runAutoSync(() => payloadAt('2026-10-24T10:00:00.000Z', ONE_TASK));
    }
    expect(isAutoSyncPaused()).toBe(true);

    // 停摆期间再触发也不跑
    advance();
    expect(await runAutoSync(() => payloadAt('2026-10-24T10:00:00.000Z', ONE_TASK))).toBeNull();

    // 网络恢复 → useAutoSync 的 onOnline 先 resumeAutoSync 再 tick
    resumeAutoSync();
    h.sessionThrows = false;
    h.results = [{ data: [] }, { data: [] }, { data: [{ id: 9 }] }];
    advance();
    const outcome = await runAutoSync(() => payloadAt('2026-10-24T10:00:00.000Z', ONE_TASK));

    expect(outcome?.status).toBe('pushed');
    expect(hasPendingOutbox()).toBe(false);
  });
});
