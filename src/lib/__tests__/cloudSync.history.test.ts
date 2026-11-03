import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_VERSION, createDefaultSettings } from '../../constants';
import type { PersistedPayload } from '../../types';

/* ============================================================================
   历史版本（cloudSync.listHistory / restoreHistory）

   历史是「误删 / 坏数据的最后一道退路」，所以这里的断言落点是：
   —— 没登录时一次请求都不许发；
   —— 云端还没产生过覆盖时，"没有历史"是正常结果，不是错误；
   —— 回滚必须把旧版本推回云端，且回滚后自动推送要恢复（否则"清空云端
      → 从历史恢复"这条路走完仍然是停摆状态）。
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
    SYNC_HISTORY_TABLE: 'todo_sync_history',
    isCloudRuntimeAvailable: () => true,
    cloud: {
      auth: {
        getSession: async () => ({
          data: h.session ? { user: h.session.user } : null,
          error: null,
        }),
        onAuthStateChange: () => () => undefined,
        signOut: async () => undefined,
      },
      database: { from: (table: string) => build(table) },
    },
  };
});

const {
  clearRemoteSnapshot,
  flushCloudPush,
  listHistory,
  restoreHistory,
  scheduleCloudPush,
} = await import('../cloudSync');

const SESSION = { user: { id: 'u-1', phone: '+86 13800000000' } };

function payload(taskCount: number, savedAt = '2026-10-25T01:00:00.000Z'): PersistedPayload {
  const tasks = Array.from({ length: taskCount }, (_, i) => ({
    id: `t${i}`,
    title: `任务${i}`,
    note: '',
    done: false,
    date: '2026-10-25',
    categoryId: null,
    priority: 'medium' as const,
    createdAt: savedAt,
    updatedAt: savedAt,
    parentId: null,
  }));
  return {
    schemaVersion: SCHEMA_VERSION,
    savedAt,
    tasks: tasks as unknown as PersistedPayload['tasks'],
    settings: createDefaultSettings('2026-10-25'),
    diary: [],
    tombstones: [],
    focusSessions: [],
    notes: [],
  };
}

beforeEach(() => {
  h.session = SESSION;
  h.results = [];
  h.calls = [];
});

describe('listHistory', () => {
  it('未登录时不发任何请求', async () => {
    h.session = null;
    const result = await listHistory();
    expect(result.status).toBe('signed-out');
    expect(h.calls).toHaveLength(0);
  });

  it('正常返回历史条目，任务数从 payload 里算出来', async () => {
    h.results = [
      {
        data: [
          {
            id: 3,
            payload: payload(2),
            saved_at: '2026-10-25T01:00:00.000Z',
            archived_at: '2026-10-25T01:10:00.000Z',
            archived_reason: 'UPDATE',
          },
          {
            id: 2,
            payload: payload(5),
            saved_at: '2026-10-25T00:00:00.000Z',
            archived_at: '2026-10-25T00:30:00.000Z',
            archived_reason: 'DELETE',
          },
        ],
      },
    ];
    const result = await listHistory();
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].taskCount).toBe(2);
    expect(result.entries[1].taskCount).toBe(5);
    expect(result.entries[1].reason).toBe('DELETE');
    // 必须查的是历史表，不是同步表
    expect(h.calls[0].table).toBe('todo_sync_history');
    expect(h.calls[0].op).toBe('select');
  });

  it('云端还没有历史时返回空列表，而不是报错', async () => {
    h.results = [{ data: [] }];
    const result = await listHistory();
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.entries).toEqual([]);
  });

  it('读取失败按错误口径返回，不伪装成"没有历史"', async () => {
    h.results = [{ data: null, error: { message: 'boom', code: '42501' } }];
    const result = await listHistory();
    expect(result.status).toBe('error');
  });
});

describe('restoreHistory', () => {
  it('未登录时不发任何请求', async () => {
    h.session = null;
    const result = await restoreHistory(3);
    expect(result.status).toBe('signed-out');
    expect(h.calls).toHaveLength(0);
  });

  it('该版本不存在时报错，且绝不写云端', async () => {
    h.results = [{ data: [] }];
    const result = await restoreHistory(999);
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.error.message).toContain('已不存在');
    // 只读了一次历史表，没有后续写入
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].op).toBe('select');
  });

  it('回滚成功：把旧版本推回云端并返回给调用方 hydrate', async () => {
    const old = payload(4, '2026-10-24T20:00:00.000Z');
    h.results = [
      { data: [{ payload: old }] }, // 读历史版本
      { data: [{ id: 7 }] }, // findLatestRowId
      { data: [{ id: 7 }] }, // update 写回云端
    ];
    const result = await restoreHistory(3);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.payload.tasks).toHaveLength(4);

    const written = h.calls.find((c) => c.op === 'update' && c.table === 'todo_sync');
    expect(written).toBeTruthy();
    expect((written?.payload as { payload: { tasks: unknown[] } }).payload.tasks).toHaveLength(4);
  });

  /**
   * 「清空云端」会暂停自动推送（否则本机数据立刻被推回去，清空失去意义）。
   * 从历史回滚回来之后必须恢复 —— 否则用户走完"清空 → 回滚"这条修复路径，
   * 同步却永久停在暂停状态，下次编辑再也上不了云。
   */
  it('清空云端后再从历史回滚，自动推送恢复', async () => {
    // 1) 清空云端（探行 → delete），成功后自动推送进入暂停
    h.results = [{ data: [{ id: 7 }] }, { data: [{ id: 7 }] }];
    const cleared = await clearRemoteSnapshot();
    expect(cleared.status).toBe('ok');

    // 暂停期间：排一次推送，flush 应该什么都不做（不发请求）
    h.calls = [];
    h.results = [];
    scheduleCloudPush(payload(3));
    await flushCloudPush();
    expect(h.calls).toHaveLength(0);

    // 2) 从历史回滚
    h.calls = [];
    h.results = [
      { data: [{ payload: payload(3) }] },
      { data: [{ id: 8 }] },
      { data: [{ id: 8 }] },
    ];
    const restored = await restoreHistory(3);
    expect(restored.status).toBe('ok');

    // 3) 暂停已解除：再排一次推送，flush 必须真的发出请求
    h.calls = [];
    h.results = [{ data: [] }, { data: [] }, { data: [{ id: 9 }] }];
    scheduleCloudPush(payload(3));
    await flushCloudPush();
    expect(h.calls.length).toBeGreaterThan(0);
  });
});
