import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildBackupPayload,
  isNoteDeleted,
  loadPersisted,
  migrate,
  sanitizeNotes,
  savePersisted,
} from '../storage';
import { parseBackupJson } from '../backup';
import { decideSyncAction, mergeNotes, type CloudSnapshotMeta } from '../cloudSync';
import { createEmptyState, hydrateFromPayload, reducer } from '../../store/reducer';
import {
  buildReviewQueue,
  dueCount,
  enroll,
  grade,
  isCard,
  isDue,
  isNewCard,
  unenroll,
} from '../srs';
import { searchAll } from '../search';
import { SCHEMA_VERSION, createDefaultSettings } from '../../constants';
import { addDays } from '../date';
import type { AppState, Note, PersistedPayload } from '../../types';
import { backupSource } from './support/backupSource';

/* ============================================================================
   QA 独立验证（v0.8 · F1）：Note.sr 的数据安全链路

   与工程师的用例刻意**互补**：那些用例守的是单个函数，
   这里守的是"一条复习进度从磁盘 → 载荷 → 备份文件 → 恢复 → 云同步"的
   **整条链路**上会不会悄悄丢 / 悄悄变形。

   验证方式一律是**行为证明**（真的调函数、真的过 JSON、真的走 reducer），
   不看注释、不看断言文案。
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

const TODAY = '2026-10-24';
const NOW = '2026-10-24T09:30:00.000Z';
const LATER = '2026-10-25T09:30:00.000Z';

function note(id: string, extra: Partial<Note> = {}): Note {
  return {
    id,
    title: `${id} 标题`,
    content: `${id} 的正文：单调栈模板`,
    category: 'learn',
    pinned: false,
    createdAt: '2026-10-20T08:00:00.000Z',
    updatedAt: '2026-10-21T08:00:00.000Z',
    ...extra,
  };
}

/** 一份最小可用的载荷（其余集合为空，避免"空 vs 非空"干扰方向判定） */
function payload(notes: Note[], overrides: Partial<PersistedPayload> = {}): PersistedPayload {
  return {
    schemaVersion: SCHEMA_VERSION,
    savedAt: '2026-10-24T09:00:00.000Z',
    tasks: [],
    settings: createDefaultSettings(TODAY),
    diary: [],
    tombstones: [],
    focusSessions: [],
    notes,
    ...overrides,
  };
}

function remoteMeta(p: PersistedPayload): CloudSnapshotMeta {
  return { payload: p, savedAt: p.savedAt, taskCount: p.tasks.length };
}

/* ============================================================================
   A1 / A3：坏 sr 只丢 sr；无 sr 的 note 不允许出现 sr 键
   ========================================================================= */
describe('A1 坏 sr 只丢 sr、不丢 note（经 migrate 全链路）', () => {
  it('due 不存在 + ivl 负数 + reps 字符串 → 只剩 1 条 note，且没有 sr 键', () => {
    const broken = {
      id: 'n1',
      title: '单调栈模板',
      content: '遇到更小的就弹栈……',
      category: 'learn',
      pinned: true,
      createdAt: '2026-10-20T08:00:00.000Z',
      updatedAt: '2026-10-21T08:00:00.000Z',
      sr: { due: '2026-02-30', ivl: -1, reps: 'x' },
    };
    const result = migrate({
      schemaVersion: SCHEMA_VERSION,
      savedAt: '2026-10-24T09:00:00.000Z',
      tasks: [],
      notes: [broken],
    });

    expect(result).not.toBeNull();
    expect(result?.notes).toHaveLength(1);
    const kept = result?.notes[0] as Note;
    // 七个字段一个都不能少 —— 复习进度可以重建，笔记正文不能重建
    expect(kept.title).toBe('单调栈模板');
    expect(kept.content).toBe('遇到更小的就弹栈……');
    expect(kept.category).toBe('learn');
    expect(kept.pinned).toBe(true);
    expect(kept.createdAt).toBe('2026-10-20T08:00:00.000Z');
    // 断言键的存在性（toEqual 会忽略 undefined，这里必须用 in / Object.keys）
    expect('sr' in kept).toBe(false);
    expect(Object.keys(kept)).not.toContain('sr');
  });

  it('sanitizeNotes 对"sr 是数组/字符串/null"同样只丢 sr', () => {
    for (const bad of [[], 'card', null, 0, { due: '2026-10-24' }]) {
      const list = sanitizeNotes([{ ...note('n1'), sr: bad }]);
      expect(list).toHaveLength(1);
      expect('sr' in (list[0] as Note)).toBe(false);
      expect(list[0]?.content).toBe('n1 的正文：单调栈模板');
    }
  });

  it('合法 sr 一个字段都不许变形', () => {
    const list = sanitizeNotes([{ ...note('n1'), sr: { due: '2026-11-03', ivl: 10, reps: 4 } }]);
    expect(list[0]?.sr).toStrictEqual({ due: '2026-11-03', ivl: 10, reps: 4 });
    expect(Object.keys(list[0]?.sr ?? {}).sort()).toEqual(['due', 'ivl', 'reps']);
  });
});

/* ============================================================================
   A2：往返一致（内存 → 备份文件 → 恢复）
   ========================================================================= */
describe('A2 sr 的往返一致（备份 / 恢复 / 落盘）', () => {
  const card = note('c1', { sr: { due: '2026-11-03', ivl: 10, reps: 4 } });
  const plain = note('p1');
  const ghost = note('g1', { content: '', sr: { due: '2026-10-24', ivl: 3, reps: 1 } });

  it('buildBackupPayload → JSON → migrate：sr 逐字段一致，无 sr 的仍无 sr 键', () => {
    const built = buildBackupPayload(
      backupSource({ settings: createDefaultSettings(TODAY), notes: [card, plain, ghost] }),
    );
    const round = migrate(JSON.parse(JSON.stringify(built)));
    expect(round?.notes).toHaveLength(3);

    const byId = new Map((round?.notes ?? []).map((n) => [n.id, n]));
    expect(byId.get('c1')?.sr).toStrictEqual({ due: '2026-11-03', ivl: 10, reps: 4 });
    expect('sr' in (byId.get('p1') as Note)).toBe(false);
    // 软删除的空壳带着 sr 也要活着（它可能在别的设备上被再次编辑/复活）
    expect(byId.get('g1')?.content).toBe('');
    expect(byId.get('g1')?.sr).toStrictEqual({ due: '2026-10-24', ivl: 3, reps: 1 });
  });

  it('备份恢复（唯一入口 parseBackupJson → hydrateFromPayload）后复习进度还在', () => {
    const text = JSON.stringify(
      buildBackupPayload(
        backupSource({ settings: createDefaultSettings(TODAY), notes: [card, plain] }),
      ),
    );
    const parsed = parseBackupJson(text);
    expect(parsed).not.toBeNull();

    const state: AppState = reducer(createEmptyState(), hydrateFromPayload(parsed, null));
    const restored = state.notes.find((n) => n.id === 'c1') as Note;
    expect(restored.sr).toStrictEqual({ due: '2026-11-03', ivl: 10, reps: 4 });
    expect(isCard(restored)).toBe(true);
    expect(dueCount(state.notes, TODAY)).toBe(0); // 11-03 还没到，不该今天复习
    const noSr = state.notes.find((n) => n.id === 'p1') as Note;
    expect('sr' in noSr).toBe(false);
  });

  it('落盘 → 重载（localStorage 全链路）后 sr 不变', async () => {
    const saved = await savePersisted(payload([card, plain]));
    expect(saved).toStrictEqual({ ok: true });

    const loaded = loadPersisted();
    expect(loaded.error).toBeNull();
    const notes = loaded.payload?.notes ?? [];
    expect(notes.find((n) => n.id === 'c1')?.sr).toStrictEqual({
      due: '2026-11-03',
      ivl: 10,
      reps: 4,
    });
    expect('sr' in (notes.find((n) => n.id === 'p1') as Note)).toBe(false);
  });
});

/* ============================================================================
   A4：云同步 —— 只有 updatedAt 参与比较，sr 完全不可见
   ========================================================================= */
describe('A4 云同步对 sr 是"不可见"的（设计边界，必须靠 grade 刷时间戳兜住）', () => {
  const localCard = note('c1', {
    sr: { due: '2026-11-03', ivl: 10, reps: 4 },
    updatedAt: '2026-10-21T08:00:00.000Z',
  });
  const remoteOtherSr = note('c1', {
    sr: { due: '2026-12-09', ivl: 30, reps: 9 },
    updatedAt: '2026-10-21T08:00:00.000Z',
  });

  it('仅 sr 不同、updatedAt 相同 → decideSyncAction 判 none（内容判定看不见 sr）', () => {
    const action = decideSyncAction(payload([localCard]), remoteMeta(payload([remoteOtherSr])));
    expect(action).toBe('none');
  });

  it('所以 grade 必须刷 updatedAt：评级后同一组数据立刻判 merge', () => {
    const rated = grade(localCard, 'good', TODAY, NOW);
    expect(rated.updatedAt).toBe(NOW);
    // 只把 sr 换成本机评级结果、updatedAt 也换成 now → 判 merge（说明"变化"是能被识别的）
    const after = decideSyncAction(
      payload([rated]),
      remoteMeta(payload([{ ...remoteOtherSr, updatedAt: '2026-10-21T08:00:00.000Z' }])),
    );
    expect(after).toBe('merge');
  });

  it('反向核对：如果 grade 不刷 updatedAt（手动构造），同步会永远判 none → sr 传不出去', () => {
    const notBumped = { ...localCard, sr: { due: '2026-11-03', ivl: 10, reps: 5 } };
    expect(decideSyncAction(payload([notBumped]), remoteMeta(payload([remoteOtherSr])))).toBe('none');
  });

  it('mergeNotes：updatedAt 相同 → 本机胜（平局规则确定）', () => {
    const merged = mergeNotes([localCard], [remoteOtherSr]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.sr).toStrictEqual({ due: '2026-11-03', ivl: 10, reps: 4 });
  });

  it('mergeNotes：本机更新 → 本机 sr 胜；对端更新（退出复习）→ sr 消失', () => {
    const localNewer = mergeNotes(
      [{ ...localCard, updatedAt: LATER }],
      [remoteOtherSr],
    );
    expect(localNewer[0]?.sr).toStrictEqual({ due: '2026-11-03', ivl: 10, reps: 4 });

    const remoteNewer = mergeNotes(
      [localCard],
      [{ ...remoteOtherSr, updatedAt: LATER }],
    );
    expect(remoteNewer[0]?.sr).toStrictEqual({ due: '2026-12-09', ivl: 30, reps: 9 });

    // 对端退出复习：新版本上根本没有 sr 键 → 合并后本机也不该再是卡片
    const remoteUnenrolled = mergeNotes(
      [localCard],
      [{ ...note('c1', { updatedAt: LATER }) }],
    );
    expect('sr' in (remoteUnenrolled[0] as Note)).toBe(false);
    expect(isCard(remoteUnenrolled[0] as Note)).toBe(false);
  });
});

/* ============================================================================
   A5：软删除与复习队列的交互
   ========================================================================= */
describe('A5 软删除（NOTE_DELETE）与队列', () => {
  const card = note('c1', { sr: { due: TODAY, ivl: 3, reps: 1 } });

  function deleted(c: Note): Note {
    return reducer(
      { ...createEmptyState(), notes: [c] },
      { type: 'NOTE_DELETE', id: c.id, now: LATER },
    ).notes[0] as Note;
  }

  it('删除后是空壳：isNoteDeleted 为真，title/其他字段还在，sr 键仍在（凭据要能同步）', () => {
    const ghost = deleted(card);
    expect(isNoteDeleted(ghost)).toBe(true);
    expect(ghost.content).toBe('');
    expect(ghost.updatedAt).toBe(LATER);
    expect('sr' in ghost).toBe(true); // 删的是笔记，不是"退出复习"；键留着等同步
  });

  it('空壳不进队列、不计入 dueCount、不算卡片', () => {
    const ghost = deleted(card);
    expect(isCard(ghost)).toBe(false);
    expect(isDue(ghost, TODAY)).toBe(false);
    expect(dueCount([ghost], TODAY)).toBe(0);
    expect(buildReviewQueue([ghost], TODAY)).toEqual([]);
  });

  it('退出复习 → 重新加入：队列位置恢复，且是新卡（ivl 0）', () => {
    const off = unenroll(card, LATER);
    expect('sr' in off).toBe(false);
    expect(buildReviewQueue([off], TODAY)).toEqual([]);

    const back = enroll(off, TODAY, LATER);
    expect(isCard(back)).toBe(true);
    expect(isNewCard(back)).toBe(true);
    expect(buildReviewQueue([back], TODAY).map((n) => n.id)).toEqual(['c1']);
  });

  it('对空壳执行 enroll 不会让它变成卡片（正文没了就不该复习）', () => {
    const ghost = deleted(card);
    const enrolled = enroll(ghost, TODAY, LATER);
    // 已经有 sr → enroll 是 no-op，仍不是卡片
    expect(enrolled).toBe(ghost);
    expect(isCard(enrolled)).toBe(false);
    expect(buildReviewQueue([enrolled], TODAY)).toEqual([]);
  });
});

/* ============================================================================
   A4/A5 衍生：置顶 / 搜索 / 分类与 sr 的交叉影响
   ========================================================================= */
describe('sr 与置顶 / 搜索 / 分类的交叉行为', () => {
  it('置顶的卡片正常入队（pinned 只是列表排序，不影响复习）', () => {
    const pinnedCard = note('pin', { pinned: true, sr: { due: TODAY, ivl: 5, reps: 2 } });
    const normalCard = note('norm', { sr: { due: TODAY, ivl: 5, reps: 2 } });
    const queue = buildReviewQueue([pinnedCard, normalCard], TODAY);
    expect(queue.map((n) => n.id).sort()).toEqual(['norm', 'pin']);
  });

  it('搜索不命中 sr 里的内容（sr 不是正文）', () => {
    const card = note('c1', {
      title: '单调栈',
      content: '遇到更小的就弹栈',
      sr: { due: '2026-11-03', ivl: 365, reps: 9999 },
    });
    for (const probe of ['2026-11-03', '365', '9999']) {
      expect(searchAll(probe, [], [], [card]).notes).toEqual([]);
    }
    expect(searchAll('单调栈', [], [], [card]).notes.map((n) => n.id)).toEqual(['c1']);
  });

  it('分类只影响展示用的名字，不影响入队', () => {
    const a = note('a', { category: '', sr: { due: TODAY, ivl: 5, reps: 1 } });
    const b = note('b', { category: 'c_learn', sr: { due: TODAY, ivl: 5, reps: 1 } });
    expect(buildReviewQueue([a, b], TODAY)).toHaveLength(2);
  });

  it('跨天边界：due === today 算到期，due === today+1 不算', () => {
    const dueToday = note('t', { sr: { due: TODAY, ivl: 5, reps: 1 } });
    const dueTomorrow = note('t1', { sr: { due: addDays(TODAY, 1), ivl: 5, reps: 1 } });
    expect(isDue(dueToday, TODAY)).toBe(true);
    expect(isDue(dueTomorrow, TODAY)).toBe(false);
    expect(dueCount([dueToday, dueTomorrow], TODAY)).toBe(1);
    expect(buildReviewQueue([dueToday, dueTomorrow], TODAY).map((n) => n.id)).toEqual(['t']);
  });
});
