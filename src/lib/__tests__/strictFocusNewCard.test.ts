import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../../constants';
import { sanitizeSettings } from '../storage';
import { buildReviewQueue } from '../srs';
import { reducer } from '../../store/reducer';
import type { AppState, Note } from '../../types';

/* ============================================================================
   F6 严格模式 + F9 每日新卡上限

   这两个字段都是 v0.12 新加的 settings 字段，所以最要紧的一条不是"功能能用"，
   而是**它们能活过冷启动 / 云同步 / 导入备份**：
   `sanitizeSettings` 是逐字段重建（不是 `...rec` 展开），漏一行就每次静默清零。
   ========================================================================= */

function stateWith(settings: Partial<AppState['settings']>): AppState {
  return {
    tasks: [],
    notes: [],
    diary: [],
    tombstones: [],
    focusSessions: [],
    settings: { ...createDefaultSettings('2026-10-29'), ...settings },
    ui: {
      drawerTaskId: null,
      drawerReturnFocusId: null,
      monthCursor: { year: 2026, month: 9 },
      toast: null,
      stickyDoneIds: [],
      saveState: 'idle',
      storageError: null,
      hydrating: false,
    } as unknown as AppState['ui'],
  } as AppState;
}

describe('sanitizeSettings：新字段必须活下来', () => {
  it('strictFocus / dailyNewCardLimit 原样保留', () => {
    const out = sanitizeSettings({ strictFocus: true, dailyNewCardLimit: 35 });
    expect(out.strictFocus).toBe(true);
    expect(out.dailyNewCardLimit).toBe(35);
  });

  it('缺字段时回落默认值（老载荷不需要迁移）', () => {
    const out = sanitizeSettings({});
    expect(out.strictFocus).toBe(false);
    expect(out.dailyNewCardLimit).toBe(20);
  });

  it('新卡上限夹紧到 0–200（云同步可能带来脏数据）', () => {
    expect(sanitizeSettings({ dailyNewCardLimit: 99999 }).dailyNewCardLimit).toBe(200);
    expect(sanitizeSettings({ dailyNewCardLimit: -5 }).dailyNewCardLimit).toBe(0);
    expect(sanitizeSettings({ dailyNewCardLimit: 'abc' }).dailyNewCardLimit).toBe(20);
  });
});

describe('reducer：两个设置 action', () => {
  it('SET_STRICT_FOCUS 切换，且同值幂等（返回同一个 state，不白写一次盘）', () => {
    const s0 = stateWith({ strictFocus: false });
    const s1 = reducer(s0, { type: 'SET_STRICT_FOCUS', value: true });
    expect(s1.settings.strictFocus).toBe(true);
    expect(reducer(s1, { type: 'SET_STRICT_FOCUS', value: true })).toBe(s1);
  });

  it('SET_DAILY_NEW_CARD_LIMIT 夹紧 0–200 并保持幂等', () => {
    const s0 = stateWith({ dailyNewCardLimit: 20 });
    const s1 = reducer(s0, { type: 'SET_DAILY_NEW_CARD_LIMIT', value: 9999 });
    expect(s1.settings.dailyNewCardLimit).toBe(200);
    expect(reducer(s1, { type: 'SET_DAILY_NEW_CARD_LIMIT', value: 9999 })).toBe(s1);
  });
});

function card(id: string, due: string, ivl: number): Note {
  return {
    id,
    title: id,
    content: '内容',
    category: '错题',
    pinned: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    sr: { ivl, due, ease: 2.5, reps: 1, lapses: 0 },
  } as Note;
}

describe('buildReviewQueue：新卡上限可配（Anki 经验）', () => {
  const TODAY = '2026-10-29';
  const notes = [
    card('due1', '2026-10-28', 5),
    card('due2', '2026-10-27', 5),
    card('new1', TODAY, 0),
    card('new2', TODAY, 0),
    card('new3', TODAY, 0),
  ];

  it('不传上限 → 用内置默认（20），本次只会全放进来', () => {
    expect(buildReviewQueue(notes, TODAY)).toHaveLength(5);
  });

  it('上限 2 → 到期卡全放，新卡只放 2 张', () => {
    const queue = buildReviewQueue(notes, TODAY, 2);
    expect(queue.map((n) => n.id)).toEqual(['due2', 'due1', 'new1', 'new2']);
  });

  it('上限 0 → 不限制（用户明确选了「不限」）', () => {
    expect(buildReviewQueue(notes, TODAY, 0)).toHaveLength(5);
  });
});
