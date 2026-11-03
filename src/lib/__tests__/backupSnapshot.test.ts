import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPersisted, savePersisted } from '../storage';
import { parseBackupJson } from '../backup';
import {
  SCHEMA_VERSION,
  SNAPSHOT_KEY,
  SNAPSHOT_PREV_KEY,
  SNAPSHOT_PREV_MAX_BYTES,
  STORAGE_KEY,
  createDefaultSettings,
} from '../../constants';
import type { PersistedPayload, Task } from '../../types';

/* ============================================================================
   A/B 双快照（Web / Android 的零依赖兜底）与备份解析入口

   单快照的死穴：最后两份写出去的内容都坏了，就没有任何东西可回退。
   双快照（当前 + 上一份）把这条死路打开 —— 但两个坑必须钉住：
   ① **空数据不挪 prev**：一次"数据被清空"的保存若把两份都推成空，兜底归零；
   ② **体积保护**：三份大 JSON 撞 5 MB 配额时，第一个失败的是主 key 写入，
      为了备份把正本弄丢比不备份更糟。
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

const task = (title: string, note = ''): Task => ({
  id: `t_${title}`,
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
});

function payload(title: string, note = ''): PersistedPayload {
  return {
    schemaVersion: SCHEMA_VERSION,
    savedAt: '2026-10-24T10:00:00.000Z',
    tasks: [task(title, note)],
    settings: createDefaultSettings('2026-10-24'),
    diary: [],
    tombstones: [],
    focusSessions: [],
    notes: [],
  };
}

describe('A/B 双快照', () => {
  it('两份 key 都有值，且 PREV 恰好是上一份', async () => {
    await savePersisted(payload('第一份'));
    expect(JSON.parse(store.getItem(SNAPSHOT_KEY) as string).tasks[0].title).toBe('第一份');
    expect(store.getItem(SNAPSHOT_PREV_KEY)).toBeNull(); // 第一份没有"上一份"

    await savePersisted(payload('第二份'));
    expect(JSON.parse(store.getItem(SNAPSHOT_KEY) as string).tasks[0].title).toBe('第二份');
    expect(JSON.parse(store.getItem(SNAPSHOT_PREV_KEY) as string).tasks[0].title).toBe('第一份');
  });

  it(`上一份超过 ${Math.round(SNAPSHOT_PREV_MAX_BYTES / 1024)} KB 时跳过 prev（配额保护）`, async () => {
    // 直接写盘的是未经 sanitize 的载荷，所以这里能造出超大快照
    await savePersisted(payload('超大', 'x'.repeat(SNAPSHOT_PREV_MAX_BYTES + 1024)));
    expect((store.getItem(SNAPSHOT_KEY) as string).length).toBeGreaterThan(SNAPSHOT_PREV_MAX_BYTES);

    await savePersisted(payload('小份'));
    expect(store.getItem(SNAPSHOT_PREV_KEY)).toBeNull();
    // 但当前快照仍然被更新了 —— 备份不能阻断正事
    expect(JSON.parse(store.getItem(SNAPSHOT_KEY) as string).tasks[0].title).toBe('小份');
  });

  it('空数据不挪 prev（否则"清空数据"会把两份历史一起推成空）', async () => {
    await savePersisted(payload('有效'));
    await savePersisted(payload('第二份'));
    expect(store.getItem(SNAPSHOT_PREV_KEY)).not.toBeNull();

    await savePersisted({
      ...payload('空'),
      tasks: [],
      diary: [],
      notes: [],
      focusSessions: [],
      tombstones: [],
    });
    // prev 还是那份有效的
    expect(JSON.parse(store.getItem(SNAPSHOT_PREV_KEY) as string).tasks[0].title).toBe('有效');
  });

  it('SNAPSHOT 坏了 + PREV 好 → 仍能恢复', async () => {
    await savePersisted(payload('第一份'));
    await savePersisted(payload('第二份'));
    store.setItem(SNAPSHOT_KEY, '{ 这不是 JSON');
    store.removeItem(STORAGE_KEY); // 模拟主 key 丢失

    const result = loadPersisted();
    expect(result.restoredFromSnapshot).toBe(true);
    expect(result.payload?.tasks[0]?.title).toBe('第一份');
  });

  it('两份都坏 → 不抛，返回空载荷', async () => {
    store.setItem(SNAPSHOT_KEY, '坏的');
    store.setItem(SNAPSHOT_PREV_KEY, '也坏的');
    store.removeItem(STORAGE_KEY);
    const result = loadPersisted();
    expect(result.payload).toBeNull();
    expect(result.error).toBeNull();
  });
});

describe('parseBackupJson：唯一解析入口，永不抛', () => {
  it('合法载荷能解析出来', () => {
    const text = JSON.stringify(payload('备份里的任务'));
    const parsed = parseBackupJson(text);
    expect(parsed?.tasks[0]?.title).toBe('备份里的任务');
    expect(parsed?.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('坏 JSON / 空串 / 非字符串 → null', () => {
    for (const bad of ['', '   ', 'not json', '{', 'undefined', null, undefined, 42, {}]) {
      expect(parseBackupJson(bad as unknown as string)).toBeNull();
    }
  });

  it('未来版本 → null（降级安装不能瞎装载）', () => {
    expect(parseBackupJson(JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1, tasks: [] }))).toBeNull();
  });

  it('形状不像载荷 → null（防止随手选个 package.json 把数据清空）', () => {
    for (const bad of ['[]', '{}', '{"hello":"world"}', '{"name":"daily-todo"}', 'null', '123']) {
      expect(parseBackupJson(bad)).toBeNull();
    }
  });

  it('脏数据被字段级兜底而不是抛异常', () => {
    const parsed = parseBackupJson(
      JSON.stringify({ schemaVersion: SCHEMA_VERSION, tasks: 'nope', diary: null, notes: [{ id: 'n1' }] }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.tasks).toEqual([]);
    expect(parsed?.diary).toEqual([]);
    expect(parsed?.notes).toHaveLength(1);
  });

  it('恢复后回收站与专注记录都在（专验唯一入口没漏字段）', () => {
    const full = {
      schemaVersion: SCHEMA_VERSION,
      savedAt: '2026-10-24T10:00:00.000Z',
      tasks: [task('任务')],
      settings: createDefaultSettings('2026-10-24'),
      diary: [{ date: '2026-10-24', content: '今天', createdAt: 'x', updatedAt: 'x' }],
      tombstones: [
        { id: 'gone', deletedAt: '2026-10-23T10:00:00.000Z', title: '删掉的', date: '2026-10-22', index: 0 },
      ],
      focusSessions: [
        {
          id: 'f1',
          taskId: 't_任务',
          date: '2026-10-24',
          startedAt: '2026-10-24T09:00:00.000Z',
          endedAt: '2026-10-24T09:25:00.000Z',
          durationMs: 0,
        },
      ],
      notes: [],
    };
    const parsed = parseBackupJson(JSON.stringify(full));
    expect(parsed?.tombstones).toHaveLength(1);
    expect(parsed?.focusSessions).toHaveLength(1);
    expect(parsed?.diary[0]?.content).toBe('今天');
  });
});
