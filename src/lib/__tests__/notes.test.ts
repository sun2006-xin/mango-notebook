import { describe, expect, it } from 'vitest';
import { createEmptyState, hydrateFromLoad, reducer } from '../../store/reducer';
import { migrate, buildBackupPayload, isNoteDeleted } from '../storage';
import { mergeNotes } from '../cloudSync';
import type { Note, PersistedPayload } from '../../types';
import { backupSource } from './support/backupSource';

/* ============================================================================
   记事本的三条生命线
   ① 迁移：老数据（schema 4）里没有 notes，补空数组，一个字节都不许丢
   ② 合并：两端都可能有记事，按 id 并集、updatedAt 新者胜
   ③ 装载：hydrateFromPayload 必须带回 notes —— 漏了 = 升级后记事全部消失
   ========================================================================= */

const note = (id: string, updatedAt: string, title = id): Note => ({
  id,
  title,
  content: `${title} 的内容`,
  category: '',
  pinned: false,
  createdAt: '2026-10-27T08:00:00.000Z',
  updatedAt,
});

describe('迁移 4 → 5：新增 notes', () => {
  it('老数据补空数组，其余字段原样透传', () => {
    const old = {
      schemaVersion: 4,
      savedAt: '2026-10-25T16:33:27.636Z',
      tasks: [{ id: 't1', title: '复习' }],
      settings: { theme: 'light' },
    };
    const next = migrate(old);
    expect(next).not.toBeNull();
    expect(next?.schemaVersion).toBe(5);
    expect(next?.notes).toEqual([]);
    // migrate 会对 tasks 做字段级补全（sanitizeTasks），所以不要求字节不动；
    // 只需确认老任务没丢、id 还在 —— 这才是迁移真正的契约
    expect(Array.isArray(next?.tasks) ? next.tasks[0]?.id : undefined).toBe('t1');
    expect(next?.savedAt).toBe(old.savedAt);
  });

  it('已有 notes 的数据原样保留', () => {
    const keep = [note('n1', '2026-10-27T08:00:00.000Z')];
    const next = migrate({ schemaVersion: 5, savedAt: 'x', notes: keep });
    expect(next?.notes).toEqual(keep);
  });

  it('备份往返：导出再导入，记事一个不少', () => {
    const notes = [note('n1', '2026-10-27T08:00:00.000Z'), note('n2', '2026-10-27T09:00:00.000Z')];
    const json = JSON.stringify(buildBackupPayload(backupSource({ settings: {} as never, notes })));
    const back = migrate(JSON.parse(json));
    expect(back?.notes.map((n) => n.id).sort()).toEqual(['n1', 'n2']);
  });
});

describe('mergeNotes：合并语义', () => {
  it('并集：两边各有独有的一条，都得在', () => {
    const a = [note('a', '2026-10-27T08:00:00.000Z')];
    const b = [note('b', '2026-10-27T08:00:00.000Z')];
    const merged = mergeNotes(a, b);
    expect(merged.map((n) => n.id).sort()).toEqual(['a', 'b']);
  });

  it('冲突：updatedAt 新的一端胜出', () => {
    const local = [note('n1', '2026-10-27T10:00:00.000Z', '本机改的')];
    const remote = [note('n1', '2026-10-27T09:00:00.000Z', '云端旧的')];
    expect(mergeNotes(local, remote)[0].title).toBe('本机改的');
    // 反过来也一样，别写成"本机永远赢"
    expect(mergeNotes(remote, local)[0].title).toBe('本机改的');
  });

  it('坏数据：无 id 的条目直接丢弃，不崩', () => {
    const bad = [{ ...note('x', '2026-10-27T08:00:00.000Z'), id: '' }] as unknown as Note[];
    expect(mergeNotes(bad, [])).toEqual([]);
  });
});

const NOW = '2026-10-27T10:00:00.000Z';
const NOW_LATER = '2026-10-27T11:00:00.000Z';
const NOW_DELETED = '2026-10-27T12:00:00.000Z';
const NOW_REVIVED = '2026-10-27T13:00:00.000Z';

describe('装载与 reducer', () => {
  it('hydrateFromLoad 必须带回 notes（漏了 = 升级后记事全部消失）', () => {
    const payload = {
      schemaVersion: 5,
      savedAt: 'x',
      tasks: [],
      settings: {} as PersistedPayload['settings'],
      diary: [],
      tombstones: [],
      focusSessions: [],
      notes: [note('n1', '2026-10-27T08:00:00.000Z')],
    };
    const action = hydrateFromLoad({ payload, error: null, backupCreated: false });
    const state = reducer(createEmptyState(), action);
    expect(state.notes.map((n) => n.id)).toEqual(['n1']);
  });

  it('NOTE_UPSERT 新建置顶插入头部，编辑原地更新', () => {
    const base = createEmptyState();
    const created = reducer(base, { type: 'NOTE_UPSERT', note: note('n1', 'x'), now: NOW });
    expect(created.notes).toHaveLength(1);
    expect(created.notes[0].createdAt).toBe(created.notes[0].updatedAt); // 新建时两戳相同

    const edited = reducer(created, {
      type: 'NOTE_UPSERT',
      note: { ...created.notes[0], title: '改过' },
      now: NOW_LATER,
    });
    expect(edited.notes).toHaveLength(1); // 不是又插一条
    expect(edited.notes[0].title).toBe('改过');
    // 时间戳由调用方传进来，reducer 不读时钟（同样的输入必得同样的输出）
    expect(edited.notes[0].updatedAt).toBe(NOW_LATER);
  });

  /**
   * 删除改成了软删除（content 置空 + updatedAt 打点），与日记的 DIARY_DELETE 同款：
   * 真把条目 filter 掉的话，"删了"这件事无从同步 —— 另一台还留着正文的设备
   * 一合并就会把它带回来。留着空壳，它的 updatedAt 比任何正文都新，
   * 合并时 updatedAt 新者胜 → 删除状态同样能推到别的设备。
   */
  it('NOTE_DELETE 软删除：只置空指定的那条，空壳仍留在载荷里', () => {
    let state = createEmptyState();
    for (const id of ['a', 'b']) state = reducer(state, { type: 'NOTE_UPSERT', note: note(id, 'x'), now: NOW });
    const next = reducer(state, { type: 'NOTE_DELETE', id: 'a', now: NOW_DELETED });

    // ① 用户视角：a 已经不在（列表与全局搜索都按 content 为空过滤）
    expect(next.notes.filter((n) => !isNoteDeleted(n)).map((n) => n.id)).toEqual(['b']);
    // ② 同步视角：空壳还在，且时间戳最新 —— 它才是"被删过"的唯一凭据
    const stone = next.notes.find((n) => n.id === 'a');
    expect(stone?.content).toBe('');
    expect(stone?.updatedAt).toBe(NOW_DELETED);
    // ③ 没动过正文的那条一个字节都不许改
    expect(next.notes.find((n) => n.id === 'b')?.updatedAt).toBe(NOW);
    // ④ 重新写入非空内容即"复活"：空壳被正文盖掉（且时间戳更新，合并时新者胜）
    expect(stone).toBeDefined();
    const revived = reducer(next, {
      type: 'NOTE_UPSERT',
      note: { ...(stone as Note), content: '重新写的正文' },
      now: NOW_REVIVED,
    });
    expect(revived.notes).toHaveLength(2);
    expect(revived.notes.find((n) => n.id === 'a')?.content).toBe('重新写的正文');
    expect(isNoteDeleted(revived.notes.find((n) => n.id === 'a'))).toBe(false);
  });

  it('DATA_CLEAR_ALL 连记事一起清', () => {
    let state = reducer(createEmptyState(), { type: 'NOTE_UPSERT', note: note('n1', 'x'), now: NOW });
    state = reducer(state, { type: 'DATA_CLEAR_ALL' });
    expect(state.notes).toEqual([]);
  });
});
