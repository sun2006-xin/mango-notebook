import { describe, expect, it } from 'vitest';
import { DIARY_MAX } from '../../constants';
import { createEmptyState, reducer } from '../reducer';
import type { AppState, DiaryEntry } from '../../types';

/* ============================================================================
   日记的 reducer 行为
   落点：一天一篇、删除可同步（置空留墓碑）、HYDRATE 不静默清空。
   ========================================================================= */

const NOW = '2026-10-24T12:00:00.000Z';

function stateWith(diary: DiaryEntry[]): AppState {
  return { ...createEmptyState(), diary };
}

function entry(date: string, content: string, updatedAt = NOW): DiaryEntry {
  return { date, content, createdAt: NOW, updatedAt };
}

describe('DIARY_UPSERT', () => {
  it('新建一篇：带 createdAt / updatedAt', () => {
    const next = reducer(stateWith([]), { type: 'DIARY_UPSERT', date: '2026-10-24', content: '今天学了高数', now: NOW });
    expect(next.diary).toHaveLength(1);
    expect(next.diary[0]).toEqual({
      date: '2026-10-24',
      content: '今天学了高数',
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  it('同一天再写是覆盖，不是追加（一天一篇）', () => {
    const s1 = reducer(stateWith([]), { type: 'DIARY_UPSERT', date: '2026-10-24', content: '第一版', now: NOW });
    const s2 = reducer(s1, { type: 'DIARY_UPSERT', date: '2026-10-24', content: '第二版', now: '2026-10-24T20:00:00.000Z' });
    expect(s2.diary).toHaveLength(1);
    expect(s2.diary[0]?.content).toBe('第二版');
    // createdAt 保留首次创建时间，不能被覆盖
    expect(s2.diary[0]?.createdAt).toBe(NOW);
    expect(s2.diary[0]?.updatedAt).toBe('2026-10-24T20:00:00.000Z');
  });

  it('正文超过上限时截断，不抛异常', () => {
    const next = reducer(stateWith([]), {
      type: 'DIARY_UPSERT',
      date: '2026-10-24',
      content: 'a'.repeat(DIARY_MAX + 100),
      now: NOW,
    });
    expect(next.diary[0]?.content).toHaveLength(DIARY_MAX);
  });

  it('多篇按日期倒序（新在前）', () => {
    let s = stateWith([]);
    s = reducer(s, { type: 'DIARY_UPSERT', date: '2026-10-22', content: 'a', now: NOW });
    s = reducer(s, { type: 'DIARY_UPSERT', date: '2026-10-26', content: 'b', now: NOW });
    s = reducer(s, { type: 'DIARY_UPSERT', date: '2026-10-24', content: 'c', now: NOW });
    expect(s.diary.map((e) => e.date)).toEqual(['2026-10-26', '2026-10-24', '2026-10-22']);
  });
});

describe('DIARY_DELETE', () => {
  it('删除 = 置空（墓碑），让删除能同步到别的设备', () => {
    const s1 = stateWith([entry('2026-10-24', '要被删掉的')]);
    const s2 = reducer(s1, { type: 'DIARY_DELETE', date: '2026-10-24', now: '2026-10-24T20:00:00.000Z' });
    expect(s2.diary).toHaveLength(1);
    expect(s2.diary[0]?.content).toBe('');
    expect(s2.diary[0]?.updatedAt).toBe('2026-10-24T20:00:00.000Z');
  });

  it('本来就没写过 → 不动（返回同一对象，避免无谓保存）', () => {
    const s1 = stateWith([]);
    const s2 = reducer(s1, { type: 'DIARY_DELETE', date: '2026-10-24', now: NOW });
    expect(s2).toBe(s1);
  });
});

describe('HYDRATE 与全清', () => {
  it('带 diary 时整包替换', () => {
    const s1 = stateWith([entry('2026-10-20', '旧的')]);
    const s2 = reducer(s1, {
      type: 'HYDRATE',
      tasks: [],
      settings: s1.settings,
      diary: [entry('2026-10-25', '同步回来的')],
      storageError: null,
    });
    expect(s2.diary).toHaveLength(1);
    expect(s2.diary[0]?.content).toBe('同步回来的');
  });

  it('不带 diary 时**保留**现有日记（宁可不动，也不静默清空）', () => {
    const s1 = stateWith([entry('2026-10-20', '别把我清了')]);
    const s2 = reducer(s1, {
      type: 'HYDRATE',
      tasks: [],
      settings: s1.settings,
      storageError: null,
    });
    expect(s2.diary).toHaveLength(1);
    expect(s2.diary[0]?.content).toBe('别把我清了');
  });

  it('清空全部数据连日记一起清', () => {
    const s1 = stateWith([entry('2026-10-20', 'a'), entry('2026-10-21', 'b')]);
    const s2 = reducer(s1, { type: 'DATA_CLEAR_ALL' });
    expect(s2.diary).toEqual([]);
  });
});
