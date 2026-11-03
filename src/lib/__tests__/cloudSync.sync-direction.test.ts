import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_VERSION, SAVE_DEBOUNCE_MS, createDefaultSettings } from '../../constants';
import type { PersistedPayload } from '../../types';

/* ============================================================================
   P0 回归：同步方向必须能用"云端更新"这一侧

   曾经的 bug：设置页用 `savedAt: new Date().toISOString()` 构造本地载荷，
   `decideSyncAction` 拿"现在"跟云端的过去时刻比，pull-cloud 分支永远不可达 ——
   新设备登录会用空数组把云端真实数据覆盖掉。

   这里用假的 `cloud` 把整条 runSync 跑一遍，断言：
   - 本机从未落盘（local = null）+ 云端有数据 → 走恢复分支，且**一次写都不发**；
   - 本机确实更新 → 走上传分支；
   - 两边都空 → 什么都不做，不硬推空数据。
   ========================================================================= */

type DbCall = {
  op: 'select' | 'insert' | 'update' | 'delete';
  payload: Record<string, unknown> | null;
};

const h = vi.hoisted(() => ({
  session: null as { user: { id: string; phone: string | null } } | null,
  /** 依次喂给每一次 database 调用的结果；用完默认返回空数组（= 云端无数据） */
  results: [] as Array<{ data?: unknown; error?: unknown }>,
  calls: [] as DbCall[],
}));

vi.mock('../cloud', () => {
  const build = (): unknown => {
    const call: DbCall = { op: 'select', payload: null };
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
        getSession: async () => ({
          data: h.session ? { user: h.session.user } : null,
          error: null,
        }),
        onAuthStateChange: () => () => undefined,
        signOut: async () => undefined,
      },
      database: { from: () => build() },
    },
  };
});

const {
  decideSyncAction,
  flushCloudPush,
  getLocalSavedAt,
  noteLocalSavedAt,
  noteSyncFailure,
  noteSyncStart,
  runSync,
  scheduleCloudPush,
} = await import('../cloudSync');

const ONE_TASK = [{
  id: 't1', title: '编辑后的任务', note: '', date: '2026-10-24', time: '09:00',
  priority: 'high', category: '学习', done: false, doneAt: null,
  createdAt: '2026-10-24T01:00:00.000Z', updatedAt: '2026-10-24T02:00:00.000Z',
}] as unknown[];

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

const CLOUD_TASK = [
  {
    id: 't1',
    title: '云端的真实任务',
    note: '',
    date: '2026-10-24',
    time: null,
    priority: 'medium' as const,
    category: '学习',
    done: false,
    doneAt: null,
    createdAt: '2026-10-24T01:00:00.000Z',
    updatedAt: '2026-10-24T01:00:00.000Z',
    parentId: null,
  },
];

beforeEach(() => {
  h.session = { user: { id: 'u_1', phone: '13812345678' } };
  h.results = [];
  h.calls = [];
  noteSyncFailure();
});

describe('P0：新设备登录不能把云端盖成空的', () => {
  it('decideSyncAction(null, 云端有数据) → pull-cloud', () => {
    const remote = { payload: payloadAt('2026-10-24T12:00:00.000Z', CLOUD_TASK), savedAt: '2026-10-24T12:00:00.000Z', taskCount: 1 };
    expect(decideSyncAction(null, remote)).toBe('pull-cloud');
  });

  it('runSync(null) + 云端有数据 → pulled，且一次 insert/update 都不发', async () => {
    const cloudPayload = payloadAt('2026-10-24T12:00:00.000Z', CLOUD_TASK);
    h.results = [{ data: [{ id: 7, payload: cloudPayload, saved_at: '2026-10-24T12:00:00.000Z' }] }];

    const result = await runSync(null);

    expect(result.status).toBe('pulled');
    if (result.status !== 'pulled') return;
    expect(result.payload).toEqual(cloudPayload);
    expect(h.calls.filter((c) => c.op === 'insert' || c.op === 'update')).toHaveLength(0);
  });

  it('runSync(null) + 云端也是空的 → unchanged，不硬推一份空数据上去', async () => {
    h.results = [{ data: [] }];

    const result = await runSync(null);

    expect(result.status).toBe('unchanged');
    expect(h.calls.filter((c) => c.op === 'insert' || c.op === 'update')).toHaveLength(0);
  });
});

describe('两边都有数据 → 任务级合并，绝不整包互盖', () => {
  it('本地 savedAt 晚于云端、同 id 不同内容 → 合并后取本机（merged）', async () => {
    h.results = [
      { data: [{ id: 7, payload: payloadAt('2026-10-24T10:00:00.000Z', CLOUD_TASK), saved_at: '2026-10-24T10:00:00.000Z' }] },
      { data: [{ id: 7 }] },
      { data: [{ id: 7 }] },
    ];

    // 本机 t1「编辑后的任务」与云端 t1「云端的真实任务」同 id 不同内容、updatedAt 相同
    // → 旧逻辑会整包互盖（晚保存的一边赢）；新逻辑按 id 合并，相等取本机
    const result = await runSync(payloadAt('2026-10-24T11:00:00.000Z', ONE_TASK));

    expect(result.status).toBe('merged');
    if (result.status !== 'merged') return;
    expect(result.payload.tasks).toHaveLength(1);
    expect(result.payload.tasks[0].title).toBe('编辑后的任务');
    expect(h.calls.some((c) => c.op === 'update')).toBe(true);
  });

  it('两边各有独有任务 → 合并后一条不丢', async () => {
    const remoteOnly = [{
      id: 'r1', title: '云端独有的任务', note: '', date: '2026-10-24', time: null,
      priority: 'medium' as const, category: '学习', done: false, doneAt: null,
      createdAt: '2026-10-24T01:00:00.000Z', updatedAt: '2026-10-24T02:00:00.000Z',
    }];
    h.results = [
      { data: [{ id: 7, payload: payloadAt('2026-10-24T10:00:00.000Z', remoteOnly), saved_at: '2026-10-24T10:00:00.000Z' }] },
      { data: [{ id: 7 }] },
      { data: [{ id: 7 }] },
    ];

    const result = await runSync(payloadAt('2026-10-24T11:00:00.000Z', ONE_TASK));

    expect(result.status).toBe('merged');
    if (result.status !== 'merged') return;
    // 旧逻辑"晚保存的一方整包赢"会在这里吞掉另一台设备的新增；合并后两条都在
    expect(result.payload.tasks.map((t) => t.id).sort()).toEqual(['r1', 't1']);
  });
});

describe('本机为空 + 云端有数据 → 恢复，不上推', () => {
  it('本地 savedAt 早于云端 → pulled（同一台机器的双设备场景）', async () => {
    const cloudPayload = payloadAt('2026-10-24T12:00:00.000Z', CLOUD_TASK);
    h.results = [{ data: [{ id: 7, payload: cloudPayload, saved_at: '2026-10-24T12:00:00.000Z' }] }];

    const result = await runSync(payloadAt('2026-10-24T10:00:00.000Z'));

    expect(result.status).toBe('pulled');
    expect(h.calls.filter((c) => c.op === 'insert' || c.op === 'update')).toHaveLength(0);
  });
});

describe('getLocalSavedAt / noteLocalSavedAt', () => {
  it('登记的是真实落盘时间，而不是调用时刻', () => {
    const real = '2026-10-24T09:00:00.000Z';
    noteLocalSavedAt(real);
    expect(getLocalSavedAt()).toBe(real);
  });

  it('空字符串不覆盖已有记录', () => {
    noteLocalSavedAt('2026-10-24T09:00:00.000Z');
    noteLocalSavedAt('');
    expect(getLocalSavedAt()).toBe('2026-10-24T09:00:00.000Z');
  });
});

describe('同步进行中的编辑不会被丢弃', () => {
  it('flushCloudPush 遇到上一轮还在飞：重新排期，结束后补推', async () => {
    vi.useFakeTimers();
    try {
      h.results = [{ data: [] }, { data: [{ id: 1 }] }];

      scheduleCloudPush(payloadAt('2026-10-24T10:00:00.000Z', ONE_TASK));
      noteSyncStart(); // 模拟上一轮同步还在飞

      const during = await flushCloudPush();
      expect(during).toBeNull();
      expect(h.calls).toHaveLength(0); // 此刻确实没发请求

      noteSyncFailure(); // 上一轮结束
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 20);

      // 关键：这次编辑没有丢，重新排期后被真正推了上去
      expect(h.calls.filter((c) => c.op === 'insert')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
