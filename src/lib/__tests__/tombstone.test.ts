import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, createDefaultSettings } from '../../constants';
import { applyTombstones, mergeSnapshots } from '../cloudSync';
import { sanitizeTombstones } from '../storage';
import type { PersistedPayload, Settings, Task, TaskTombstone } from '../../types';

/* ============================================================================
   删除的跨设备同步（墓碑）

   合并语义是「按 id 取并集」。这个语义天生只能表达"新增"和"修改"：
   一条记录被删了，数组里就此消失，对端无从分辨"被删了"和"从来没存在过"。
   结果就是 —— 刚删掉的任务，一同步就从云端那份原地复活。

   墓碑让删除变成一次**带时间戳的写入**，于是能参与 updatedAt 新者胜。
   ========================================================================= */

function settings(): Settings {
  return {
    // 基底用默认设置：以后新增字段不用再回来补这个字面量
    ...createDefaultSettings('2026-10-24'),
    schemaVersion: 1,
    theme: 'light',
    defaultView: 'today',
    weekStart: 1,
    categories: [{ id: 'c_learn', name: '学习' }],
    lastSelectedDate: '2026-10-24',
    lastView: 'today',
    filterMode: 'all',
    filterCategory: null,
    doneCollapsed: true,
    remindEnabled: false,
    dayStartHour: 0,
    focusMinutes: 25,
    breakMinutes: 5,
    goals: [],
    strictFocus: false,
    dailyNewCardLimit: 20,
    sleepLog: [],
    focusPrunedBefore: null,
    weekPlanTemplate: null,
  };
}

function task(id: string, updatedAt = '2026-10-24T10:00:00.000Z'): Task {
  return {
    id,
    title: '任务' + id,
    note: '',
    date: '2026-10-24',
    time: null,
    priority: 'medium',
    category: '学习',
    done: false,
    doneAt: null,
    createdAt: '2026-10-24T10:00:00.000Z',
    updatedAt,
    repeat: 'none',
    parentId: null,
    estimatedMinutes: 0,
  };
}

function stone(id: string, deletedAt: string, index = 0): TaskTombstone {
  return { id, deletedAt, title: id, date: '2026-10-24', index };
}

function payload(tasks: Task[], tombstones: TaskTombstone[] = []): PersistedPayload {
  return {
    schemaVersion: SCHEMA_VERSION,
    savedAt: '2026-10-24T10:00:00.000Z',
    tasks,
    settings: settings(),
    diary: [],
    tombstones,
    focusSessions: [],
    notes: [],
  };
}

describe('删除同步：墓碑', () => {
  it('本机删掉的任务不会被云端那份复活', () => {
    const local = payload([task('b')], [stone('a', '2026-10-25T09:00:00.000Z')]);
    const remote = payload([task('a'), task('b')], []);

    const merged = mergeSnapshots(local, remote);

    expect(merged.tasks.map((t) => t.id).sort()).toEqual(['b']);
    expect(merged.tombstones.map((t) => t.id)).toEqual(['a']);
  });

  it('云端删掉的任务，本机同步后也会被删掉', () => {
    const local = payload([task('a'), task('b')], []);
    const remote = payload([task('b')], [stone('a', '2026-10-25T09:00:00.000Z')]);

    const merged = mergeSnapshots(local, remote);

    expect(merged.tasks.map((t) => t.id)).toEqual(['b']);
    expect(merged.tombstones.map((t) => t.id)).toEqual(['a']);
  });

  it('两端都删过 → 墓碑合并成一条，不重复堆积', () => {
    const local = payload([], [stone('a', '2026-10-25T08:00:00.000Z')]);
    const remote = payload([], [stone('a', '2026-10-25T09:00:00.000Z')]);

    const merged = mergeSnapshots(local, remote);

    expect(merged.tombstones).toHaveLength(1);
    expect(merged.tombstones[0]?.deletedAt).toBe('2026-10-25T09:00:00.000Z');
  });

  it('删除之后对端又改过 → 任务复活，且墓碑被清除', () => {
    // 本机：任务 a 在 10-25 10:00 被编辑过（晚于云端的删除时间 09:00）
    const local = payload([task('a', '2026-10-25T10:00:00.000Z')], []);
    // 云端：a 已在 09:00 被删
    const remote = payload([], [stone('a', '2026-10-25T09:00:00.000Z')]);

    const merged = mergeSnapshots(local, remote);

    expect(merged.tasks.map((t) => t.id)).toEqual(['a']);
    // 复活了就不能再留墓碑，否则下次合并又会被删
    expect(merged.tombstones).toEqual([]);
  });

  it('applyTombstones 对脏数据兜底，绝不抛异常', () => {
    expect(applyTombstones([], undefined as unknown as TaskTombstone[])).toEqual([]);
    expect(applyTombstones(undefined as unknown as Task[], [])).toEqual([]);
    expect(
      applyTombstones([task('a')], [
        null as unknown as TaskTombstone,
        { id: '', deletedAt: 'x', title: '', date: '2026-10-24', index: 0 },
      ]),
    ).toHaveLength(1);
  });

  it('sanitizeTombstones 丢弃非法条目，只留 id 合法的', () => {
    const result = sanitizeTombstones([
      { id: 'a', deletedAt: '2026-10-25T09:00:00.000Z' },
      null,
      'nope',
      { deletedAt: 'x' },
      { id: 'a', deletedAt: '2026-10-25T10:00:00.000Z' },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.deletedAt).toBe('2026-10-25T10:00:00.000Z');
  });
});
