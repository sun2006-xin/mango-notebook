import { describe, expect, it } from 'vitest';
import { createEmptyState, hydrateFromLoad, reducer } from '../reducer';
import { grade, enroll, isCard, unenroll } from '../../lib/srs';
import { mergeNotes } from '../../lib/cloudSync';
import { migrate } from '../../lib/storage';
import { SCHEMA_VERSION } from '../../constants';
import type { Note, PersistedPayload } from '../../types';

/* ============================================================================
   复习进度在 reducer / 装载 / 云端合并三条路径上的存活

   关键点：F1 **不新增任何 reducer action** —— 入队 / 评级 / 退出全部复用
   `NOTE_UPSERT`。所以这里要证明的是"NOTE_UPSERT 确实能把 sr 带进去、带出来"，
   以及"跨设备时 sr 跟着 updatedAt 新者胜一起走"。
   ========================================================================= */

const NOW = '2026-10-24T10:00:00.000Z';
const TODAY = '2026-10-24';

const plain: Note = {
  id: 'n1',
  title: '单调栈',
  content: '遇到更小的就弹栈',
  category: 'c_learn',
  pinned: false,
  createdAt: '2026-10-20T08:00:00.000Z',
  updatedAt: '2026-10-20T08:00:00.000Z',
};

describe('NOTE_UPSERT 承载复习进度', () => {
  it('入队 → 评级 → 退出，全程只用 NOTE_UPSERT', () => {
    let state = createEmptyState();

    const enrolled = enroll(plain, TODAY, NOW);
    state = reducer(state, { type: 'NOTE_UPSERT', note: enrolled, now: NOW });
    expect(isCard(state.notes[0] as Note)).toBe(true);
    expect(state.notes[0]?.sr).toEqual({ due: TODAY, ivl: 0, reps: 0 });

    const graded = grade(state.notes[0] as Note, 'good', TODAY, '2026-10-24T11:00:00.000Z');
    state = reducer(state, { type: 'NOTE_UPSERT', note: graded, now: graded.updatedAt });
    expect(state.notes[0]?.sr).toEqual({ due: '2026-10-27', ivl: 3, reps: 1, last: '2026-10-24T11:00:00.000Z' });
    expect(state.notes[0]?.updatedAt).toBe('2026-10-24T11:00:00.000Z');

    const off = unenroll(state.notes[0] as Note, '2026-10-24T12:00:00.000Z');
    state = reducer(state, { type: 'NOTE_UPSERT', note: off, now: off.updatedAt });
    expect(state.notes[0] && 'sr' in state.notes[0]).toBe(false);
    expect(isCard(state.notes[0] as Note)).toBe(false);
  });

  it('编辑正文不会把 sr 冲掉（笔记本来就要能边复习边改）', () => {
    let state = reducer(createEmptyState(), {
      type: 'NOTE_UPSERT',
      note: enroll(plain, TODAY, NOW),
      now: NOW,
    });
    const edited = { ...(state.notes[0] as Note), content: '改过的正文' };
    state = reducer(state, { type: 'NOTE_UPSERT', note: edited, now: '2026-10-24T13:00:00.000Z' });
    expect(state.notes[0]?.sr).toEqual({ due: TODAY, ivl: 0, reps: 0 });
  });
});

describe('装载：sr 必须活着穿过 migrate', () => {
  it('hydrateFromLoad 带回来的 note 仍有 sr', () => {
    const payload: PersistedPayload = {
      schemaVersion: SCHEMA_VERSION,
      savedAt: '2026-10-24T10:00:00.000Z',
      tasks: [],
      settings: {} as PersistedPayload['settings'],
      diary: [],
      tombstones: [],
      focusSessions: [],
      notes: [enroll(plain, TODAY, NOW)],
    };
    const migrated = migrate(payload);
    expect(migrated?.notes[0]?.sr).toEqual({ due: TODAY, ivl: 0, reps: 0 });

    const state = reducer(
      createEmptyState(),
      hydrateFromLoad({ payload: migrated, error: null, backupCreated: false }),
    );
    expect(isCard(state.notes[0] as Note)).toBe(true);
  });
});

describe('云同步：sr 跟着 updatedAt 新者胜一起收敛', () => {
  it('评级后本机更新 → 合并时本机的 sr 赢', () => {
    const local = grade(plain, 'good', TODAY, '2026-10-24T11:00:00.000Z');
    const remote = plain; // 对端还是"没复习过"的旧版本
    const merged = mergeNotes([local], [remote]);
    expect(merged[0]?.sr?.ivl).toBe(3);

    // 反过来也一样（不是"本机永远赢"）
    expect(mergeNotes([remote], [local])[0]?.sr?.ivl).toBe(3);
  });

  it('对端更新（退出复习）→ 合并后 sr 消失', () => {
    const local = enroll(plain, TODAY, NOW);
    const remote = unenroll({ ...plain, sr: { due: TODAY, ivl: 3, reps: 1 } }, '2026-10-25T00:00:00.000Z');
    const merged = mergeNotes([local], [remote]);
    expect(merged[0] && 'sr' in merged[0]).toBe(false);
  });
});
