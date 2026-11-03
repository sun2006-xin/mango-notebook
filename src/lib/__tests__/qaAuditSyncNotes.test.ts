import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_VERSION, createDefaultSettings } from '../../constants';
import type { Note, PersistedPayload, Task } from '../../types';

/* ============================================================================
   QA 审计（v0.7.0）：记事本（notes）在云同步链路上被"内容比较"漏掉了

   审计结论：`isSameSnapshot()` 只比较 tasks / diary / tombstones / settings，
   **不含 notes 与 focusSessions**。而它同时被两处当作"要不要同步"的闸门：
     ① `runSync` 的 `decideSyncAction()`（手动「立即同步」）
     ② `flushCloudPush()` 的稳态短路（后台自动推送）
   于是只要任务 / 日记 / 墓碑 / 设置没变，**记事本的任何改动都判不出差异**，
   合并函数 `mergeSnapshots()` 里写得再正确的 notes 合并也永远走不到。

   对照：`mergeSnapshots()` 自己**是**会并 notes 的（见本文件 E 组），
   所以这是"闸门漏字段"，不是"合并漏字段"。

   ── 修复后（v0.7.1, P0-1）────────────────────────────────────────────
   `isSameSnapshot()` 补了 notes（id + updatedAt）与 focusSessions（id + endedAt），
   并抽出 `hasAnyData()` / `snapshotDiffers()` 供三处闸门统一使用：
     ① decideSyncAction 的"一边空"判定改成**任一集合非空**；
     ② flushCloudPush 的稳态短路随 isSameSnapshot 一起覆盖全集合；
     ③ 推送成功后的 hydrate 回调闸门从"只有任务有差异"扩到 snapshotDiffers；
     ④ scheduleCloudPush 的排期条件同步放宽。
   A / B / D 组已翻转为**新契约**：记事能推、能拉、能 hydrate 回本机。
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
      select: (...args: unknown[]) => {
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
    cloud: {
      auth: {
        getSession: async () => ({ data: h.session ? { user: h.session.user } : null, error: null }),
        onAuthStateChange: () => () => undefined,
        signOut: async () => undefined,
      },
      database: { from: (table: string) => build(table) },
    },
    // 让 flushCloudPush / runSync 走"支持云同步"的分支
    isCloudRuntimeAvailable: () => true,
  };
});

const {
  decideSyncAction,
  flushCloudPush,
  mergeSnapshots,
  scheduleCloudPush,
  setCloudMergeHandler,
} = await import('../cloudSync');
const { isNoteDeleted } = await import('../storage');

/* ---------- 夹具 ---------- */

function task(id: string): Task {
  return {
    id,
    title: `任务 ${id}`,
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
    createdAt: '2026-10-24T01:00:00.000Z',
    updatedAt: '2026-10-24T01:00:00.000Z',
  };
}

function note(id: string, updatedAt: string, title = id): Note {
  return { id, title, content: `${id} 的正文`, category: '', pinned: false, createdAt: updatedAt, updatedAt };
}

function payloadAt(savedAt: string, tasks: Task[], notes: Note[]): PersistedPayload {
  return {
    schemaVersion: SCHEMA_VERSION,
    savedAt,
    tasks,
    settings: createDefaultSettings('2026-10-24'),
    diary: [],
    tombstones: [],
    focusSessions: [],
    notes,
  };
}

/** 云端回一行：payload 由调用方给定 */
function cloudReturns(payload: PersistedPayload): void {
  h.results.push({
    data: [{ id: 1, payload, saved_at: payload.savedAt }],
    error: null,
  });
}

/**
 * 让随后那次**写入**成功返回一行。
 *
 * 顺序不能乱：一次自动推送会依次发出
 *   ① pullSnapshot 的 select（这次吃 cloudReturns 那份结果）
 *   ② writeLatest → findLatestRowId 的 select（返回空数组 → 走 insert 分支）
 *   ③ insert 的 insert（这次必须返回一行，pushSnapshot 才算成功）
 * 写入不成功的话，flushCloudPush 不会走到"把合并结果 hydrate 回本机"那一步。
 */
function cloudAcceptsWrite(rowId = 1): void {
  h.results.push({ data: [], error: null });
  h.results.push({ data: [{ id: rowId }], error: null });
}

/** 落盘到云端的写操作（insert / update）次数 —— 判"到底有没有真的同步" */
function writeCalls(): DbCall[] {
  return h.calls.filter((c) => c.op === 'insert' || c.op === 'update');
}

beforeEach(() => {
  h.session = { user: { id: 'u_1', phone: '13812345678' } };
  h.results = [];
  h.calls = [];
  setCloudMergeHandler(null);
});

/* ==========================================================================
   A 组：decideSyncAction 的"内容比较"不含 notes
   ========================================================================== */

describe('A. decideSyncAction 已含 notes（闸门修复）', () => {
  it('A1 任务/日记/墓碑/设置全等、只有记事不同 → 判 merge（记事改动能同步）', () => {
    const local = payloadAt('2026-10-24T12:00:00.000Z', [task('t1')], [note('n1', '2026-10-24T12:00:00.000Z')]);
    const remote = payloadAt('2026-10-24T09:00:00.000Z', [task('t1')], [note('n1', '2026-10-24T09:00:00.000Z')]);

    // 内容有差异 → 判 'merge'（把本机 12:00 的记事并上去）
    expect(decideSyncAction(local, { payload: remote, savedAt: remote.savedAt, taskCount: 1 })).toBe('merge');
  });

  it('A2 两端都只有记事、没有任务 → 判 push-local（纯记事用户也能同步）', () => {
    const local = payloadAt('2026-10-24T12:00:00.000Z', [], [note('n1', '2026-10-24T12:00:00.000Z')]);
    const remote = payloadAt('2026-10-24T09:00:00.000Z', [], []);

    // 一边空（全集合都空）一边有 → 有数据的赢
    expect(decideSyncAction(local, { payload: remote, savedAt: remote.savedAt, taskCount: 0 })).toBe('push-local');
    // 反过来：云端有记事、本机全空 → pull-cloud（记事能拉下来）
    expect(decideSyncAction(remote, { payload: local, savedAt: local.savedAt, taskCount: 0 })).toBe('pull-cloud');
  });

  it('A3 本机新增一条记事（云端没有）→ 判 merge', () => {
    const local = payloadAt('2026-10-24T12:00:00.000Z', [task('t1')], [
      note('n1', '2026-10-24T09:00:00.000Z'),
      note('n2', '2026-10-24T12:00:00.000Z'),
    ]);
    const remote = payloadAt('2026-10-24T09:00:00.000Z', [task('t1')], [note('n1', '2026-10-24T09:00:00.000Z')]);

    expect(decideSyncAction(local, { payload: remote, savedAt: remote.savedAt, taskCount: 1 })).toBe('merge');
  });
});

/* ==========================================================================
   B 组：后台自动推送（flushCloudPush）端到端 —— 记事改动根本不写云端
   ========================================================================== */

describe('B. 后台自动推送：记事改动会写进云端', () => {
  it('B1 本机改了记事 → 自动推送真的写了云端（不再被判"云端已是这份内容"）', async () => {
    const local = payloadAt('2026-10-24T12:00:00.000Z', [task('t1')], [note('n1', '2026-10-24T12:00:00.000Z')]);
    const remote = payloadAt('2026-10-24T09:00:00.000Z', [task('t1')], [note('n1', '2026-10-24T09:00:00.000Z')]);
    cloudReturns(remote);
    cloudAcceptsWrite();

    scheduleCloudPush(local);
    const result = await flushCloudPush();

    expect(result).not.toBeNull();
    // 一次写入云端：12:00 的记事不再被闸门拦在本机
    expect(writeCalls()).toHaveLength(1);
  });

  it('B2 云端多了一条本机没有的记事 → 推送合并结果，并回调 hydrate（本机能看到这条记事）', async () => {
    const local = payloadAt('2026-10-24T12:00:00.000Z', [task('t1')], []);
    const remote = payloadAt('2026-10-24T09:00:00.000Z', [task('t1')], [note('n_cloud', '2026-10-24T09:00:00.000Z')]);
    cloudReturns(remote);
    cloudAcceptsWrite();

    let hydrated: PersistedPayload | null = null;
    setCloudMergeHandler((p) => {
      hydrated = p;
    });

    scheduleCloudPush(local);
    await flushCloudPush();

    expect(writeCalls()).toHaveLength(1);
    // 云端独有的记事被 hydrate 回本机（含 n_cloud）
    expect(hydrated).not.toBeNull();
    expect((hydrated as unknown as PersistedPayload).notes.map((n) => n.id)).toContain('n_cloud');
  });

  it('B3 纯记事设备（0 任务）→ scheduleCloudPush 照样排期推送', async () => {
    const local = payloadAt('2026-10-24T12:00:00.000Z', [], [note('n1', '2026-10-24T12:00:00.000Z')]);

    scheduleCloudPush(local);
    // pendingPayload 已排进去 → flush 会真的发出请求（不再是一次请求都不发）
    const result = await flushCloudPush();

    expect(result).not.toBeNull();
    expect(h.calls.length).toBeGreaterThan(0);
  });
});

/* ==========================================================================
   C 组：记事删除没有墓碑 —— 删掉的记事会被还留着它的那台设备"复活"
   ========================================================================== */

describe('D. 记事软删除：删掉的记事不会被对端复活', () => {
  /**
   * 修复后（P1-2）：`NOTE_DELETE` 改成**软删除** —— 不把条目 filter 掉，
   * 而是 `content = ''` + `updatedAt` 打点。
   *
   * 这条空壳的 updatedAt 比对端任何正文都新，所以走到 `mergeNotes()`（按 id 取并集、
   * updatedAt 新者胜）时赢的永远是"删除态"，对端就算还留着正文也复活不了它。
   * 用户视角：NotesView 列表与 `searchAll` 都过滤掉 content 为空的条目 —— 等于删掉了。
   *
   * 序列（真实的两台设备）：
   *   ① A、B 都有 n1，云端也有 n1；
   *   ② A 删掉 n1（本地留空壳，updatedAt 12:00，比 B 的正文新）；
   *   ③ B 因新建了任务触发合并 → 09:00 的正文输给 12:00 的空壳，推上云端仍是删除态；
   *   ④ A 再因任何任务差异触发合并 → n1 回到 A，但仍是删除态，列表里看不见。
   */
  it('D1 一端删了、另一端还留着 → 合并结果里这条记事仍是删除态（不复活）', () => {
    // A 侧 12:00 删掉 n1 → 软删除空壳（content 为空，时间戳比 B 的正文新）
    const deviceA = payloadAt('2026-10-24T12:00:00.000Z', [task('t1')], [
      { ...note('n1', '2026-10-24T09:00:00.000Z'), content: '', updatedAt: '2026-10-24T12:00:00.000Z' },
    ]);
    // B 侧仍持有 09:00 的正文，靠一条 B 独有的任务触发合并
    const deviceB = payloadAt('2026-10-24T12:30:00.000Z', [task('t1'), task('tB')], [
      note('n1', '2026-10-24T09:00:00.000Z'),
    ]);

    // ③ B → 云端：新者胜 → 12:00 的空壳赢，推上去的仍是"删除态"
    const toCloud = mergeSnapshots(deviceB, deviceA);
    expect(isNoteDeleted(toCloud.notes.find((n) => n.id === 'n1'))).toBe(true);

    // ④ A 与云端合并：n1 虽然在载荷里，但仍是删除态 —— 列表与搜索都看不见它
    const backToA = mergeSnapshots(deviceA, toCloud);
    const revived = backToA.notes.find((n) => n.id === 'n1');
    expect(revived).toBeDefined();
    expect(isNoteDeleted(revived)).toBe(true);
    expect(backToA.notes.filter((n) => !isNoteDeleted(n)).map((n) => n.id)).toEqual([]);
  });

  it('D2 对照：任务的删除**不会**复活，因为它有墓碑', () => {
    const local = payloadAt('2026-10-24T12:00:00.000Z', [], []);
    const remote = payloadAt('2026-10-24T12:00:00.000Z', [task('t1')], []);
    // 本机有墓碑 → 合并后 t1 仍然被剔除
    const withStone: PersistedPayload = {
      ...local,
      tombstones: [{ id: 't1', deletedAt: '2026-10-24T11:00:00.000Z', title: '任务 t1', date: '2026-10-24', index: 0 }],
    };
    const merged = mergeSnapshots(withStone, remote);
    expect(merged.tasks.map((t) => t.id)).not.toContain('t1');
  });
});

/* ==========================================================================
   E 组（对照）：合并函数本身是对的 —— 证明问题只在"闸门"
   ========================================================================== */

describe('E. 对照组：mergeSnapshots 本身能正确合并 notes', () => {
  it('E1 两端记事按 updatedAt 新者胜取并集', () => {
    const local = payloadAt('2026-10-24T12:00:00.000Z', [task('t1')], [note('n1', '2026-10-24T12:00:00.000Z')]);
    const remote = payloadAt('2026-10-24T09:00:00.000Z', [task('t1')], [
      note('n1', '2026-10-24T09:00:00.000Z'),
      note('n_cloud', '2026-10-24T09:00:00.000Z'),
    ]);

    const merged = mergeSnapshots(local, remote);
    const ids = merged.notes.map((n) => n.id).sort();
    expect(ids).toEqual(['n1', 'n_cloud']);
    const n1 = merged.notes.find((n) => n.id === 'n1');
    expect(n1?.updatedAt).toBe('2026-10-24T12:00:00.000Z'); // 本机新的胜
  });
});
