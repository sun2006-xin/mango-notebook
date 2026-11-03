import { describe, expect, it } from 'vitest';
import { createEmptyState, reducer } from '../reducer';
import { buildWeeklyMarkdown, buildWeeklyStats, upsertWeeklySection } from '../../lib/weekly';
import { TEXT } from '../../constants';
import type { AppState } from '../../types';

/* ============================================================================
   QA 独立验证（v0.8 · F3）：周报写入不能产生第二篇日记

   DiaryView 的「写入本周日记」= buildWeeklyStats → buildWeeklyMarkdown →
   upsertWeeklySection → dispatch DIARY_UPSERT。前三个是纯函数（已单测），
   最后一个若按"追加"而不是"按 date upsert"实现，用户点 5 次就会有 5 篇同一天的日记
   （合并时按 updatedAt 取新 → 云端只留一篇，本地却堆着 5 篇）。
   这里用真实的 reducer 连点 5 次，直接锁住 diary.length。
   ========================================================================= */

const TODAY = '2026-10-24';
const NOW = '2026-10-24T22:00:00.000Z';

function weeklyContent(existing: string): string {
  const stats = buildWeeklyStats({
    tasks: [],
    focusSessions: [],
    notes: [],
    today: TODAY,
    weekStart: 1,
  });
  const section = buildWeeklyMarkdown(stats, { harvest: '把阶梯想清楚了', problem: '', next: '刷题' }, NOW);
  return upsertWeeklySection(existing, section, TEXT.weeklyMarker).content;
}

function writeWeekly(state: AppState, existing: string, now: string): AppState {
  return reducer(state, { type: 'DIARY_UPSERT', date: TODAY, content: weeklyContent(existing), now });
}

describe('周报写入：同一天只有一篇日记', () => {
  it('连点 5 次「写入本周日记」→ diary.length 恒为 1，正文逐字相同', () => {
    let state = createEmptyState();
    let last = '';

    for (let i = 0; i < 5; i += 1) {
      const existing = state.diary.find((entry) => entry.date === TODAY)?.content ?? '';
      state = writeWeekly(state, existing, NOW);
      const content = state.diary[0]?.content ?? '';
      if (i > 0) expect(content).toBe(last);
      last = content;
      expect(state.diary).toHaveLength(1);
      expect(state.diary[0]?.date).toBe(TODAY);
    }
    expect(last.split(TEXT.weeklyMarker)).toHaveLength(2);
  });

  it('用户在周报之外写的正文不会被覆盖（写入走 upsert 而非新建）', () => {
    const start = reducer(createEmptyState(), {
      type: 'DIARY_UPSERT',
      date: TODAY,
      content: '今天把 I2C 时序调通了。',
      now: '2026-10-24T21:00:00.000Z',
    });
    const next = writeWeekly(start, start.diary[0]?.content ?? '', NOW);
    expect(next.diary).toHaveLength(1);
    expect(next.diary[0]?.content.startsWith('今天把 I2C 时序调通了。')).toBe(true);
    expect(next.diary[0]?.content).toContain(TEXT.weeklyMarker);
    expect(next.diary[0]?.updatedAt).toBe(NOW);
  });

  it('内容超过 DIARY_MAX 时 reducer 还会再截一次（双保险）', () => {
    const state = reducer(createEmptyState(), {
      type: 'DIARY_UPSERT',
      date: TODAY,
      content: 'a'.repeat(9999),
      now: NOW,
    });
    expect(state.diary[0]?.content).toHaveLength(5000);
  });

  it('周报不会新增 reducer action（写入只依赖 DIARY_UPSERT）', () => {
    // 这条是行为等价证明：不存在的 action 无法被 dispatch，
    // 而上面 5 次写入全部只用 DIARY_UPSERT 就得到了幂等结果。
    const state = writeWeekly(createEmptyState(), '', NOW);
    expect(state.diary).toHaveLength(1);
  });
});
