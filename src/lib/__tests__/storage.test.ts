import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKUP_KEY, DEFAULT_CATEGORIES, SCHEMA_VERSION, SNAPSHOT_KEY, STORAGE_KEY, createDefaultSettings } from '../../constants';
import {
  backupRaw,
  clearAll,
  isFutureVersion,
  loadPersisted,
  loadPersistedAsync,
  migrate,
  sanitizeSettings,
  sanitizeTasks,
  savePersisted,
  savePersistedSync,
} from '../storage';
import { todayKey } from '../date';

/* ============================================================================
   §4.3 存储层：三级降级、版本保护、字段级兜底
   ========================================================================= */

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  /** 测试钩子：下一次 setItem 抛出指定名字的错误 */
  failNextSet: string | null = null;
  /**
   * 测试钩子：**持续**让 setItem 抛错（用来验证"腾完备份仍写不进去"的最终失败）。
   * `failNextSet` 只抛一次 —— 而写正本的配额恢复会重试，只抛一次的用例测不到终点。
   */
  failAllSets: string | null = null;

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    if (this.failAllSets) {
      const error = new Error('storage failure');
      error.name = this.failAllSets;
      throw error;
    }
    if (this.failNextSet) {
      const name = this.failNextSet;
      this.failNextSet = null;
      const error = new Error('storage failure');
      error.name = name;
      throw error;
    }
    this.map.set(key, String(value));
  }
}

let store: MemoryStorage;

beforeEach(() => {
  store = new MemoryStorage();
  vi.stubGlobal('localStorage', store);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const validPayload = (): string =>
  JSON.stringify({
    schemaVersion: 1,
    savedAt: '2026-10-24T00:00:00.000Z',
    tasks: [
      {
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
        estimatedMinutes: 0,
      },
    ],
    settings: {
      schemaVersion: 1,
      theme: 'dark',
      defaultView: 'today',
      weekStart: 1,
      categories: DEFAULT_CATEGORIES,
      lastSelectedDate: '2026-10-24',
      lastView: 'week',
      filterMode: 'all',
      filterCategory: null,
      doneCollapsed: true,
    },
  });

describe('loadPersisted —— 三级降级', () => {
  it('key 不存在：返回初始态且不写', () => {
    const result = loadPersisted();
    expect(result.payload).toBeNull();
    expect(result.error).toBeNull();
    expect(result.backupCreated).toBe(false);
    expect(store.getItem(STORAGE_KEY)).toBeNull();
  });

  it('损坏 JSON：不抛、备份原文、返回 corrupt', () => {
    store.setItem(STORAGE_KEY, '{');
    // 只调一次：再调一次会因"备份已存在"而让 backupCreated 变 false
    const result = loadPersisted();
    expect(result.error).toBe('corrupt');
    expect(result.payload).toBeNull();
    expect(result.backupCreated).toBe(true);
    expect(store.getItem(BACKUP_KEY)).toBe('{');
  });

  it('损坏 JSON 且已有备份时不再覆盖备份', () => {
    store.setItem(BACKUP_KEY, '{"old":true}');
    store.setItem(STORAGE_KEY, 'not json');
    const result = loadPersisted();
    expect(result.error).toBe('corrupt');
    expect(result.backupCreated).toBe(false);
    expect(store.getItem(BACKUP_KEY)).toBe('{"old":true}');
  });

  it('schemaVersion 更高：不迁移、不覆盖原 key、只读备份', () => {
    const future = JSON.stringify({ schemaVersion: 99, tasks: [], settings: {} });
    store.setItem(STORAGE_KEY, future);

    const result = loadPersisted();
    expect(result.error).toBe('future-version');
    expect(result.payload).toBeNull();
    expect(result.backupCreated).toBe(true);
    // 原 key 保持不动
    expect(store.getItem(STORAGE_KEY)).toBe(future);
    expect(store.getItem(BACKUP_KEY)).toBe(future);
  });

  it('正常载荷：装载任务与设置', () => {
    store.setItem(STORAGE_KEY, validPayload());
    const result = loadPersisted();
    expect(result.error).toBeNull();
    expect(result.payload?.tasks).toHaveLength(1);
    expect(result.payload?.settings.theme).toBe('dark');
    expect(result.payload?.settings.lastView).toBe('week');
  });

  it('localStorage 不可用：返回 unavailable 而不抛', () => {
    vi.stubGlobal('localStorage', undefined);
    const result = loadPersisted();
    expect(result.error).toBe('unavailable');
    expect(result.payload).toBeNull();
  });
});

describe('migrate', () => {
  it('v0 裸数组一路升到当前版本', () => {
    const payload = migrate([{ title: '旧任务', date: todayKey() }]);
    expect(payload?.schemaVersion).toBe(SCHEMA_VERSION);
    expect(payload?.tasks).toHaveLength(1);
    expect(payload?.tasks[0]?.title).toBe('旧任务');
  });

  it('更高版本返回 null（调用方走只读备份）', () => {
    expect(migrate({ schemaVersion: 9, tasks: [], settings: {} })).toBeNull();
  });

  it('非对象返回 null', () => {
    expect(migrate(null)).toBeNull();
    expect(migrate('x')).toBeNull();
    expect(migrate(42)).toBeNull();
  });

  it('缺 schemaVersion 视为 v0 并归一化', () => {
    const payload = migrate({ tasks: [], settings: null });
    expect(payload?.schemaVersion).toBe(SCHEMA_VERSION);
    expect(payload?.settings.categories).toHaveLength(4);
  });
});

describe('savePersisted', () => {
  it('成功返回 ok', async () => {
    const result = await savePersisted({
      schemaVersion: 1,
      savedAt: '2026-10-24T00:00:00.000Z',
      tasks: [],
      settings: sanitizeSettings(null),
      diary: [],
      tombstones: [],
      focusSessions: [],
      notes: [],
    });
    expect(result).toEqual({ ok: true });
    expect(store.getItem(STORAGE_KEY)).toContain('schemaVersion');
  });

  it('QuotaExceededError → reason=quota（不抛）', async () => {
    const payload = {
      schemaVersion: 1,
      savedAt: 'x',
      tasks: [],
      settings: sanitizeSettings(null),
      diary: [],
      tombstones: [],
      focusSessions: [],
      notes: [],
    };
    /**
     * v0.17.2 起：写正本遇到配额不足，会先牺牲备份（SNAPSHOT_PREV → SNAPSHOT）
     * 腾空间再重试 —— 快照是备份，正本才是用户这一次的修改。
     * 只抛一次 = 腾完就写进去了，不该再报失败。
     */
    store.failNextSet = 'QuotaExceededError';
    await expect(savePersisted(payload)).resolves.toEqual({ ok: true });

    // 持续配额满（腾完备份仍然写不进去）才如实上报
    store.failAllSets = 'QuotaExceededError';
    await expect(savePersisted(payload)).resolves.toEqual({ ok: false, reason: 'quota' });
    store.failAllSets = null;
  });

  it('SecurityError → reason=unavailable', async () => {
    store.failNextSet = 'SecurityError';
    const result = await savePersisted({
      schemaVersion: 1,
      savedAt: 'x',
      tasks: [],
      settings: sanitizeSettings(null),
      diary: [],
      tombstones: [],
      focusSessions: [],
      notes: [],
    });
    expect(result).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('其他异常 → reason=unknown', async () => {
    store.failNextSet = 'TypeError';
    const result = await savePersisted({
      schemaVersion: 1,
      savedAt: 'x',
      tasks: [],
      settings: sanitizeSettings(null),
      diary: [],
      tombstones: [],
      focusSessions: [],
      notes: [],
    });
    expect(result).toEqual({ ok: false, reason: 'unknown' });
  });

  it('localStorage 不可用 → unavailable', async () => {
    vi.stubGlobal('localStorage', undefined);
    const result = await savePersisted({
      schemaVersion: 1,
      savedAt: 'x',
      tasks: [],
      settings: sanitizeSettings(null),
      diary: [],
      tombstones: [],
      focusSessions: [],
      notes: [],
    });
    expect(result).toEqual({ ok: false, reason: 'unavailable' });
  });
});

describe('sanitizeSettings —— 字段级兜底', () => {
  it('任意非法字段回落默认值', () => {
    const settings = sanitizeSettings({
      theme: 'neon',
      defaultView: 'month',
      lastView: 42,
      weekStart: 5,
      filterMode: 'x',
      lastSelectedDate: '2026-02-30',
      doneCollapsed: 'yes',
      categories: [],
    });
    expect(settings.theme).toBe('system');
    expect(settings.defaultView).toBe('today');
    expect(settings.lastView).toBe('today');
    expect(settings.weekStart).toBe(1);
    expect(settings.filterMode).toBe('all');
    expect(settings.lastSelectedDate).toBe(todayKey());
    expect(settings.doneCollapsed).toBe(true);
    expect(settings.categories).toHaveLength(4);
  });

  it('接受 weekStart=0 与 lastView=week', () => {
    const settings = sanitizeSettings({ weekStart: 0, lastView: 'week' });
    expect(settings.weekStart).toBe(0);
    expect(settings.lastView).toBe('week');
  });

  it('分类去重且丢弃非法项', () => {
    const settings = sanitizeSettings({
      categories: [
        { id: 'c1', name: '学习' },
        { id: 'c1', name: '重复id' },
        { id: 'c2', name: '学习' },
        { id: '', name: '空id' },
        'nope',
      ],
    });
    expect(settings.categories).toEqual([{ id: 'c1', name: '学习' }]);
  });
});

describe('sanitizeTasks —— 逐条兜底', () => {
  it('丢弃非对象与空标题项，补齐 id 与时间戳', () => {
    const tasks = sanitizeTasks([
      { title: '  保留  ', date: '2026-10-24' },
      { title: '   ' },
      'nope',
      null,
      { title: '非法日期', date: '2026-02-31' },
    ]);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.title).toBe('保留');
    expect(tasks[0]?.id).toBeTruthy();
    expect(tasks[0]?.createdAt).toBeTruthy();
    expect(tasks[1]?.date).toBe(todayKey());
  });

  it('非法 time / priority / category 逐项兜底', () => {
    const tasks = sanitizeTasks([
      { title: 'x', time: '9:00', priority: 'urgent', category: 123 },
    ]);
    expect(tasks[0]?.time).toBeNull();
    expect(tasks[0]?.priority).toBe('medium');
    expect(tasks[0]?.category).toBe(DEFAULT_CATEGORIES[0]?.name);
  });

  it('非数组输入返回空数组', () => {
    expect(sanitizeTasks(null)).toEqual([]);
    expect(sanitizeTasks({})).toEqual([]);
  });

  it('done=true 才保留 doneAt，done 为 false 时清空', () => {
    const tasks = sanitizeTasks([
      { title: 'a', done: true, doneAt: '2026-10-24T00:00:00.000Z' },
      { title: 'b', done: false, doneAt: '2026-10-24T00:00:00.000Z' },
    ]);
    expect(tasks[0]?.doneAt).toBe('2026-10-24T00:00:00.000Z');
    expect(tasks[1]?.doneAt).toBeNull();
  });
});

describe('backupRaw / clearAll / isFutureVersion', () => {
  it('backupRaw 只在备份为空时写', async () => {
    await expect(backupRaw('first')).resolves.toBe(true);
    await expect(backupRaw('second')).resolves.toBe(false);
    expect(store.getItem(BACKUP_KEY)).toBe('first');
  });

  it('clearAll 只删主 key，保留备份', async () => {
    store.setItem(STORAGE_KEY, 'x');
    store.setItem(BACKUP_KEY, 'y');
    await clearAll();
    expect(store.getItem(STORAGE_KEY)).toBeNull();
    expect(store.getItem(BACKUP_KEY)).toBe('y');
  });

  it('isFutureVersion 识别更高 schemaVersion', () => {
    expect(isFutureVersion(JSON.stringify({ schemaVersion: 99 }))).toBe(true);
    expect(isFutureVersion(JSON.stringify({ schemaVersion: 1 }))).toBe(false);
    expect(isFutureVersion('{')).toBe(false);
  });

  it('主 key 被清空时能从快照恢复', async () => {
    const payload = {
      schemaVersion: 1,
      savedAt: '2026-10-24T10:00:00.000Z',
      tasks: [{ id: 'a1', title: '别丢了我', note: '', date: '2026-10-24', time: '09:00', repeat: 'none' as const, priority: 'high' as const, category: '学习', done: false, doneAt: null, parentId: null, estimatedMinutes: 0, createdAt: '2026-10-24T01:00:00.000Z', updatedAt: '2026-10-24T01:00:00.000Z' }],
      settings: createDefaultSettings('2026-10-24'),
      diary: [],
      tombstones: [],
      focusSessions: [],
      notes: [],
    };
    await expect(savePersisted(payload)).resolves.toEqual({ ok: true });
    expect(store.getItem(SNAPSHOT_KEY)).toBeTruthy();

    // 模拟主 key 没了（写入中断 / 存储被部分清理）
    store.removeItem(STORAGE_KEY);
    const result = loadPersisted();
    expect(result.restoredFromSnapshot).toBe(true);
    expect(result.payload?.tasks[0]?.title).toBe('别丢了我');
  });

  it('空数据不会覆盖上一份有效快照', async () => {
    store.setItem(SNAPSHOT_KEY, JSON.stringify({ schemaVersion: 1, savedAt: 'x', tasks: [{ id: 'a1', title: '保留我', note: '', date: '2026-10-24', time: null, priority: 'medium', category: '学习', done: false, doneAt: null, createdAt: 'x', updatedAt: 'x' }], settings: null }));
    await savePersisted({ schemaVersion: 1, savedAt: 'y', tasks: [], settings: createDefaultSettings('2026-10-24'), diary: [], tombstones: [], focusSessions: [], notes: [] });
    expect(JSON.parse(store.getItem(SNAPSHOT_KEY) as string).tasks[0].title).toBe('保留我');
  });
});

/* ============================================================================
   loadPersistedAsync —— 无 Capacitor 全局（网页 / 桌面 / vitest）走 localStorage
   本文件不 mock @capacitor/preferences：非原生分支根本不会 import 它，
   "Preferences 零调用"由这一结构本身保证（详见 storage.native.test.ts 的
   显式断言）。
   ========================================================================= */
describe('loadPersistedAsync —— 非原生路径', () => {
  it('与 loadPersisted 结果逐字段一致（正常载荷）', async () => {
    store.setItem(STORAGE_KEY, validPayload());
    const sync = loadPersisted();
    const asyncResult = await loadPersistedAsync();
    expect(asyncResult).toEqual(sync);
    expect(asyncResult.payload?.tasks).toHaveLength(1);
  });

  it('key 不存在：返回空态且不写', async () => {
    const result = await loadPersistedAsync();
    expect(result.payload).toBeNull();
    expect(result.error).toBeNull();
    expect(result.backupCreated).toBe(false);
    expect(store.getItem(STORAGE_KEY)).toBeNull();
  });

  it('损坏 JSON：不抛、备份原文、返回 corrupt', async () => {
    store.setItem(STORAGE_KEY, '{');
    const result = await loadPersistedAsync();
    expect(result.error).toBe('corrupt');
    expect(result.backupCreated).toBe(true);
    expect(store.getItem(BACKUP_KEY)).toBe('{');
  });

  it('schemaVersion 更高：只读备份，不覆盖原 key', async () => {
    const future = JSON.stringify({ schemaVersion: 99, tasks: [], settings: {} });
    store.setItem(STORAGE_KEY, future);
    const result = await loadPersistedAsync();
    expect(result.error).toBe('future-version');
    expect(result.backupCreated).toBe(true);
    expect(store.getItem(STORAGE_KEY)).toBe(future);
  });

  it('主 key 没了能从快照恢复', async () => {
    const snapshot = JSON.stringify({
      schemaVersion: 1,
      savedAt: '2026-10-24T10:00:00.000Z',
      tasks: [{ id: 'a1', title: '快照里的任务', note: '', date: '2026-10-24', time: null, repeat: 'none', priority: 'medium', category: '学习', done: false, doneAt: null, createdAt: 'x', updatedAt: 'x' }],
      settings: null,
    });
    store.setItem(SNAPSHOT_KEY, snapshot);
    const result = await loadPersistedAsync();
    expect(result.restoredFromSnapshot).toBe(true);
    expect(result.payload?.tasks[0]?.title).toBe('快照里的任务');
  });

  it('localStorage 不可用 → unavailable 而不抛', async () => {
    vi.stubGlobal('localStorage', undefined);
    const result = await loadPersistedAsync();
    expect(result.error).toBe('unavailable');
    expect(result.payload).toBeNull();
  });
});

/* ============================================================================
   v0.17.2：卸载前的**同步**落盘（savePersistedSync）

   背景：`flush()` 签名是同步的，但内部 `await savePersisted(...)` 是一串微任务。
   pagehide / 窗口关闭之后浏览器不保证跑完 → 最后一次编辑可能留在内存里。
   这里改用 localStorage 的同步写，把那一刻直接钉到盘上。
   ========================================================================= */
describe('savePersistedSync：卸载前的同步落盘', () => {
  const payload = {
    schemaVersion: 1,
    savedAt: '2026-10-29T10:00:00.000Z',
    tasks: [],
    settings: sanitizeSettings(null),
    diary: [],
    tombstones: [],
    focusSessions: [],
    notes: [],
  } as Parameters<typeof savePersistedSync>[0];

  it('有 localStorage → 同步写成功，主 key 立刻可读', () => {
    const result = savePersistedSync(payload);
    expect(result).toEqual({ ok: true });
    expect(store.getItem(STORAGE_KEY)).toBeTruthy();
  });

  it('快照也一起更新（有数据时）', () => {
    savePersistedSync({ ...payload, tasks: [{ id: 't1', title: 'x', note: '', date: '2026-10-29', time: null, repeat: 'none', priority: 'medium', category: '学习', done: false, doneAt: null, createdAt: 'x', updatedAt: 'x', parentId: null }] as never });
    expect(store.getItem(SNAPSHOT_KEY)).toBeTruthy();
  });

  it('配额满 → quota（同步路径不腾挪空间，时间预算不够反复重试）', () => {
    store.failNextSet = 'QuotaExceededError';
    expect(savePersistedSync(payload)).toEqual({ ok: false, reason: 'quota' });
  });

  it('没有 localStorage（原生 / 受限环境）→ null，表示"做不到同步写"', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(savePersistedSync(payload)).toBeNull();
  });
});
