import { describe, expect, it } from 'vitest';
import { DIARY_MAX, SCHEMA_VERSION, createDefaultSettings } from '../../constants';
import { mergeDiary, mergeSnapshots } from '../cloudSync';
import { migrate, sanitizeDiary } from '../storage';
import type { DiaryEntry, PersistedPayload } from '../../types';

/* ============================================================================
   日记：迁移 / 兜底 / 多设备合并

   落点是"日记绝不能因为同步而丢"—— 任务和日记两套数据共用同一条同步链路，
   任务那条链路踩过的坑（整包互盖）不能在日记上重演。
   ========================================================================= */

function entry(date: string, content: string, updatedAt: string): DiaryEntry {
  return { date, content, createdAt: updatedAt, updatedAt };
}

function payload(tasks: PersistedPayload['tasks'], diary: DiaryEntry[], savedAt = '2026-10-24T10:00:00.000Z'): PersistedPayload {
  return {
    schemaVersion: SCHEMA_VERSION,
    savedAt,
    tasks,
    /**
     * 用 createDefaultSettings 打底，只覆盖这一条用例真正关心的字段。
     * 手抄整份 Settings 的代价是：**每新增一个 settings 字段，这个文件就要跟着改**，
     * 而它关心的只是日记合并 —— 之前已经因此红过一次。
     */
    settings: {
      ...createDefaultSettings('2026-10-24'),
      theme: 'light',
      categories: [{ id: 'c_learn', name: '学习' }],
    },
    diary,
    tombstones: [],
    focusSessions: [],
    notes: [],
  };
}

describe('schemaVersion 1 → 2 迁移', () => {
  it('老载荷升级后任务一个不少，并补出空 diary', () => {
    const old = {
      schemaVersion: 1,
      savedAt: '2026-10-24T10:00:00.000Z',
      tasks: [{ id: 'a1', title: '别丢了我', note: '', date: '2026-10-24', time: null, priority: 'medium', category: '学习', done: false, doneAt: null, createdAt: 'x', updatedAt: 'x' }],
      settings: null,
    };
    const result = migrate(old);
    expect(result?.schemaVersion).toBe(SCHEMA_VERSION);
    expect(result?.tasks).toHaveLength(1);
    expect(result?.tasks[0]?.title).toBe('别丢了我');
    expect(result?.diary).toEqual([]);
  });

  it('老载荷里已带 diary（另一台新端写上去的）要原样保留', () => {
    const old = {
      schemaVersion: 1,
      savedAt: 'x',
      tasks: [],
      settings: null,
      diary: [entry('2026-10-24', '提前写好的', '2026-10-24T09:00:00.000Z')],
      tombstones: [],
      focusSessions: [],
      notes: [],
    };
    const result = migrate(old);
    expect(result?.diary).toHaveLength(1);
    expect(result?.diary[0]?.content).toBe('提前写好的');
  });
});

describe('sanitizeDiary 字段级兜底', () => {
  it('丢弃非对象项与非法日期项', () => {
    expect(sanitizeDiary([null, 'x', 42, { date: 'not-a-date', content: 'a' }, { content: '没有日期' }])).toEqual([]);
  });

  it('空正文**保留**（它代表"用户清空了这篇"，要能同步到别的设备）', () => {
    const result = sanitizeDiary([entry('2026-10-24', '', '2026-10-24T10:00:00.000Z')]);
    expect(result).toHaveLength(1);
    expect(result[0]?.content).toBe('');
  });

  it('正文超长截断到 DIARY_MAX', () => {
    const result = sanitizeDiary([entry('2026-10-24', 'a'.repeat(DIARY_MAX + 500), 'x')]);
    expect(result[0]?.content).toHaveLength(DIARY_MAX);
  });

  it('同一天重复时按 updatedAt 取新', () => {
    const result = sanitizeDiary([
      entry('2026-10-24', '旧的', '2026-10-24T09:00:00.000Z'),
      entry('2026-10-24', '新的', '2026-10-24T20:00:00.000Z'),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.content).toBe('新的');
  });

  it('脏数据（非数组）兜底为空数组，不抛异常', () => {
    expect(sanitizeDiary(null)).toEqual([]);
    expect(sanitizeDiary('x')).toEqual([]);
    expect(sanitizeDiary({})).toEqual([]);
  });
});

describe('mergeDiary 多设备合并', () => {
  it('两边各写了不同日期 → 都在（谁都不丢）', () => {
    const local = [entry('2026-10-24', '电脑写的', '2026-10-24T10:00:00.000Z')];
    const remote = [entry('2026-10-25', '手机写的', '2026-10-25T10:00:00.000Z')];
    const merged = mergeDiary(local, remote);
    expect(merged).toHaveLength(2);
    expect(merged.map((e) => e.content).sort()).toEqual(['手机写的', '电脑写的']);
  });

  it('同一天两边都写了 → updatedAt 新的赢', () => {
    const local = [entry('2026-10-24', '电脑改的', '2026-10-24T20:00:00.000Z')];
    const remote = [entry('2026-10-24', '手机改的', '2026-10-24T10:00:00.000Z')];
    expect(mergeDiary(local, remote)[0]?.content).toBe('电脑改的');
    expect(mergeDiary(remote, local)[0]?.content).toBe('电脑改的');
  });

  it('一边清空（空正文）一边有内容 → 后改的赢，删除能传播', () => {
    // 手机 10:00 写了，电脑 20:00 清空 → 合并结果应该是空
    const remote = [entry('2026-10-24', '手机写的', '2026-10-24T10:00:00.000Z')];
    const local = [entry('2026-10-24', '', '2026-10-24T20:00:00.000Z')];
    expect(mergeDiary(local, remote)[0]?.content).toBe('');
  });

  it('另一侧没有 diary（老版本载荷）也不抛异常，本机日记全留', () => {
    const local = [entry('2026-10-24', '本机日记', 'x')];
    expect(mergeDiary(local, undefined as unknown as DiaryEntry[])).toHaveLength(1);
    expect(mergeDiary(undefined as unknown as DiaryEntry[], local)).toHaveLength(1);
  });

  it('按日期倒序输出（新在前）', () => {
    const merged = mergeDiary(
      [entry('2026-10-22', 'a', 'x')],
      [entry('2026-10-26', 'b', 'x'), entry('2026-10-24', 'c', 'x')],
    );
    expect(merged.map((e) => e.date)).toEqual(['2026-10-26', '2026-10-24', '2026-10-22']);
  });
});

describe('mergeSnapshots 带上日记', () => {
  it('整包合并后日记是两边的并集', () => {
    const local = payload([], [entry('2026-10-24', '电脑写的', '2026-10-24T10:00:00.000Z')]);
    const remote = payload([], [entry('2026-10-25', '手机写的', '2026-10-25T10:00:00.000Z')]);
    const merged = mergeSnapshots(local, remote);
    expect(merged.diary).toHaveLength(2);
  });

  it('合并结果过 migrate → 坏日记条目被兜底掉，不会写回云端', () => {
    const local = payload([], [{ date: 'not-a-date', content: 'x', createdAt: 'x', updatedAt: 'x' }]);
    const remote = payload([], [entry('2026-10-25', '好的', 'x')]);
    const merged = mergeSnapshots(local, remote);
    expect(merged.diary).toHaveLength(1);
    expect(merged.diary[0]?.date).toBe('2026-10-25');
  });
});
