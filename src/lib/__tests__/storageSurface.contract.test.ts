import { describe, expect, it } from 'vitest';

/* ============================================================================
   storage 的公开面（拆分前冻结）
   ----------------------------------------------------------------------------
   `lib/storage.ts` 是全工程唯一的数据出入口，被 hooks / store / 组件 / 测试
   到处 import。它从 777 行拆成三个文件（backend / snapshot / 本体）时，
   唯一不能变的就是**对外这张脸**：

     ① 这 18 个名字必须都还在（拆完由 storage.ts 统一再导出）；
     ② 名字的"种类"也不能变（函数别变成常量，异步别变成同步）。

   为什么用动态 import 列键而不是静态 import 后用 `toBeInstanceOf`：
   静态 import 会因为"少了一个名字"直接编译失败、报错指向 import 行，
   信息量不如这里一条条列出来的 diff。动态 import 能让我们看到**完整**的差集。
   ========================================================================= */

/** 拆分前 `storage.ts` 导出的全部名字（2026-11-02 快照） */
const EXPECTED = [
  'NATIVE_DUAL_WRITE_PHASE',
  '__storageKeys',
  'backupRaw',
  'buildBackupPayload',
  'clearAll',
  // 以下 9 个来自 `export { ... } from './sanitize'` 的再导出，
  // 调用方（store / hooks）一直是"从 storage 拿"，所以它们也属于公开面
  'hasAnyPersistedData',
  'isNoteDeleted',
  'sanitizeDiary',
  'sanitizeFocusSessions',
  'sanitizeNotes',
  'sanitizeRemind',
  'sanitizeSettings',
  'sanitizeTasks',
  'sanitizeTombstones',
  'getLocalStorage',
  'isFutureVersion',
  'isNativeStorage',
  'loadFocusPrefs',
  'loadPersisted',
  'loadPersistedAsync',
  'loadRunningTimer',
  'migrate',
  'peekRunningTimerRaw',
  'saveFocusPrefs',
  'savePersisted',
  'savePersistedSync',
  'saveRunningTimer',
] as const;

/** 必须是函数的那批（剩下的 `NATIVE_DUAL_WRITE_PHASE` / `__storageKeys` 是常量） */
const FUNCTIONS = EXPECTED.filter(
  (name) => name !== 'NATIVE_DUAL_WRITE_PHASE' && name !== '__storageKeys',
);

const mod = await import('../storage');
const exported = Object.keys(mod).sort();

describe('storage 公开面', () => {
  it('一个都不少（拆文件最容易丢的就是再导出）', () => {
    const missing = EXPECTED.filter((name) => !exported.includes(name));
    expect(missing, `拆完之后这些名字没了：${missing.join(', ')}`).toEqual([]);
  });

  it('也没有多出来的意外导出（多出来通常是把内部实现误导出）', () => {
    const extra = exported.filter((name) => !EXPECTED.includes(name as (typeof EXPECTED)[number]));
    expect(extra, `不该对外暴露：${extra.join(', ')}`).toEqual([]);
  });

  it('种类没变：该是函数的还是函数', () => {
    for (const name of FUNCTIONS) {
      expect(typeof (mod as Record<string, unknown>)[name], name).toBe('function');
    }
  });

  it('平台探测与 key 常量仍在（它们被 hooks / 测试直接引用）', () => {
    expect(typeof mod.isNativeStorage).toBe('function');
    expect(typeof mod.getLocalStorage).toBe('function');
    expect(mod.__storageKeys).toMatchObject({
      STORAGE_KEY: expect.any(String),
      BACKUP_KEY: expect.any(String),
      SNAPSHOT_KEY: expect.any(String),
      SNAPSHOT_PREV_KEY: expect.any(String),
    });
  });

  it('异步保存仍然是异步（返回 Promise 而不是裸结果）', async () => {
    const result = mod.savePersisted({
      schemaVersion: Number.MAX_SAFE_INTEGER, // 未来版本 → 走拒绝分支，不真写盘
      savedAt: '2026-11-02T00:00:00.000Z',
      tasks: [],
      settings: mod.buildBackupPayload({
        tasks: [],
        settings: undefined as never,
        diary: [],
        tombstones: [],
        focusSessions: [],
        notes: [],
      }).settings,
      diary: [],
      tombstones: [],
      focusSessions: [],
      notes: [],
    } as never);
    expect(result).toBeInstanceOf(Promise);
    await result;
  });
});
