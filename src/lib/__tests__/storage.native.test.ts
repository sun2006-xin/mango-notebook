import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKUP_KEY,
  SNAPSHOT_KEY,
  STORAGE_KEY,
  SCHEMA_VERSION,
  createDefaultSettings,
} from '../../constants';
import type { PersistedPayload, Task } from '../../types';

/* ============================================================================
   storage.ts 原生分支（@capacitor/preferences）全量用例

   工程无 jsdom：原生分支用「全局 stub + 模块 mock」覆盖——
   1) vi.mock('@capacitor/preferences')：对动态 import 生效，内存 KV 模拟
      SharedPreferences；
   2) vi.stubGlobal('Capacitor', ...)：鸭子类型探测的全部依据
      （isNativePlatform / isPluginAvailable）。
   ========================================================================= */

/** 插件 mock 的内存存储（vi.hoisted：工厂提升前可用） */
const prefsStore = vi.hoisted(() => new Map<string, string>());

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async (options: { key: string }) => ({ value: prefsStore.get(options.key) ?? null })),
    set: vi.fn(async (options: { key: string; value: string }) => {
      prefsStore.set(options.key, options.value);
    }),
    remove: vi.fn(async (options: { key: string }) => {
      prefsStore.delete(options.key);
    }),
  },
}));

import { Preferences } from '@capacitor/preferences';
import {
  backupRaw,
  clearAll,
  isNativeStorage,
  loadPersistedAsync,
  savePersisted,
  savePersistedSync,
} from '../storage';

/** stub 原生桥全局：鸭子类型探测的全部依据 */
function stubNative(pluginAvailable = true): void {
  vi.stubGlobal('Capacitor', {
    isNativePlatform: () => true,
    isPluginAvailable: (name: string) => pluginAvailable && name === 'Preferences',
  });
}

/** localStorage 兜底路径的可断言存储（同 storage.test.ts 的 MemoryStorage） */
class MemoryStorage implements Storage {
  private map = new Map<string, string>();

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
    this.map.set(key, String(value));
  }
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
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
    parentId: null,
    estimatedMinutes: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function payload(tasks: Task[] = [makeTask()]): PersistedPayload {
  return {
    schemaVersion: SCHEMA_VERSION,
    savedAt: '2026-10-24T12:00:00.000Z',
    tasks,
    settings: createDefaultSettings('2026-10-24'),
    diary: [],
    tombstones: [],
    focusSessions: [],
    notes: [],
  };
}

/** Preferences.set 历次写入的 key 序列（按入队顺序） */
function setKeys(): string[] {
  return vi.mocked(Preferences.set).mock.calls.map((call) => call[0].key);
}

let store: MemoryStorage;

beforeEach(() => {
  prefsStore.clear();
  vi.mocked(Preferences.get).mockClear();
  vi.mocked(Preferences.set).mockClear();
  vi.mocked(Preferences.remove).mockClear();
  /**
   * `mockClear()` 只清调用记录、**不清 mockImplementation** ——
   * 某个用例把 set 改成"一直抛 quota"之后，实现会残留到后面的用例，
   * 让本来正常的写盘断言全部变成 undefined。这里每例都恢复默认实现。
   */
  vi.mocked(Preferences.set).mockImplementation(async (options) => {
    prefsStore.set(options.key, options.value);
  });
  store = new MemoryStorage();
  vi.stubGlobal('localStorage', store);
  stubNative();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ============================================================================
   平台探测：鸭子类型的全部输入形态
   ========================================================================= */
describe('isNativeStorage —— 鸭子类型探测', () => {
  it('无 Capacitor 全局 → false（网页 / 桌面 / vitest 默认态）', () => {
    vi.unstubAllGlobals();
    expect(isNativeStorage()).toBe(false);
  });

  it('Capacitor 存在但 isNativePlatform 非函数 → false', () => {
    vi.stubGlobal('Capacitor', { isNativePlatform: 'nope' });
    expect(isNativeStorage()).toBe(false);
  });

  it('isNativePlatform 抛错 → false（探测失败绝不是错误）', () => {
    vi.stubGlobal('Capacitor', {
      isNativePlatform: () => {
        throw new Error('bridge down');
      },
    });
    expect(isNativeStorage()).toBe(false);
  });

  it('原生桥就绪 → true', () => {
    expect(isNativeStorage()).toBe(true);
  });
});

/* ============================================================================
   原生 loadPersistedAsync：五条降级路径
   ========================================================================= */
describe('loadPersistedAsync —— 原生五条降级路径', () => {
  it('正常装载：任务与设置原样进来', async () => {
    prefsStore.set(STORAGE_KEY, JSON.stringify(payload()));
    const result = await loadPersistedAsync();
    expect(result.error).toBeNull();
    expect(result.backupCreated).toBe(false);
    expect(result.payload?.tasks).toHaveLength(1);
    expect(result.payload?.tasks[0]?.title).toBe('数学真题');
    expect(vi.mocked(Preferences.get)).toHaveBeenCalledWith({ key: STORAGE_KEY });
  });

  it('key 不存在：返回空态且不写', async () => {
    const result = await loadPersistedAsync();
    expect(result).toEqual({ payload: null, error: null, backupCreated: false });
    expect(prefsStore.size).toBe(0);
  });

  it('主 key 没了 → 从快照恢复', async () => {
    prefsStore.set(SNAPSHOT_KEY, JSON.stringify(payload([makeTask({ id: 'a1', title: '快照里的任务' })])));
    const result = await loadPersistedAsync();
    expect(result.restoredFromSnapshot).toBe(true);
    expect(result.error).toBeNull();
    expect(result.payload?.tasks[0]?.title).toBe('快照里的任务');
  });

  it('损坏 JSON：不抛、备份原文、返回 corrupt', async () => {
    prefsStore.set(STORAGE_KEY, '{');
    const result = await loadPersistedAsync();
    expect(result.error).toBe('corrupt');
    expect(result.payload).toBeNull();
    expect(result.backupCreated).toBe(true);
    expect(prefsStore.get(BACKUP_KEY)).toBe('{');
  });

  it('损坏 JSON 且已有备份时不再覆盖备份', async () => {
    prefsStore.set(BACKUP_KEY, '{"old":true}');
    prefsStore.set(STORAGE_KEY, 'not json');
    const result = await loadPersistedAsync();
    expect(result.error).toBe('corrupt');
    expect(result.backupCreated).toBe(false);
    expect(prefsStore.get(BACKUP_KEY)).toBe('{"old":true}');
  });

  it('schemaVersion 更高：只读备份，绝不覆盖原 key', async () => {
    const future = JSON.stringify({ schemaVersion: 99, tasks: [], settings: {} });
    prefsStore.set(STORAGE_KEY, future);
    const result = await loadPersistedAsync();
    expect(result.error).toBe('future-version');
    expect(result.payload).toBeNull();
    expect(result.backupCreated).toBe(true);
    expect(prefsStore.get(STORAGE_KEY)).toBe(future);
    expect(prefsStore.get(BACKUP_KEY)).toBe(future);
    // 只读保护的硬断言：整个装载过程从未 set 主 key
    expect(setKeys()).not.toContain(STORAGE_KEY);
  });

  it('Preferences.get reject → unavailable 且不抛', async () => {
    vi.mocked(Preferences.get).mockImplementationOnce(async () => {
      throw new Error('native bridge down');
    });
    await expect(loadPersistedAsync()).resolves.toEqual({
      payload: null,
      error: 'unavailable',
      backupCreated: false,
    });
  });
});

/* ============================================================================
   原生 savePersisted：双 key 镜像 + 错误映射
   ========================================================================= */
describe('savePersisted —— 原生', () => {
  it('成功写 STORAGE_KEY + SNAPSHOT_KEY 镜像（tasks>0）', async () => {
    const body = payload();
    const json = JSON.stringify(body);
    const result = await savePersisted(body);
    expect(result).toEqual({ ok: true });
    expect(prefsStore.get(STORAGE_KEY)).toBe(json);
    expect(prefsStore.get(SNAPSHOT_KEY)).toBe(json);
    expect(setKeys()).toEqual([STORAGE_KEY, SNAPSHOT_KEY]);
  });

  it('空 tasks 不覆盖上一份有效快照', async () => {
    const oldSnapshot = JSON.stringify(payload([makeTask({ id: 'a1', title: '保留我' })]));
    prefsStore.set(SNAPSHOT_KEY, oldSnapshot);
    const result = await savePersisted(payload([]));
    expect(result).toEqual({ ok: true });
    expect(prefsStore.get(SNAPSHOT_KEY)).toBe(oldSnapshot);
    expect(setKeys()).toEqual([STORAGE_KEY]);
  });

  it('set reject → { ok: false, reason: unknown }（不抛）', async () => {
    vi.mocked(Preferences.set).mockImplementationOnce(async () => {
      throw new Error('native write failed');
    });
    await expect(savePersisted(payload())).resolves.toEqual({ ok: false, reason: 'unknown' });
  });

  it('配额满 → 先牺牲备份腾空间重试，成功就不算失败', async () => {
    /**
     * v0.17.2 起：写正本遇到 quota 时，按「先丢 SNAPSHOT_PREV、再丢 SNAPSHOT」
     * 的顺序腾空间重试 —— 快照是备份，正本才是用户这一次的修改。
     * 只抛一次 = 腾完就写进去了。
     */
    prefsStore.set(SNAPSHOT_KEY, JSON.stringify(payload([makeTask({ id: 'x', title: '旧快照' })])));
    vi.mocked(Preferences.set)
      .mockImplementationOnce(async () => {
        const error = new Error('quota');
        error.name = 'QuotaExceededError';
        throw error;
      })
      .mockImplementation(async (options) => {
        prefsStore.set(options.key, options.value);
      });

    // 腾完备份后正本写进去了：结果就是 ok，不会再报 quota
    await expect(savePersisted(payload())).resolves.toEqual({ ok: true });
  });

  it('一直配额满 → 全部腾完仍失败，才如实报 quota', async () => {
    vi.mocked(Preferences.set).mockImplementation(async () => {
      const error = new Error('quota');
      error.name = 'QuotaExceededError';
      throw error;
    });
    await expect(savePersisted(payload())).resolves.toEqual({ ok: false, reason: 'quota' });
  });

  it('原生路径：Preferences 是权威，localStorage 是镜像（双写已开启）', async () => {
    /**
     * v0.12 起 NATIVE_DUAL_WRITE_PHASE = true。
     * 权威必须是 Preferences（原生层，跟 WebView origin 无关）——
     * 旧实现反过来把 localStorage 当权威，于是 APK 的 hostname 一改，
     * 那份数据就再也读不到（跨 origin 无 API 可读）。
     */
    store.setItem(STORAGE_KEY, 'web-leftover');
    await savePersisted(payload());
    // 权威端：真实数据
    expect(prefsStore.get(STORAGE_KEY)).toBeTruthy();
    expect(JSON.parse(prefsStore.get(STORAGE_KEY) as string).schemaVersion).toBeGreaterThan(0);
    // 镜像端：也被更新，不再是遗留值
    expect(store.getItem(STORAGE_KEY)).not.toBe('web-leftover');
  });

  it('主端为空、localStorage 有旧数据 → 读得到，并迁移进 Preferences', async () => {
    /**
     * 老版本 APK（localhost origin）的数据只躺在 localStorage。
     * 升级后主端（Preferences）是空的，但同 origin 的镜像端还有 ——
     * DualWriteBackend.get 必须把它读出来**并回写主端**，
     * 否则这次能看到、下次 origin 再变就又没了。
     */
    const legacy = JSON.stringify(payload([makeTask({ id: 'old', title: '老数据' })]));
    store.setItem(STORAGE_KEY, legacy);
    const load = await loadPersistedAsync();
    expect(load.payload?.tasks.some((task) => task.id === 'old')).toBe(true);
    expect(prefsStore.get(STORAGE_KEY)).toBe(legacy);
  });
});

/* ============================================================================
   原生 clearAll / backupRaw
   ========================================================================= */
describe('clearAll / backupRaw —— 原生', () => {
  it('clearAll 只删主 key（走 Preferences.remove），保留备份', async () => {
    prefsStore.set(STORAGE_KEY, JSON.stringify(payload()));
    prefsStore.set(BACKUP_KEY, 'keep-me');
    await clearAll();
    expect(prefsStore.has(STORAGE_KEY)).toBe(false);
    expect(prefsStore.get(BACKUP_KEY)).toBe('keep-me');
    expect(vi.mocked(Preferences.remove)).toHaveBeenCalledWith({ key: STORAGE_KEY });
  });

  it('backupRaw 只在备份为空时写', async () => {
    await expect(backupRaw('first')).resolves.toBe(true);
    await expect(backupRaw('second')).resolves.toBe(false);
    expect(prefsStore.get(BACKUP_KEY)).toBe('first');
  });
});

/* ============================================================================
   插件守卫：忘了 npx cap sync → isPluginAvailable=false → 回落 localStorage
   ========================================================================= */
describe('插件守卫回落（isPluginAvailable=false）', () => {
  beforeEach(() => {
    stubNative(false);
  });

  it('loadPersistedAsync 回落 LS，Preferences mock 零调用', async () => {
    store.setItem(STORAGE_KEY, JSON.stringify(payload()));
    const result = await loadPersistedAsync();
    expect(result.error).toBeNull();
    expect(result.payload?.tasks).toHaveLength(1);
    expect(vi.mocked(Preferences.get)).not.toHaveBeenCalled();
    expect(vi.mocked(Preferences.set)).not.toHaveBeenCalled();
  });

  it('savePersisted 回落 LS：数据落 localStorage，不崩不错', async () => {
    const result = await savePersisted(payload());
    expect(result).toEqual({ ok: true });
    expect(store.getItem(STORAGE_KEY)).toBeTruthy();
    expect(store.getItem(SNAPSHOT_KEY)).toBeTruthy();
    expect(prefsStore.size).toBe(0);
    expect(vi.mocked(Preferences.set)).not.toHaveBeenCalled();
  });

  it('clearAll 回落 LS', async () => {
    store.setItem(STORAGE_KEY, 'x');
    await clearAll();
    expect(store.getItem(STORAGE_KEY)).toBeNull();
    expect(vi.mocked(Preferences.remove)).not.toHaveBeenCalled();
  });
});

/* ============================================================================
   v0.12 修正：主 key **损坏**时也要回退快照

   原先这里和"主 key 缺失"不对称：缺失会去翻快照，损坏却直接判死。
   而损坏恰恰更常见 —— 写入被中断、容量写满截断，留下的都是半截 JSON。
   原文会先另存到 BACKUP_KEY，所以回退快照不会销毁任何原始字节。
   ========================================================================= */
describe('主 key 损坏 → 回退两级快照', () => {
  it('有快照时用快照救回来，并标记 restoredFromSnapshot', async () => {
    const good = JSON.stringify(payload([makeTask({ id: 'snap', title: '快照里的任务' })]));
    prefsStore.set(SNAPSHOT_KEY, good);
    prefsStore.set(STORAGE_KEY, '{"schemaVersion":5,"tasks":[{"id":'); // 半截 JSON

    const result = await loadPersistedAsync();

    expect(result.payload?.tasks.some((t) => t.id === 'snap')).toBe(true);
    expect(result.restoredFromSnapshot).toBe(true);
    // 损坏原文必须另存，绝不销毁
    expect(result.backupCreated).toBe(true);
  });

  it('连快照都没有 → 明确报 corrupt（不静默给空数据）', async () => {
    prefsStore.set(STORAGE_KEY, '不是 JSON');
    const result = await loadPersistedAsync();
    expect(result.error).toBe('corrupt');
    expect(result.payload).toBeNull();
  });
});

/* ============================================================================
   savePersistedSync —— 原生端必须"承认自己做不到"（v0.29.6，P0）
   ----------------------------------------------------------------------------
   症状：APK 上切后台那一刻的最后一次编辑，重开应用后消失。

   真因：`usePersist` 在 pagehide / visibilitychange 时先试同步写，
   成功就**跳过异步写链**。而 `savePersistedSync` 原来只判 `getStorage()`
   —— WebView 里 localStorage 一直存在，于是它把数据写进**镜像**并返回
   `{ ok: true }`，`pending` 被清空，真正的权威存储（Preferences）永远收不到。

   所以契约是：原生端必须返回 `null`（= 这个环境做不到同步写），
   让调用方回落异步链；只有 web / 桌面才允许同步写。
   ========================================================================= */
describe('savePersistedSync —— 原生端拒绝冒充成功', () => {
  beforeEach(() => {
    prefsStore.clear();
    vi.stubGlobal('localStorage', new MemoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('原生平台 → 返回 null（调用方据此回落异步写链）', () => {
    stubNative();
    expect(savePersistedSync(payload())).toBeNull();
  });

  it('而且**没有**偷偷写 localStorage 镜像（写了就等于埋下"只存在镜像里"的雷）', () => {
    stubNative();
    savePersistedSync(payload());
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('非原生（web / 桌面）→ 正常同步落盘', () => {
    // 这个文件的 beforeAll 级 beforeEach 默认就 stub 了原生桥，必须先关掉
    vi.stubGlobal('Capacitor', { isNativePlatform: () => false, isPluginAvailable: () => true });
    const result = savePersistedSync(payload());
    expect(result).toEqual({ ok: true });
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });
});
