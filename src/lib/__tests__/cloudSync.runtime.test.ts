import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SAVE_DEBOUNCE_MS, SCHEMA_VERSION, createDefaultSettings } from '../../constants';
import type { PersistedPayload } from '../../types';

/* ============================================================================
   cloudSync 运行时路径（不登录 / 权限被拒 / 网络失败 / 写被 RLS 静默吞掉）

   这里用假的 `cloud` 替换真实 SDK：不发任何真实网络请求，也不碰真短信。
   断言的落点是"门禁 + 失败口径"，即：
   —— 没登录时 database 一次都不许被调用；
   —— 权限类错误要有明确口径，其它错误必须落到"不影响本机"。
   ========================================================================= */

type DbCall = {
  table: string;
  op: 'select' | 'insert' | 'update' | 'delete';
  payload: Record<string, unknown> | null;
};

/** vi.mock 工厂会被提升到文件顶部，外部变量必须经 vi.hoisted 声明 */
const h = vi.hoisted(() => ({
  session: null as { user: { id: string; phone: string | null } } | null,
  /** getSession 直接抛异常（模拟断网） */
  sessionThrows: false,
  /** getSession 返回的错误（模拟"会话明确失效"，如 401 / invalid_grant） */
  sessionError: null as Record<string, unknown> | null,
  /** 依次喂给每一次 database 调用的结果；用完默认返回空数组 */
  results: [] as Array<{ data?: unknown; error?: unknown }>,
  calls: [] as DbCall[],
}));

vi.mock('../cloud', () => {
  const build = (table: string): unknown => {
    const call: DbCall = { table, op: 'select', payload: null };
    const builder: Record<string, unknown> = {
      select: (...args: unknown[]) => {
        // delete().select('id') 也要能认出是 delete：select 不覆盖已定的写类型
        if (call.op !== 'insert' && call.op !== 'update' && call.op !== 'delete') call.op = 'select';
        void args;
        return builder;
      },
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
      // cloudSync 里 `await cloud.database.from(...).select(...)` 直接 await 这个对象
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
        getSession: async () => {
          if (h.sessionThrows) throw new Error('network down');
          return {
            data: h.session ? { user: h.session.user } : null,
            error: h.sessionError ?? null,
          };
        },
        onAuthStateChange: () => () => undefined,
        signOut: async () => undefined,
      },
      database: { from: (table: string) => build(table) },
    },
  };
});

const {
  clearRemoteSnapshot,
  decideSyncAction,
  flushCloudPush,
  getLastKnownRemoteCount,
  getLocalSavedAt,
  isAutoSyncBlockedByClear,
  noteLocalCleared,
  noteLocalSavedAt,
  noteSyncFailure,
  noteSyncStart,
  pullSnapshot,
  pushSnapshot,
  runSync,
  scheduleCloudPush,
  setCloudMergeHandler,
  syncErrorMessage,
} = await import('../cloudSync');

const ONE_TASK = [{
  id: 't1', title: '别丢了我', note: '', date: '2026-10-24', time: '09:00',
  priority: 'high', category: '学习', done: false, doneAt: null,
  createdAt: '2026-10-24T01:00:00.000Z', updatedAt: '2026-10-24T01:00:00.000Z',
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

function signIn(): void {
  h.session = { user: { id: 'u_1', phone: '13812345678' } };
}

beforeEach(() => {
  h.session = null;
  h.sessionThrows = false;
  h.sessionError = null;
  h.results = [];
  h.calls = [];
  noteSyncFailure(); // 清掉上一轮可能残留的 syncing
});

describe('未登录：一次云端读写都不发', () => {
  it('pullSnapshot 直接 signed-out，database 零调用', async () => {
    const result = await pullSnapshot();
    expect(result.status).toBe('signed-out');
    expect(h.calls).toHaveLength(0);
  });

  it('pushSnapshot 直接 signed-out，database 零调用', async () => {
    const result = await pushSnapshot(payloadAt('2026-10-24T10:00:00.000Z'));
    expect(result.status).toBe('signed-out');
    expect(h.calls).toHaveLength(0);
  });

  it('runSync 直接 signed-out，database 零调用', async () => {
    const result = await runSync(payloadAt('2026-10-24T10:00:00.000Z'));
    expect(result.status).toBe('signed-out');
    expect(h.calls).toHaveLength(0);
  });

  it('本机保存后挂起的自动推送：未登录时不发请求、不抛异常', async () => {
    scheduleCloudPush(payloadAt('2026-10-24T10:00:00.000Z', ONE_TASK));
    const result = await flushCloudPush();
    expect(result?.status).toBe('signed-out');
    expect(h.calls).toHaveLength(0);
  });

  /**
   * v0.12 修正：**断网 ≠ 掉登录**。
   *
   * 原来这里断言"getSession 抛异常也走 signed-out"——那条行为直接把用户
   * 判成未登录：设置页显示"登录同步"按钮、还弹"登录状态已失效，请重新登录"。
   * 用户以为要重登，其实凭据还在。这就是「每次更新或打开，登录总是掉」的根因。
   *
   * 现在只有明确的会话失效（401 / invalid_grant 等）才算 signed-out；
   * 网络异常一律按 error 上报（同步失败，数据仍在本机），**不动登录态**。
   */
  it('getSession 抛异常（断网）走 error，不把用户判成未登录', async () => {
    h.sessionThrows = true;
    await expect(pullSnapshot()).resolves.toMatchObject({ status: 'error' });
    await expect(pushSnapshot(payloadAt('2026-10-24T10:00:00.000Z'))).resolves.toMatchObject({
      status: 'error',
    });
    expect(h.calls).toHaveLength(0);
  });

  it('会话明确失效（401）才算真未登录', async () => {
    h.sessionThrows = false;
    h.sessionError = { code: 'invalid_grant', status: 401, message: 'refresh token expired' };
    await expect(pullSnapshot()).resolves.toMatchObject({ status: 'signed-out' });
  });

  it('没有 session 也没有 error = 真的没登录', async () => {
    h.sessionThrows = false;
    h.sessionError = null;
    h.session = null;
    await expect(pullSnapshot()).resolves.toMatchObject({ status: 'signed-out' });
  });
});

describe('错误口径', () => {
  it('42501（RLS 拒绝）要有明确的无权提示', async () => {
    signIn();
    h.results = [{ data: null, error: { code: '42501', message: 'new row violates row-level security' } }];

    const result = await runSync(payloadAt('2026-10-24T10:00:00.000Z'));
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.error.code).toBe('42501');
    expect(syncErrorMessage(result.error)).toBe('无权操作此数据');
  });

  it('其它云端错误 / 网络失败 → 同步失败，数据仍在本机', async () => {
    signIn();
    h.results = [{ data: null, error: { code: 'PGRST301', message: 'connection error' } }];

    const result = await runSync(payloadAt('2026-10-24T10:00:00.000Z'));
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(syncErrorMessage(result.error)).toBe('同步失败，数据仍在本机');
  });

  it('SDK 直接抛异常时 runSync 也要收敛成 error，不向上冒泡', async () => {
    signIn();
    // 结果队列留空 → 返回空数组（无数据）后走到 push，push 也返回空数组 → 视为被拦
    const result = await runSync(payloadAt('2026-10-24T10:00:00.000Z'));
    expect(result.status).toBe('error');
  });
});

describe('写入被 RLS 静默吞掉（返回空数组）必须算失败', () => {
  it('update 返回空数组 → 不是成功', async () => {
    signIn();
    // 第一次 select 查到已有行，第二次 update 返回空数组
    h.results = [{ data: [{ id: 7 }] }, { data: [] }];

    const result = await pushSnapshot(payloadAt('2026-10-24T10:00:00.000Z'));
    expect(result.status).toBe('error');
    expect(h.calls.some((c) => c.op === 'update')).toBe(true);
  });

  it('insert 返回空数组 → 不是成功', async () => {
    signIn();
    h.results = [{ data: [] }, { data: [] }];

    const result = await pushSnapshot(payloadAt('2026-10-24T10:00:00.000Z'));
    expect(result.status).toBe('error');
    expect(h.calls.some((c) => c.op === 'insert')).toBe(true);
  });

  it('update 命中一行 → ok，并带回 rowId', async () => {
    signIn();
    h.results = [{ data: [{ id: 7 }] }, { data: [{ id: 7 }] }];

    const result = await pushSnapshot(payloadAt('2026-10-24T10:00:00.000Z'));
    expect(result).toEqual({ status: 'ok', rowId: 7 });
  });
});

describe('写入字段里不能出现 owner_id', () => {
  it('insert / update 的载荷只有 payload 与 saved_at', async () => {
    signIn();
    h.results = [{ data: [] }, { data: [{ id: 1 }] }];
    await pushSnapshot(payloadAt('2026-10-24T10:00:00.000Z'));

    const writes = h.calls.filter((c) => c.op === 'insert' || c.op === 'update');
    expect(writes).toHaveLength(1);
    expect(Object.keys(writes[0].payload ?? {}).sort()).toEqual(['payload', 'saved_at']);
    expect(writes[0].payload).not.toHaveProperty('owner_id');
  });
});

describe('decideSyncAction 边界补强', () => {
  it('本地时间非法、云端有效 → 听云端的（pull-cloud）', () => {
    const remote = { payload: payloadAt('2026-10-24T10:00:00.000Z', ONE_TASK), savedAt: '2026-10-24T10:00:00.000Z', taskCount: 1 };
    expect(decideSyncAction(payloadAt('not-a-date'), remote)).toBe('pull-cloud');
  });

  it('云端时间非法、本地有效 → 听本地的（push-local）', () => {
    expect(decideSyncAction(payloadAt('2026-10-24T10:00:00.000Z', ONE_TASK), { payload: payloadAt(''), savedAt: '', taskCount: 0 })).toBe('push-local');
  });

  it('两边时间都非法 → 退化为相等，不动（none）', () => {
    expect(decideSyncAction(payloadAt('x'), { payload: payloadAt('y'), savedAt: 'y', taskCount: 0 })).toBe('none');
  });
});

describe('P0 独立回归：新设备登录不得把云端盖成空的', () => {
  /** 12 条云端真实数据 */
  function cloudPayload12(): PersistedPayload {
    const tasks = Array.from({ length: 12 }, (_, i) => ({
      id: `c${i}`,
      title: `云端任务${i}`,
      note: '',
      date: '2026-10-23' as const,
      time: null,
      priority: 'medium' as const,
      category: '学习',
      done: false,
      doneAt: null,
      createdAt: '2026-10-23T01:00:00.000Z',
      updatedAt: '2026-10-23T01:00:00.000Z',
      parentId: null,
    }));
    return payloadAt('2026-10-23T10:00:00.000Z', tasks);
  }

  function writes(): unknown[] {
    return h.calls.filter((c) => c.op === 'insert' || c.op === 'update');
  }

  it('前提：本测试文件从不登记落盘时间，getLocalSavedAt() 应为 null（= 新设备）', () => {
    // 这一步是后面两条断言的地基：若哪天有人在别处偷偷登记了落盘时间，
    // "新设备"这个前提就不成立了，断言也就失去意义。
    expect(getLocalSavedAt()).toBeNull();
  });

  it('本机从未落盘 + 云端有 12 条 → pulled，且零次 insert/update', async () => {
    signIn();
    const cloud = cloudPayload12();
    // 云端确实有那一行
    h.results = [{ data: [{ id: 7, payload: cloud, saved_at: '2026-10-23T10:00:00.000Z' }] }];

    const result = await runSync(null); // ← SettingsView 在新设备上就是传 null

    expect(result.status).toBe('pulled');
    if (result.status !== 'pulled') return;
    // 云端数据完整拿回本机
    expect(result.payload.tasks).toHaveLength(12);
    // 关键：一次写都没发，绝不会拿空数据去覆盖云端那一行
    expect(writes()).toHaveLength(0);
  });

  it('本机从未落盘 + 云端也为空 → unchanged，不得把空数据硬推上去', async () => {
    signIn();
    h.results = [{ data: [] }]; // 云端无数据

    const result = await runSync(null);

    expect(result.status).toBe('unchanged');
    expect(writes()).toHaveLength(0);
  });

  it('落盘时间登记后必须是那个真实时间，不是"现在"', () => {
    const real = '2026-10-23T08:30:00.000Z';
    noteLocalSavedAt(real);
    expect(getLocalSavedAt()).toBe(real);
  });

  it('本机 1 条 + 云端 12 条 → 合并（merged），一条都不丢', async () => {
    signIn();
    h.results = [
      { data: [{ id: 7, payload: cloudPayload12(), saved_at: '2026-10-23T10:00:00.000Z' }] },
      { data: [{ id: 7 }] },
      { data: [{ id: 7 }] },
    ];

    // 旧逻辑"本机 savedAt 更晚 → 整包上推"会把云端 12 条无声吞掉；
    // 新逻辑按 id 合并：13 条全保留
    const result = await runSync(payloadAt('2026-10-24T10:00:00.000Z', [{ id: 'x', title: '本机新改动' }]));

    expect(result.status).toBe('merged');
    if (result.status !== 'merged') return;
    expect(result.payload.tasks).toHaveLength(13);
    expect(result.payload.tasks.map((t) => t.id)).toContain('x');
    expect(result.payload.tasks.map((t) => t.id)).toContain('c0');
    expect(h.calls.some((c) => c.op === 'update')).toBe(true);
  });
});

/**
 * ⚠️ 红线兜底：本工程没有 jsdom / @testing-library，SettingsView / usePersist /
 * StoreContext 都是 React 组件 / Hook，单测里渲染不了。而 P0 当初恰恰错在
 * SettingsView 的那一行 —— 我实测过：把 `savedAt` 改回 `new Date().toISOString()`
 * 之后，整包用例**依然全绿**（runSync 层的断言根本碰不到它）。
 * 所以这里用源码扫描盯住登记点，防止它悄悄退回去。
 */
describe('P0 红线兜底（源码级）', () => {
  function read(relative: string): string {
    return readFileSync(new URL(relative, import.meta.url), 'utf8');
  }

  /**
   * 这一条盯着的是"同步载荷里的 savedAt 用的是什么时间"。
   * v0.29.x 起 `onSyncClick` 跟着「云同步」整块搬进了
   * `components/settings/CloudSection.tsx` —— 扫描目标跟着搬，
   * **断言本身一个字没放松**（这条守的是丢数据，不是文件位置）。
   */
  it('CloudSection.onSyncClick 必须用 getLocalSavedAt()，不得用 new Date() 当落盘时间', () => {
    const src = read('../../components/settings/CloudSection.tsx');
    const start = src.indexOf('const onSyncClick');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('const outcome = await runSync', start));

    expect(body).toContain('getLocalSavedAt()'); // 必须读真实落盘时间
    expect(body).not.toMatch(/savedAt:\s*new Date\(/); // 不能用"现在"顶替
  });

  it('启动装载登记点必须落在 StoreContext（两条路径各自登记）', () => {
    // 登记点从 usePersist 挂载 effect 上移到 StoreContext 启动装载处（D3）：
    // 同步路径（loadPersisted）与原生路径（loadPersistedAsync）都要登记，
    // 保证任何同步触发前"磁盘上那份"的真实 savedAt 已登记。
    const src = read('../../store/StoreContext.tsx');
    expect(src).toContain('loadPersistedAsync()'); // 原生装载路径
    expect(src).toContain('loadPersisted()'); // 网页 / 桌面同步装载路径
    expect(src).toContain('noteLocalSavedAt('); // 两条路径都登记
  });

  it('usePersist 必须在「保存成功后」登记落盘时间（await 化后的写链里）', () => {
    const src = read('../../hooks/usePersist.ts');

    // 1) 保存成功后登记（异步化：写链内 const result = await savePersisted）
    const afterSave = src.slice(src.indexOf('const result = await savePersisted(payload)'));
    expect(afterSave).toContain('noteLocalSavedAt(payload.savedAt)');

    // 2) 挂载读盘登记已删除（上移至 StoreContext），避免启动双读盘
    expect(src).not.toMatch(/loadPersisted\(\)/);

    // 3) R7 写序竞争：写链必须走 createSerialWriteChain 工厂 + enqueue 挂链。
    //    曾实测改回并发写（void (async () => …)()）时全绿 0 红 ——
    //    工厂的串行语义由 src/hooks/__tests__/writeChain.test.ts 行为守护，
    //    这里兜底「Hook 确实用了工厂」，而不是裸并发写。
    expect(src).toContain('createSerialWriteChain');
    expect(src).toContain('writeChain.enqueue(');
  });
});

describe('M1 回归：被 RLS 静默吞掉的写入要按权限口径报给用户', () => {
  it('update 返空数组 → code 必须是 42501，syncErrorMessage 输出「无权操作此数据」', async () => {
    signIn();
    h.results = [{ data: [{ id: 7 }] }, { data: [] }];

    const result = await pushSnapshot(payloadAt('2026-10-24T10:00:00.000Z'));
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.error.code).toBe('42501');
    expect(syncErrorMessage(result.error)).toBe('无权操作此数据');
  });

  it('insert 返空数组 → 同样是 42501 / 「无权操作此数据」', async () => {
    signIn();
    h.results = [{ data: [] }, { data: [] }];

    const result = await pushSnapshot(payloadAt('2026-10-24T10:00:00.000Z'));
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.error.code).toBe('42501');
    expect(syncErrorMessage(result.error)).toBe('无权操作此数据');
  });

  it('普通网络错误仍然是「同步失败，数据仍在本机」，不被误报成权限问题', async () => {
    signIn();
    h.results = [{ data: [{ id: 7 }] }, { data: null, error: { code: 'PGRST301', message: 'boom' } }];

    const result = await pushSnapshot(payloadAt('2026-10-24T10:00:00.000Z'));
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(syncErrorMessage(result.error)).toBe('同步失败，数据仍在本机');
  });
});

describe('M2 回归：同步进行中的编辑要补推，不能丢', () => {
  it('上一轮还在飞 → 重新排期，等它结束后真的推上去', async () => {
    vi.useFakeTimers();
    try {
      signIn();
      // 第一次 select（查已有行）→ 空；第二次 insert → 成功
      h.results = [{ data: [] }, { data: [{ id: 1 }] }];

      scheduleCloudPush(payloadAt('2026-10-24T10:00:00.000Z', ONE_TASK));
      noteSyncStart(); // 模拟上一轮同步还在飞

      const during = await flushCloudPush();
      expect(during).toBeNull();
      expect(h.calls).toHaveLength(0); // 此刻确实一个请求都没发

      noteSyncFailure(); // 上一轮结束
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 20);

      // 关键：这次编辑没被丢掉，重新排期后被真正推上去了
      expect(h.calls.filter((c) => c.op === 'insert')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('云端更新的数据能拿回本机', () => {
  it('本地确实比云端旧时 runSync 返回 pulled，并带回云端 payload', async () => {
    signIn();
    const cloudPayload = payloadAt('2026-10-24T12:00:00.000Z', [
      { id: 't1', title: '云端任务', note: '', date: '2026-10-24', time: null, priority: 'medium', category: '学习', done: false, doneAt: null, createdAt: 'x', updatedAt: 'x' },
    ]);
    h.results = [
      { data: [{ id: 7, payload: cloudPayload, saved_at: '2026-10-24T12:00:00.000Z' }] },
    ];

    const result = await runSync(payloadAt('2026-10-24T10:00:00.000Z'));
    expect(result.status).toBe('pulled');
    if (result.status !== 'pulled') return;
    expect(result.payload).toEqual(cloudPayload);
  });

  it('本地为空（新机器首次登录）→ pull-cloud，不会用空数据盖云端', async () => {
    // 设置页在"从未保存过"时应把 local 视为 null；这里直接验证契约本身
    expect(decideSyncAction(null, { payload: payloadAt('2026-10-24T12:00:00.000Z'), savedAt: '2026-10-24T12:00:00.000Z', taskCount: 12 })).toBe('pull-cloud');
  });

  it('两边内容一致（本机刚保存过的稳态）→ unchanged，且零次写入', async () => {
    signIn();
    const cloud = payloadAt('2026-10-24T10:00:00.000Z', ONE_TASK);
    h.results = [{ data: [{ id: 7, payload: cloud, saved_at: '2026-10-24T10:00:00.000Z' }] }];

    // savedAt 不同（本机 12:00 保存过）但内容一致 —— 稳态按内容判，不白写
    const result = await runSync(payloadAt('2026-10-24T12:00:00.000Z', ONE_TASK));

    expect(result.status).toBe('unchanged');
    expect(h.calls.filter((c) => c.op === 'insert' || c.op === 'update')).toHaveLength(0);
  });
});

describe('pushSnapshot：并发与行消失的恢复', () => {
  it('insert 撞 23505 且重抢到的行读不到 payload → 退化为直接 update（不报冲突）', async () => {
    signIn();
    h.results = [
      { data: [] },
      { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "todo_sync_owner_unique"' } },
      { data: [{ id: 9 }] },
      { data: [{ id: 9 }] },
    ];

    const result = await pushSnapshot(payloadAt('2026-10-24T10:00:00.000Z', ONE_TASK));

    expect(result).toEqual({ status: 'ok', rowId: 9 });
  });

  it('insert 撞 23505 且重抢到带 payload 的行 → 合并后再 update，绝不整包覆盖对方', async () => {
    signIn();
    // 另一台设备抢先插入的任务（与 ONE_TASK 的 t1 不同 id）
    const racing = payloadAt('2026-10-24T09:00:00.000Z', [{
      id: 'a1', title: '另一台设备先插入的任务', note: '', date: '2026-10-24', time: null,
      priority: 'medium', category: '学习', done: false, doneAt: null,
      createdAt: '2026-10-24T01:00:00.000Z', updatedAt: '2026-10-24T01:30:00.000Z',
    }]);
    h.results = [
      { data: [] },                                    // 查已有行：没有
      { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "todo_sync_owner_unique"' } }, // insert 撞唯一索引
      { data: [{ id: 9, payload: racing }] },          // 重抢：对方刚建的行（带 payload）
      { data: [{ id: 9 }] },                           // update 合并结果
    ];

    const result = await pushSnapshot(payloadAt('2026-10-24T10:00:00.000Z', ONE_TASK));

    expect(result).toEqual({ status: 'ok', rowId: 9 });
    const write = h.calls.find((c) => c.op === 'update');
    const pushedTasks = (write?.payload as { payload: PersistedPayload }).payload.tasks;
    // 关键：两边任务都在 —— 后 insert 的设备不会吞掉先 insert 的设备刚同步的任务
    expect(pushedTasks.map((t) => t.id).sort()).toEqual(['a1', 't1']);
  });

  it('update 返空数组（行被并发删掉）→ 重抢发现行没了 → insert 成功', async () => {
    signIn();
    h.results = [{ data: [{ id: 7 }] }, { data: [] }, { data: [] }, { data: [{ id: 8 }] }];

    const result = await pushSnapshot(payloadAt('2026-10-24T10:00:00.000Z', ONE_TASK));

    expect(result).toEqual({ status: 'ok', rowId: 8 });
    expect(h.calls.some((c) => c.op === 'insert')).toBe(true);
  });

  it('update 两次都返空数组且行始终存在（RLS 真拦截）→ 42501', async () => {
    signIn();
    h.results = [{ data: [{ id: 7 }] }, { data: [] }, { data: [{ id: 7 }] }, { data: [] }];

    const result = await pushSnapshot(payloadAt('2026-10-24T10:00:00.000Z', ONE_TASK));

    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.error.code).toBe('42501');
  });
});

describe('自动推送：先拉取再合并，不盲推', () => {
  it('本机 t1 + 云端 r1 → 合并后推上去，mergeHandler 收到并集', async () => {
    signIn();
    const remoteOnly = [{
      id: 'r1', title: '云端独有的任务', note: '', date: '2026-10-24', time: null,
      priority: 'medium' as const, category: '学习', done: false, doneAt: null,
      createdAt: '2026-10-24T01:00:00.000Z', updatedAt: '2026-10-24T02:00:00.000Z',
    }];
    h.results = [
      { data: [{ id: 7, payload: payloadAt('2026-10-24T09:00:00.000Z', remoteOnly), saved_at: '2026-10-24T09:00:00.000Z' }] },
      { data: [{ id: 7 }] },
      { data: [{ id: 7 }] },
    ];

    const seen: PersistedPayload[] = [];
    setCloudMergeHandler((payload) => seen.push(payload));
    try {
      scheduleCloudPush(payloadAt('2026-10-24T10:00:00.000Z', ONE_TASK));
      const result = await flushCloudPush();

      expect(result?.status).toBe('ok');
      // 推送的 update 载荷里 tasks 同时含 t1 与 r1（先拉取再合并，不是盲推旧整包）
      const writes = h.calls.filter((c) => c.op === 'update');
      expect(writes).toHaveLength(1);
      const pushedTasks = (writes[0].payload as { payload: PersistedPayload }).payload.tasks;
      expect(pushedTasks.map((t) => t.id).sort()).toEqual(['r1', 't1']);
      // 云端有本机没有的任务 → 合并结果被带回本机（内容有差异才回调）
      expect(seen).toHaveLength(1);
      expect(seen[0].tasks.map((t) => t.id).sort()).toEqual(['r1', 't1']);
    } finally {
      setCloudMergeHandler(null);
    }
  });

  it('拉取失败 → 不推送、不抛异常，pendingPayload 保留，下次 flush 还能推上去', async () => {
    signIn();
    h.results = [{ data: null, error: { code: 'PGRST301', message: 'boom' } }];

    scheduleCloudPush(payloadAt('2026-10-24T10:00:00.000Z', ONE_TASK));
    const first = await flushCloudPush();

    expect(first).toBeNull();
    expect(h.calls.filter((c) => c.op === 'insert' || c.op === 'update')).toHaveLength(0);

    // 再喂正常结果：上一次的编辑没有丢，这次真的推上去了
    h.results = [{ data: [] }, { data: [] }, { data: [{ id: 1 }] }];
    const second = await flushCloudPush();
    expect(second?.status).toBe('ok');
    expect(h.calls.filter((c) => c.op === 'insert' || c.op === 'update')).toHaveLength(1);
  });

  it('云端 payload 损坏（tasks 非数组）→ 不抛未处理异常，推本机整包上去', async () => {
    signIn();
    const corrupt = { schemaVersion: 1, savedAt: '2026-10-24T09:00:00.000Z', tasks: null, settings: null };
    h.results = [
      { data: [{ id: 7, payload: corrupt, saved_at: '2026-10-24T09:00:00.000Z' }] },
      { data: [{ id: 7 }] },
      { data: [{ id: 7 }] },
    ];

    scheduleCloudPush(payloadAt('2026-10-24T10:00:00.000Z', ONE_TASK));
    const result = await flushCloudPush();

    expect(result?.status).toBe('ok');
    const writes = h.calls.filter((c) => c.op === 'update');
    expect(writes).toHaveLength(1);
    const pushedTasks = (writes[0].payload as { payload: PersistedPayload }).payload.tasks;
    expect(pushedTasks.map((t) => t.id)).toEqual(['t1']); // 本机任务完整推上去
  });

  it('稳态（云端已是本机内容）→ 不白写，直接返回 ok', async () => {
    signIn();
    const cloud = payloadAt('2026-10-24T10:00:00.000Z', ONE_TASK);
    h.results = [{ data: [{ id: 7, payload: cloud, saved_at: '2026-10-24T10:00:00.000Z' }] }];

    scheduleCloudPush(payloadAt('2026-10-24T12:00:00.000Z', ONE_TASK)); // 本机保存过，savedAt 不同
    const result = await flushCloudPush();

    expect(result).toEqual({ status: 'ok', rowId: 7 });
    expect(h.calls.filter((c) => c.op === 'insert' || c.op === 'update')).toHaveLength(0);
  });
});

/* 放最后：清空云端会暂停自动推送，避免暂停状态影响其它用例；用例内部自行恢复 */
/* ============================================================================
   决策矩阵（v0.29.6）：拆 cloudSync 之前先冻结的行为边界
   ----------------------------------------------------------------------------
   `cloudSync` 里四件事互相咬合：**方向判定 / 字段级合并 / outbox / 失败停摆**。
   要把 930 行拆开，先得有一张"给定输入必得这个结果"的表 —— 否则拆完只能靠
   跑一遍试试，而"试试"在同步这种多分支逻辑上等于没测。

   这张表就是拆分的安全网：**输入 → 期望的 status + 有没有真的写云端**。
   拆完之后它有两条路要走：
   ① 表里每一行仍然通过（行为没变）；
   ② 每一项副作用（insert/update/delete 次数）也没变。
   ========================================================================= */
describe('runSync 决策矩阵（拆分 cloudSync 前的边界冻结）', () => {
  const T = ONE_TASK;

  /** 云端有一行真实数据时的 mock 返回值 */
  const remoteRow = (tasks: unknown[] = T, savedAt = '2026-10-24T09:00:00.000Z') => ({
    data: [{ payload: payloadAt(savedAt, tasks), saved_at: savedAt }],
  });
  const emptyCloud = { data: [] };

  it('本机从未落盘 + 云端空 → unchanged（没东西可推，也不算失败）', async () => {
    signIn();
    h.results = [emptyCloud];
    const r = await runSync(null);
    expect(r.status).toBe('unchanged');
    expect(h.calls.filter((c) => c.op === 'insert' || c.op === 'update')).toHaveLength(0);
  });

  it('本机从未落盘 + 云端有数据 → pulled（新设备恢复）', async () => {
    signIn();
    h.results = [remoteRow()];
    const r = await runSync(null);
    expect(r.status).toBe('pulled');
  });

  it('本机有数据 + 云端空 → pushed（首次上云）', async () => {
    signIn();
    h.results = [emptyCloud, emptyCloud, { data: [{ id: 3 }] }];
    const r = await runSync(payloadAt('2026-10-24T10:00:00.000Z', T));
    expect(r.status).toBe('pushed');
  });

  it('两边内容一致 → unchanged（稳态，不白写一次）', async () => {
    signIn();
    h.results = [remoteRow(T, '2026-10-24T09:00:00.000Z')];
    const local = payloadAt('2026-10-24T09:00:00.000Z', T);
    const r = await runSync(local);
    expect(r.status).toBe('unchanged');
  });

  it('两边都有、内容不同 → merged（绝不整包互盖）', async () => {
    signIn();
    h.results = [
      remoteRow([{ id: 'remote-1', title: '云端那条', date: '2026-10-24', priority: 'high', category: '学习', done: false }]),
      { data: [{ id: 9 }] }, // 推送时的"查已有行"
      { data: [{ id: 9 }] }, // 推送 update
    ];
    const r = await runSync(payloadAt('2026-10-24T10:00:00.000Z', T));
    expect(r.status).toBe('merged');
  });

  /* ---------- 两把锁：清空之后不许自动搬家 ---------- */

  it('「清空本机」后自动同步整轮跳过（本地空 + 云端有数据也不拉）', async () => {
    signIn();
    noteLocalCleared();
    h.results = [remoteRow()];
    const r = await runSync(null);
    expect(r.status).toBe('unchanged');
    expect(r).not.toHaveProperty('payload'); // 没有把云端内容交回本机
  });

  it('「清空云端」后自动同步不推（本机有数据 + 云端空也不写回去）', async () => {
    signIn();
    h.results = [{ data: [{ id: 7 }] }, { data: [{ id: 7 }] }];
    await clearRemoteSnapshot();

    h.results = [emptyCloud, emptyCloud];
    const r = await runSync(payloadAt('2026-10-24T10:00:00.000Z', T));
    expect(r.status).toBe('unchanged');
    expect(h.calls.filter((c) => c.op === 'insert' || c.op === 'update')).toHaveLength(0);
  });

  it('手动同步（manual）不受这两把锁限制：该推就推', async () => {
    signIn();
    h.results = [{ data: [{ id: 7 }] }, { data: [{ id: 7 }] }];
    await clearRemoteSnapshot();

    h.results = [emptyCloud, emptyCloud, { data: [{ id: 8 }] }];
    const r = await runSync(payloadAt('2026-10-24T10:00:00.000Z', T), { manual: true });
    expect(r.status).toBe('pushed');
  });

  /* ---------- 门禁：没登录一次都不许发请求 ---------- */

  it('未登录 → signed-out，且零数据库调用', async () => {
    h.session = null;
    h.calls.length = 0;
    const r = await runSync(payloadAt('2026-10-24T10:00:00.000Z', T));
    expect(r.status).toBe('signed-out');
    expect(h.calls).toHaveLength(0);
  });
});

describe('云端已知条数（自动推送的"安全阀"）', () => {
  /**
   * 为什么这条重要：自动推送是"只写不读"的路径（保存后 300ms 就排期推一次），
   * 如果本机因为某种原因变成空（新设备第一次打开、装载失败降级只读……），
   * 一次推送就会把云端真实数据清成空。
   *
   * 所以 `pullSnapshot` 每次拿到云端那一行，都要把"云端有几条任务"记下来；
   * `scheduleCloudPush` 见到"本机为空 + 云端已知有数据"就跳过这次推送。
   *
   * 拆 cloudSnapshot 时这条共享状态差点被漏掉（它藏在文件中部的一个 let 里），
   * 变异 M80 当场把"没有测试"这件事暴露了出来 —— 这条用例就是那时候补的。
   */
  it('拉到 N 条任务后，云端已知条数被记成 N', async () => {
    signIn();
    h.results = [
      { data: [{ payload: payloadAt('2026-10-24T09:00:00.000Z', ONE_TASK), saved_at: '2026-10-24T09:00:00.000Z' }] },
    ];
    await pullSnapshot();
    expect(getLastKnownRemoteCount()).toBe(ONE_TASK.length);
  });

  it('云端为空 → 记成 0（不是 null，"确知为空"与"还不知道"必须分开）', async () => {
    signIn();
    h.results = [{ data: [] }];
    await pullSnapshot();
    expect(getLastKnownRemoteCount()).toBe(0);
  });

  it('本机为空 + 云端已知有数据 → 自动推送跳过（绝不把云端推成空）', async () => {
    signIn();
    h.results = [
      { data: [{ payload: payloadAt('2026-10-24T09:00:00.000Z', ONE_TASK), saved_at: '2026-10-24T09:00:00.000Z' }] },
    ];
    await pullSnapshot(); // 记住"云端有 1 条"
    expect(getLastKnownRemoteCount()).toBe(1);

    h.calls.length = 0;
    scheduleCloudPush(payloadAt('2026-10-24T10:00:00.000Z', [])); // 本机空载荷
    await flushCloudPush();
    expect(h.calls.filter((c) => c.op === 'insert' || c.op === 'update')).toHaveLength(0);
  });
});

describe('clearRemoteSnapshot：清空云端', () => {
  it('未登录 → signed-out，且零数据库调用', async () => {
    const result = await clearRemoteSnapshot();
    expect(result.status).toBe('signed-out');
    expect(h.calls).toHaveLength(0);
  });

  it('有行 → ok 且带回删除条数；自动推送被暂停，「立即同步」后恢复', async () => {
    signIn();
    h.results = [{ data: [{ id: 7 }] }, { data: [{ id: 7 }] }];

    const result = await clearRemoteSnapshot();

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.removed).toBe(1);
    expect(h.calls.some((c) => c.op === 'delete')).toBe(true);

    // 暂停期间：本机空数据也不会被立刻推回云端（否则清空就失去了意义）
    scheduleCloudPush(payloadAt('2026-10-24T10:00:00.000Z'));
    expect(await flushCloudPush()).toBeNull();
    expect(h.calls.filter((c) => c.op === 'insert' || c.op === 'update')).toHaveLength(0);

    // 点一次「立即同步」（云端已空、本机从未落盘）→ 成功路径恢复自动推送。
    // ⚠️ `manual: true` 是必须的：清空云端之后，**自动**同步一律不许再推，
    // 只有用户显式点的这一下才解得开（见 runSync 的注释）。
    h.results = [{ data: [] }];
    const sync = await runSync(null, { manual: true });
    expect(sync.status).toBe('unchanged');

    // 恢复后：本机编辑能再次自动推上去
    h.results = [{ data: [] }, { data: [] }, { data: [{ id: 1 }] }];
    scheduleCloudPush(payloadAt('2026-10-24T10:00:00.000Z', ONE_TASK));
    const pushed = await flushCloudPush();
    expect(pushed?.status).toBe('ok');
    expect(h.calls.filter((c) => c.op === 'insert')).toHaveLength(1);
  });

  it('清空云端后「立即同步」走 push-local 也恢复自动推送', async () => {
    signIn();
    // 先清空云端 → 自动推送暂停
    h.results = [{ data: [{ id: 7 }] }, { data: [{ id: 7 }] }];
    const cleared = await clearRemoteSnapshot();
    expect(cleared.status).toBe('ok');

    // 本机有数据 + 云端已空 → push-local 成功
    h.results = [{ data: [] }, { data: [] }, { data: [{ id: 3 }] }];
    const sync = await runSync(payloadAt('2026-10-24T10:00:00.000Z', ONE_TASK), { manual: true });
    expect(sync.status).toBe('pushed');

    // push-local 这一成功分支同样必须恢复自动推送：后续编辑能推上去。
    // （队列三条 = pull select / 查已有行 select / insert）
    h.results = [{ data: [] }, { data: [] }, { data: [{ id: 4 }] }];
    scheduleCloudPush(payloadAt('2026-10-24T11:00:00.000Z', ONE_TASK));
    const pushed = await flushCloudPush();
    expect(pushed?.status).toBe('ok');
    expect(h.calls.filter((c) => c.op === 'insert').length).toBeGreaterThan(0);
  });

  /**
   * 这一条守的是 v0.29.2 修的坑：`pauseAutoPush()` 只拦住了
   * `scheduleCloudPush` / `flushCloudPush`，而 60 秒轮询走的是
   * `runAutoSync → runSync`，那条路径**从来不查暂停标志** ——
   * 于是"清空云端"成功后一分钟，本机数据被原样推回去，清空白做。
   */
  it('清空云端后「自动同步」（非手动）绝不把本机数据推回去', async () => {
    signIn();
    h.results = [{ data: [{ id: 7 }] }, { data: [{ id: 7 }] }];
    const cleared = await clearRemoteSnapshot();
    expect(cleared.status).toBe('ok');

    // 云端已空 + 本机有数据 → 按内容规则本该 push-local，自动同步必须拦住
    h.results = [{ data: [] }, { data: [] }];
    const auto = await runSync(payloadAt('2026-10-24T10:00:00.000Z', ONE_TASK));
    expect(auto.status).toBe('unchanged');
    expect(h.calls.filter((c) => c.op === 'insert' || c.op === 'update')).toHaveLength(0);
  });

  it('「清空全部数据」之后自动同步整体跳过（云端那份不许自己长回来）', async () => {
    signIn();
    noteLocalCleared();
    expect(isAutoSyncBlockedByClear()).toBe(true);

    // 云端仍有真实数据；本机刚被清空
    h.results = [
      {
        data: [
          {
            payload: payloadAt('2026-10-24T09:00:00.000Z', ONE_TASK),
            saved_at: '2026-10-24T09:00:00.000Z',
          },
        ],
      },
    ];
    const auto = await runSync(null);
    expect(auto.status).toBe('unchanged');

    // 用户点「立即同步」= 他自己重新做决定 → 封锁解除，恢复方向照常
    h.results = [
      {
        data: [
          {
            payload: payloadAt('2026-10-24T09:00:00.000Z', ONE_TASK),
            saved_at: '2026-10-24T09:00:00.000Z',
          },
        ],
      },
    ];
    const manual = await runSync(null, { manual: true });
    expect(manual.status).toBe('pulled');
    expect(isAutoSyncBlockedByClear()).toBe(false);
  });

  it('清空云端会取消在途的自动推送（防抖窗口内的编辑不被推回云端）', async () => {
    signIn();
    // 用户刚编辑完（防抖定时器还没到点，自动推送已排期）
    scheduleCloudPush(payloadAt('2026-10-24T10:00:00.000Z', ONE_TASK));
    // 紧接着清空云端
    h.results = [{ data: [{ id: 7 }] }, { data: [{ id: 7 }] }];
    const cleared = await clearRemoteSnapshot();
    expect(cleared.status).toBe('ok');

    // 在途推送被取消：不会把刚清空的云端又推回去
    const flushed = await flushCloudPush();
    expect(flushed).toBeNull();
    expect(h.calls.filter((c) => c.op === 'insert' || c.op === 'update')).toHaveLength(0);

    // 恢复后（立即同步成功）能推当前状态
    h.results = [{ data: [] }];
    await runSync(null, { manual: true });
    h.results = [{ data: [] }, { data: [] }, { data: [{ id: 5 }] }];
    scheduleCloudPush(payloadAt('2026-10-24T11:00:00.000Z', ONE_TASK));
    expect((await flushCloudPush())?.status).toBe('ok');
  });

  it('拉取期间用户清空云端 → 在途推送作废，不吃回头草', async () => {
    signIn();
    // 让 pull 挂起，制造“自动推送已进入拉取阶段”的在途状态
    let releasePull: (value: unknown) => void = () => undefined;
    const pullGate = new Promise((resolve) => {
      releasePull = resolve;
    });
    h.results = [pullGate as unknown as { data: unknown }];

    scheduleCloudPush(payloadAt('2026-10-24T10:00:00.000Z', ONE_TASK));
    const inFlight = flushCloudPush();
    // 等到 pull 的 select 真的发出（mock 在 then 里记账、并取走门控）再清空云端，
    // 否则重排 h.results 会被 pull 抢走，制造不出在途状态
    for (let i = 0; i < 100 && h.calls.length === 0; i += 1) {
      await Promise.resolve();
    }
    expect(h.calls).toHaveLength(1);

    // 拉取期间：用户清空云端
    h.results = [{ data: [{ id: 7 }] }, { data: [{ id: 7 }] }];
    const cleared = await clearRemoteSnapshot();
    expect(cleared.status).toBe('ok');

    releasePull({ data: [] }); // 放行拉取（云端已是空的）
    const result = await inFlight;

    // 关键：这次推送作废 —— 不把刚清空的云端又推回去
    expect(result).toBeNull();
    expect(h.calls.filter((c) => c.op === 'insert' || c.op === 'update')).toHaveLength(0);
  });

  it('云端本来没行 → ok removed 0，且不发生 delete', async () => {
    signIn();
    h.results = [{ data: [] }];

    const result = await clearRemoteSnapshot();

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.removed).toBe(0);
    expect(h.calls.some((c) => c.op === 'delete')).toBe(false);
  });

  it('有行但 delete 返空数组（RLS 静默拦截）→ 42501', async () => {
    signIn();
    h.results = [{ data: [{ id: 7 }] }, { data: [] }];

    const result = await clearRemoteSnapshot();

    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.error.code).toBe('42501');
  });
});
