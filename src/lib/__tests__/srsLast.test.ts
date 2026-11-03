import { describe, expect, it } from 'vitest';
import { grade, reviewCountInRange, sanitizeSr, reviewStats } from '../srs';
import { sanitizeNotes } from '../storage';
import { dateKey } from '../date';
import type { Note, NoteSr } from '../../types';

/* ============================================================================
   复习状态的第 4 个字段 `last`（最近一次评级的 ISO 时间）

   为什么需要它：周报要回答"本周复习了几张卡"，而 `due` / `ivl` 都是**未来**信息
   （下次什么时候再来），反推不出"上一次是哪天学的"。
   一张 30 天间隔的卡，昨天学还是 20 天前学，due 都落在同一天。

   三条最贵的行为：
   1. `grade` 必须把 `last` 写成 `now`（与 `updatedAt` 同值），否则统计永远是 0；
   2. `sanitizeSr` 对坏的 `last` **只丢 last** —— 不许因此丢 sr，更不许丢 note；
   3. `reviewCountInRange` 按**本地日期**归日（ISO 带时区也不能错一天）。
   ========================================================================= */

const TODAY = '2026-10-24';
const NOW = '2026-10-24T11:00:00.000Z';

function plain(id: string): Note {
  return {
    id,
    title: id,
    content: `${id} 正文`,
    category: '',
    pinned: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

function card(id: string, sr: NoteSr, content = `${id} 正文`): Note {
  return { ...plain(id), content, sr };
}

/** 用**本地时间**构造 ISO：正午构造 → 任何时区下本地日期都是这一天 */
function localIso(y: number, m: number, d: number, h = 12, min = 0): string {
  return new Date(y, m - 1, d, h, min, 0).toISOString();
}

describe('grade 写入 last', () => {
  it('last === now，且与 updatedAt 同值', () => {
    const next = grade(card('c1', { due: TODAY, ivl: 3, reps: 1 }), 'good', TODAY, NOW);
    expect(next.sr?.last).toBe(NOW);
    expect(next.sr?.last).toBe(next.updatedAt);
  });

  it('三档评级都会写 last（again 也算"复习过一次"）', () => {
    for (const rating of ['again', 'hard', 'good'] as const) {
      const next = grade(card('c1', { due: TODAY, ivl: 5, reps: 2 }), rating, TODAY, NOW);
      expect(next.sr?.last).toBe(NOW);
    }
  });

  it('评级不会改动入参（可回放）', () => {
    const src = card('c1', { due: TODAY, ivl: 3, reps: 1 });
    const snapshot = JSON.stringify(src);
    grade(src, 'good', TODAY, NOW);
    expect(JSON.stringify(src)).toBe(snapshot);
  });
});

describe('sanitizeSr：坏的 last 只丢 last', () => {
  const base = { due: TODAY, ivl: 3, reps: 2 };

  it('合法 last 原样保留', () => {
    const last = localIso(2026, 10, 23);
    expect(sanitizeSr({ ...base, last })).toEqual({ ...base, last });
  });

  it('last: 123（数字）→ sr 还在，只是没有 last', () => {
    const sr = sanitizeSr({ ...base, last: 123 });
    expect(sr).toEqual(base);
    expect(sr && 'last' in sr).toBe(false);
  });

  it("last: 'not-a-date' → sr 还在，只是没有 last", () => {
    const sr = sanitizeSr({ ...base, last: 'not-a-date' });
    expect(sr).toEqual(base);
    expect(sr && 'last' in sr).toBe(false);
  });

  it('last 缺失 → 不凭空造一个 last 键', () => {
    const sr = sanitizeSr(base);
    expect(sr && 'last' in sr).toBe(false);
  });

  it('sr 本体坏掉时仍然是"丢 sr"，而不是"丢 note"', () => {
    const note = card('n1', { due: '2026-02-30', ivl: 1, reps: 1 });
    const [kept] = sanitizeNotes([note]);
    expect(kept?.id).toBe('n1');
    expect(kept?.content).toBe('n1 正文');
    expect(kept && 'sr' in kept).toBe(false);
  });

  it('note 的 sr 有坏 last 时：note 与 sr 都活着，只有 last 被丢掉', () => {
    const dirty = { ...card('n1', base), sr: { ...base, last: 'garbage' } };
    const [kept] = sanitizeNotes([dirty]);
    expect(kept?.id).toBe('n1');
    expect(kept?.sr).toEqual(base);
    expect(kept?.sr && 'last' in (kept.sr as NoteSr)).toBe(false);
  });
});

describe('reviewCountInRange：区间统计', () => {
  const START = '2026-10-19';
  const END = '2026-10-25';

  it('区间内（含两端端点）都算', () => {
    const notes = [
      card('first', { due: TODAY, ivl: 3, reps: 1, last: localIso(2026, 10, 19) }), // 起点
      card('middle', { due: TODAY, ivl: 3, reps: 1, last: localIso(2026, 10, 22) }),
      card('last', { due: TODAY, ivl: 3, reps: 1, last: localIso(2026, 10, 25) }), // 终点
    ];
    expect(reviewCountInRange(notes, START, END)).toBe(3);
  });

  it('区间外一天都不算（前后各一天都排除）', () => {
    const notes = [
      card('before', { due: TODAY, ivl: 3, reps: 1, last: localIso(2026, 10, 18) }),
      card('after', { due: TODAY, ivl: 3, reps: 1, last: localIso(2026, 10, 26) }),
    ];
    expect(reviewCountInRange(notes, START, END)).toBe(0);
  });

  it('没有 last 的卡不计（老数据 / 刚入队没学过）', () => {
    const notes = [
      card('no-last', { due: TODAY, ivl: 0, reps: 0 }),
      card('has-last', { due: TODAY, ivl: 3, reps: 1, last: localIso(2026, 10, 21) }),
    ];
    expect(reviewCountInRange(notes, START, END)).toBe(1);
  });

  it('普通记事（没有 sr）不计', () => {
    expect(reviewCountInRange([plain('p1')], START, END)).toBe(0);
  });

  it('软删除的空壳不计（用户已经把它删了，不该算成复习过）', () => {
    const deleted = card('gone', { due: TODAY, ivl: 3, reps: 1, last: localIso(2026, 10, 21) }, '');
    expect(reviewCountInRange([deleted], START, END)).toBe(0);
  });

  it('同一张卡在一个区间里最多算 1 张（统计卡片数，不是评级次数）', () => {
    const notes = [card('c1', { due: TODAY, ivl: 3, reps: 9, last: localIso(2026, 10, 21) })];
    expect(reviewCountInRange(notes, START, END)).toBe(1);
  });

  it('跨午夜边界：按本地日期归日，不按 UTC', () => {
    // 本地 2026-10-25 23:50 → 本地日期仍是 10/25（含端点）；在 UTC 下可能是 10/26
    const lateNight = localIso(2026, 10, 25, 23, 50);
    expect(dateKey(new Date(lateNight))).toBe('2026-10-25');
    expect(reviewCountInRange([card('c1', { due: TODAY, ivl: 3, reps: 1, last: lateNight })], START, END)).toBe(1);
    // 同一个 ISO 串，放到"区间只到 10/24"的区间里就不该算
    expect(reviewCountInRange([card('c1', { due: TODAY, ivl: 3, reps: 1, last: lateNight })], START, '2026-10-24')).toBe(0);
  });

  it('刚过午夜：本地 00:10 的新一天算新的一天', () => {
    const justAfterMidnight = localIso(2026, 10, 26, 0, 10);
    expect(dateKey(new Date(justAfterMidnight))).toBe('2026-10-26');
    expect(reviewCountInRange([card('c1', { due: TODAY, ivl: 3, reps: 1, last: justAfterMidnight })], START, END)).toBe(0);
  });

  it('带显式时区偏移的 ISO 也能解析（按本地日期归日）', () => {
    const iso = '2026-10-21T08:00:00+08:00';
    const expectedKey = dateKey(new Date(iso));
    const inside = expectedKey >= START && expectedKey <= END;
    expect(reviewCountInRange([card('c1', { due: TODAY, ivl: 3, reps: 1, last: iso })], START, END)).toBe(
      inside ? 1 : 0,
    );
  });

  it('区间非法 / 反了 / 脏数据都不抛且返回 0', () => {
    const notes = [card('c1', { due: TODAY, ivl: 3, reps: 1, last: localIso(2026, 10, 21) })];
    expect(reviewCountInRange(notes, END, START)).toBe(0); // start > end
    expect(reviewCountInRange(notes, '2026-02-30', END)).toBe(0);
    expect(reviewCountInRange(notes, '', END)).toBe(0);
    expect(reviewCountInRange(null as unknown as Note[], START, END)).toBe(0);
  });

  it('ranges 互不重叠时总数可加（周报三档口径一致）', () => {
    const notes = [
      card('a', { due: TODAY, ivl: 3, reps: 1, last: localIso(2026, 10, 14) }),
      card('b', { due: TODAY, ivl: 3, reps: 1, last: localIso(2026, 10, 21) }),
    ];
    const prevWeek = reviewCountInRange(notes, '2026-10-12', '2026-10-18');
    const thisWeek = reviewCountInRange(notes, '2026-10-19', '2026-10-25');
    expect(prevWeek + thisWeek).toBe(2);
  });
});

describe('新字段不破坏队列健康度口径', () => {
  it('last 存在与否都不影响 total / scheduled / mature', () => {
    const withLast = card('a', { due: TODAY, ivl: 8, reps: 3, last: localIso(2026, 10, 21) });
    const withoutLast = card('b', { due: TODAY, ivl: 8, reps: 3 });
    expect(reviewStats([withLast])).toEqual({ total: 1, scheduled: 1, mature: 1 });
    expect(reviewStats([withoutLast])).toEqual({ total: 1, scheduled: 1, mature: 1 });
  });
});
