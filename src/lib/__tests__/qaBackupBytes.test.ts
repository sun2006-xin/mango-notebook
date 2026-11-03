import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPersisted, savePersisted } from '../storage';
import { parseBackupJson } from '../backup';
import {
  SCHEMA_VERSION,
  SNAPSHOT_KEY,
  SNAPSHOT_PREV_KEY,
  SNAPSHOT_PREV_MAX_BYTES,
  createDefaultSettings,
} from '../../constants';
import type { PersistedPayload } from '../../types';

/* ============================================================================
   QA 独立验证（v0.8 · F4）：备份的体积保护是**按字节**、解析入口永不抛

   两个最贵的失败模式：
   ① 512 KB 的守卫用 `string.length`（字符数）—— 中文快照的 length 只有字节数的
      1/3，守卫实际放行 1.5 MB，三份叠起来正好撞 5 MB 配额，**第一个失败的是主 key**；
   ② 用户误选 `package.json` 时 `migrate({})` 能"成功"并把本机数据清空 ——
      所以形状校验必须在 migrate 之前。
   ========================================================================= */

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

let store: MemoryStorage;

beforeEach(() => {
  store = new MemoryStorage();
  vi.stubGlobal('localStorage', store);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function payload(title: string, note = ''): PersistedPayload {
  return {
    schemaVersion: SCHEMA_VERSION,
    savedAt: '2026-10-24T10:00:00.000Z',
    tasks: [
      {
        id: 't1',
        title,
        note,
        date: '2026-10-24',
        time: null,
        repeat: 'none',
        priority: 'medium',
        category: '学习',
        done: false,
        doneAt: null,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
        parentId: null,
        estimatedMinutes: 0,
      },
    ],
    settings: createDefaultSettings('2026-10-24'),
    diary: [],
    tombstones: [],
    focusSessions: [],
    notes: [],
  };
}

/** 字符数远小于上限、UTF-8 字节数却超过上限的中文正文 */
function chineseNote(): string {
  const chars = Math.ceil(SNAPSHOT_PREV_MAX_BYTES / 3) + 20_000;
  return '中'.repeat(chars);
}

describe('512 KB 守卫按 UTF-8 字节（不是字符数）判定', () => {
  it('造一份"字符数未超、字节数已超"的中文快照，作为上一份时被跳过', async () => {
    const huge = chineseNote();
    expect(huge.length).toBeLessThan(SNAPSHOT_PREV_MAX_BYTES); // 若用 length 判定就会被放行
    expect(new TextEncoder().encode(huge).length).toBeGreaterThan(SNAPSHOT_PREV_MAX_BYTES);

    // ① 小份 → 快照 = 小份
    await savePersisted(payload('小份'));
    // ② 中文巨份 → 上一份（小份）合格，prev = 小份；当前快照 = 巨份（主 key 也照写）
    await savePersisted(payload('巨份', huge));
    expect(JSON.parse(store.getItem(SNAPSHOT_PREV_KEY) as string).tasks[0].title).toBe('小份');
    expect((store.getItem(SNAPSHOT_KEY) as string).length).toBeGreaterThan(10_000);

    // ③ 再存一份小的 → 上一份是巨份（字节超限）→ **跳过 prev**
    await savePersisted(payload('第三份'));
    const prev = JSON.parse(store.getItem(SNAPSHOT_PREV_KEY) as string);
    expect(prev.tasks[0].title).toBe('小份'); // 若按字符数判定，这里会变成"巨份"
    // 当前快照仍然照写（备份失败不能阻断正事）
    expect(JSON.parse(store.getItem(SNAPSHOT_KEY) as string).tasks[0].title).toBe('第三份');
  });

  it('主 key 与 SNAPSHOT 都丢了，只剩 PREV 也能救回来（双快照真的可用）', async () => {
    await savePersisted(payload('第一份'));
    await savePersisted(payload('第二份'));
    expect(store.getItem(SNAPSHOT_PREV_KEY)).not.toBeNull();

    store.removeItem('dt:app:v1'); // 主 key
    store.removeItem(SNAPSHOT_KEY); // 当前快照（模拟"A 快照也被清掉"）

    const result = loadPersisted();
    expect(result.restoredFromSnapshot).toBe(true);
    expect(result.payload?.tasks[0]?.title).toBe('第一份');
  });

  it('空数据既不覆盖 SNAPSHOT 也不挪 PREV（清空数据不能把两份历史一起推成空）', async () => {
    await savePersisted(payload('第一份'));
    await savePersisted(payload('第二份'));
    const snapshotBefore = store.getItem(SNAPSHOT_KEY);
    const prevBefore = store.getItem(SNAPSHOT_PREV_KEY);

    await savePersisted({ ...payload('空'), tasks: [], diary: [], notes: [], tombstones: [], focusSessions: [] });
    expect(store.getItem(SNAPSHOT_KEY)).toBe(snapshotBefore);
    expect(store.getItem(SNAPSHOT_PREV_KEY)).toBe(prevBefore);
  });
});

describe('parseBackupJson：形状校验先于 migrate，永不抛', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(HERE, '../../..');

  const rejects: [string, string][] = [
    ['坏 JSON', '{ 这不是 JSON'],
    ['空串', ''],
    ['纯空白', '   \n\t '],
    ['JSON null', 'null'],
    ['空对象', '{}'],
    ['空数组', '[]'],
    ['数字', '42'],
    ['字符串', '"hello"'],
    ['未来版本', JSON.stringify({ schemaVersion: 999, tasks: [] })],
    ['只有 settings（无 schemaVersion、无集合）', JSON.stringify({ settings: { theme: 'dark' } })],
    ['被截断的 JSON', JSON.stringify({ schemaVersion: 5, tasks: [] }).slice(0, 20)],
  ];

  for (const [label, text] of rejects) {
    it(`拒绝：${label} → null（不抛）`, () => {
      expect(() => parseBackupJson(text)).not.toThrow();
      expect(parseBackupJson(text)).toBeNull();
    });
  }

  it('用户误选 package.json（真实文件内容）→ null，本机数据不会被清空', () => {
    const pkg = fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8');
    expect(parseBackupJson(pkg)).toBeNull();
  });

  it('用户误选 tsconfig.json → 也是 null（有 version 字段但不是数字 schemaVersion）', () => {
    const raw = fs.readFileSync(path.join(projectRoot, 'tsconfig.json'), 'utf8');
    // 若这个文件恰好带数字 schemaVersion，本用例的前提不成立 → 直接跳过断言
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (Number.isFinite(Number(parsed.schemaVersion))) return;
    expect(parseBackupJson(raw)).toBeNull();
  });

  it('非字符串入参（null / undefined / 数字）不抛', () => {
    for (const bad of [null, undefined, 42, {}]) {
      expect(() => parseBackupJson(bad as unknown as string)).not.toThrow();
      expect(parseBackupJson(bad as unknown as string)).toBeNull();
    }
  });

  it('接受：没有 schemaVersion 但带 tasks 数组（v0 老形态）→ tasks 被保留', () => {
    const parsed = parseBackupJson(JSON.stringify({ tasks: [{ id: 't1', title: '数学' }] }));
    expect(parsed).not.toBeNull();
    expect(parsed?.tasks).toHaveLength(1);
    expect(parsed?.tasks[0]?.title).toBe('数学');
    expect(parsed?.schemaVersion).toBe(SCHEMA_VERSION);
  });

  /**
   * 【行为快照 · 已记录为 P3 边界，非本轮新增引入】
   *
   * `looksLikePayload` 认为"任意一个集合是数组"就算像载荷 → 放行；
   * 但 `migrate` 对**没有 schemaVersion** 的对象按 v0 处理，而 MIGRATIONS[0]
   * 是**重建** `{schemaVersion, savedAt, tasks, settings}`（不 spread 原对象），
   * 于是 notes / diary / focusSessions / tombstones 全部被丢掉，返回一份"合法但空"的载荷。
   *
   * 真实备份文件不受影响（buildBackupPayload 恒带 schemaVersion: 1，此点已在上面的用例证明）；
   * 只有"手写 / 被截断到只剩 notes 的 JSON"会命中。恢复前 UI 会展示各集合条数，
   * 用户能看到"记事 0"再确认，所以不是静默清空 —— 但形状校验与迁移口径不一致，
   * 建议后续把 MIGRATIONS[0] 改成 `...source` 展开（一行改动）。
   */
  it('边界：无 schemaVersion 且只有 notes 的裸对象 → v0 迁移必须保留 notes（P3-2 已修）', () => {
    const parsed = parseBackupJson(
      JSON.stringify({ notes: [{ id: 'n1', title: 't', content: 'c' }] }),
    );
    expect(parsed).not.toBeNull();
    // 修复前：MIGRATIONS[0] 重建对象（不展开 source）→ notes 被丢成空数组，
    // 而形状校验又放行了这种载荷 → 恢复时等于静默清空。
    // 修复后：MIGRATIONS[0] 先用 `...source` 打底 → notes 原样保留。
    expect(parsed?.notes).toHaveLength(1);
    expect(parsed?.notes[0]?.id).toBe('n1');
    expect(parsed?.tasks).toHaveLength(0);
  });

  it('接受：完整载荷里的 sr 在解析后保留（恢复后复习进度还在）', () => {
    const parsed = parseBackupJson(
      JSON.stringify({
        schemaVersion: 5,
        notes: [
          {
            id: 'n1',
            title: '单调栈',
            content: '弹栈',
            category: '',
            pinned: false,
            createdAt: '2026-10-20T08:00:00.000Z',
            updatedAt: '2026-10-21T08:00:00.000Z',
            sr: { due: '2026-11-03', ivl: 10, reps: 4 },
          },
        ],
      }),
    );
    expect(parsed?.notes[0]?.sr).toStrictEqual({ due: '2026-11-03', ivl: 10, reps: 4 });
  });
});
