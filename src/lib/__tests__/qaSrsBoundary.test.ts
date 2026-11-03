import { describe, expect, it } from 'vitest';
import {
  buildReviewQueue,
  dueCount,
  enroll,
  grade,
  isCard,
  isDue,
  isNewCard,
  sanitizeSr,
} from '../srs';
import { NEW_CARD_DAILY_CAP } from '../../constants';
import { addDays } from '../date';
import type { Note, NoteSr } from '../../types';

/* ============================================================================
   QA 独立验证（v0.8 · F1）：SRS 引擎的边界与"可重放性"

   期望值**全部从设计口径独立推出**（新卡固定阶梯 / 老卡乘数 1.5、2.2 /
   上限 365 / 新卡 10 张限流 / 老卡不截断），不抄实现、不抄已有断言。
   ========================================================================= */

const TODAY = '2026-10-24';
const NOW = '2026-10-24T09:30:00.000Z';

function note(id: string, sr?: NoteSr, content = `${id} 正文`): Note {
  return {
    id,
    title: id,
    content,
    category: '',
    pinned: false,
    createdAt: '2026-10-20T08:00:00.000Z',
    updatedAt: '2026-10-20T08:00:00.000Z',
    ...(sr ? { sr } : {}),
  };
}

const card = (id: string, ivl: number, due = TODAY): Note => note(id, { due, ivl, reps: 1 });
const fresh = (id: string, enrolledOn = TODAY): Note => note(id, { due: enrolledOn, ivl: 0, reps: 0 });

describe('间隔算例（独立推导）', () => {
  it('新卡走固定阶梯 1 / 2 / 3，不受乘数影响', () => {
    const base = fresh('n1');
    expect(grade(base, 'again', TODAY, NOW).sr?.ivl).toBe(1);
    expect(grade(base, 'hard', TODAY, NOW).sr?.ivl).toBe(2);
    expect(grade(base, 'good', TODAY, NOW).sr?.ivl).toBe(3);
  });

  it('老卡：again 归 1；hard = round(ivl×1.5)；good = round(ivl×2.2)，均 ≥ 1', () => {
    const cases: [number, number, number, number][] = [
      [1, 1, 2, 2],
      [3, 1, 5, 7],
      [10, 1, 15, 22],
      [100, 1, 150, 220],
      [166, 1, 249, 365], // 166×2.2 = 365.2 → round 365（刚好不越界）
    ];
    for (const [prev, again, hard, good] of cases) {
      const next = (rating: 'again' | 'hard' | 'good') =>
        grade(card('c', prev), rating, TODAY, NOW).sr?.ivl;
      expect([next('again'), next('hard'), next('good')]).toEqual([again, hard, good]);
    }
  });

  it('上限 365：200 good → 365（440 被夹紧）、365 good → 365（803 被夹紧）', () => {
    expect(grade(card('c', 200), 'good', TODAY, NOW).sr?.ivl).toBe(365);
    expect(grade(card('c', 365), 'good', TODAY, NOW).sr?.ivl).toBe(365);
    expect(grade(card('c', 365), 'hard', TODAY, NOW).sr?.ivl).toBe(365);
  });

  it('due 一律 = today + ivl（用 addDays 独立算，跨年也一致）', () => {
    const yearEnd = '2026-12-30';
    const g = grade(card('c', 10, yearEnd), 'hard', yearEnd, NOW); // hard → 15
    expect(g.sr?.ivl).toBe(15);
    expect(g.sr?.due).toBe(addDays(yearEnd, 15));
    expect(g.sr?.due).toBe('2027-01-14');
  });
});

describe('到期计数与队列', () => {
  it(`11 张新卡 → ${NEW_CARD_DAILY_CAP}；3 逾期 + 11 新卡 → ${3 + NEW_CARD_DAILY_CAP}（老卡不截断）`, () => {
    const fresh11 = Array.from({ length: 11 }, (_, i) => fresh(`n${i}`));
    expect(dueCount(fresh11, TODAY)).toBe(NEW_CARD_DAILY_CAP);

    const overdue3 = Array.from({ length: 3 }, (_, i) => card(`o${i}`, 2, '2026-10-01'));
    expect(dueCount([...overdue3, ...fresh11], TODAY)).toBe(3 + NEW_CARD_DAILY_CAP);
  });

  it('新卡恒不 isDue（否则当天会同时算"新卡"与"逾期"，横幅翻倍）', () => {
    for (const due of ['2000-01-01', TODAY, '2099-01-01']) {
      expect(isDue(fresh('n1', due), TODAY)).toBe(false);
    }
  });

  it('enroll 之后：isNewCard 为真、isDue 为假（新卡当天不算"到期"）', () => {
    const enrolled = enroll(note('n1'), TODAY, NOW);
    expect(isNewCard(enrolled)).toBe(true);
    expect(isDue(enrolled, TODAY)).toBe(false);
    expect(dueCount([enrolled], TODAY)).toBe(1);
  });

  it('队列无重复 id；老卡按 due 升序在前，新卡在其后', () => {
    const notes = [
      fresh('n-late', '2026-10-24'),
      card('o3', 4, '2026-10-23'),
      card('o1', 4, '2026-08-01'),
      card('o2', 4, '2026-10-01'),
      card('future', 4, '2026-11-30'),
      fresh('n-early', '2026-10-21'),
    ];
    const ids = buildReviewQueue(notes, TODAY).map((n) => n.id);
    expect(ids.slice(0, 3)).toEqual(['o1', 'o2', 'o3']);
    expect(ids.slice(3)).toEqual(['n-early', 'n-late']);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain('future');
  });

  it('again 之后当天不再复现同一张（due = today + 1）', () => {
    const base = card('c1', 10);
    const next = grade(base, 'again', TODAY, NOW);
    expect(next.sr?.due).toBe(addDays(TODAY, 1));
    expect(buildReviewQueue([next], TODAY)).toEqual([]);
    expect(buildReviewQueue([next], addDays(TODAY, 1)).map((n) => n.id)).toEqual(['c1']);
  });
});

describe('脏数据：不抛 + 行为收敛', () => {
  it('sanitizeSr 对 1e9 / -5 / 非法日期 的收敛', () => {
    expect(sanitizeSr({ due: TODAY, ivl: 1e9, reps: 0 })).toStrictEqual({
      due: TODAY,
      ivl: 365,
      reps: 0,
    });
    expect(sanitizeSr({ due: TODAY, ivl: 1, reps: -5 })).toStrictEqual({
      due: TODAY,
      ivl: 1,
      reps: 0,
    });
    expect(sanitizeSr({ due: '2026-02-30', ivl: 1, reps: 1 })).toBeNull();
    expect(sanitizeSr({ due: TODAY, ivl: -1, reps: 1 })).toStrictEqual({
      due: TODAY,
      ivl: 0,
      reps: 1,
    });
  });

  it('due 在远古 / 未来：远古算逾期、未来不进队列，全部不抛', () => {
    const ancient = card('a', 5, '2000-01-01');
    const far = card('f', 5, '2099-01-01');
    expect(isDue(ancient, TODAY)).toBe(true);
    expect(isDue(far, TODAY)).toBe(false);
    expect(() => dueCount([ancient, far], TODAY)).not.toThrow();
    expect(buildReviewQueue([ancient, far], TODAY).map((n) => n.id)).toEqual(['a']);
  });

  it('ivl=1e9 / reps=-5 的脏 note：读时被夹紧成合法卡，评级不抛且结果落在合法区间', () => {
    const dirty = note('d', { due: TODAY, ivl: 1e9, reps: -5 });
    // 关键行为：脏值不是"丢掉整张卡"，而是夹紧 → 365 / 0，仍然是一张卡
    expect(isCard(dirty)).toBe(true);
    expect(isNewCard(dirty)).toBe(false);

    const next = grade(dirty, 'good', TODAY, NOW);
    // prev.ivl 被夹到 365 → good 803 → 夹回 365；reps 从 0 开始 +1
    expect(next.sr).toStrictEqual({ due: addDays(TODAY, 365), ivl: 365, reps: 1, last: NOW });
  });
});

describe('grade 的纯函数性质（可回放）', () => {
  it('同一 (note, rating, today, now) 两次调用结果完全一致，且不改入参', () => {
    const base = card('c1', 10);
    const snapshot = JSON.stringify(base);
    const a = grade(base, 'hard', TODAY, NOW);
    const b = grade(base, 'hard', TODAY, NOW);
    expect(a).toStrictEqual(b);
    expect(JSON.stringify(base)).toBe(snapshot);
  });

  it('连续两次评级（同一天）是可重放的确定性链条', () => {
    const base = fresh('n1');
    const first = grade(base, 'good', TODAY, NOW);
    const second = grade(first, 'good', TODAY, NOW);
    expect(first.sr).toStrictEqual({ due: '2026-10-27', ivl: 3, reps: 1, last: NOW });
    // 第二次：ivl 3 → good → 3×2.2 = 6.6 → 7
    expect(second.sr).toStrictEqual({ due: '2026-10-31', ivl: 7, reps: 2, last: NOW });
  });
});

/* ============================================================================
   队列冻结的必要性：用真实 buildReviewQueue 反证 useMemo 版本的翻车
   （ReviewView 里若写成 useMemo(() => buildReviewQueue(notes), [notes])，
     评级 → notes 变 → 队列重算 → 刚评的卡消失、后面的卡整体前移 → 少一张）
   ========================================================================= */
describe('反证：队列若跟着 notes 重算，会话会丢卡', () => {
  const a = card('A', 3);
  const b = card('B', 3);
  const c = card('C', 3);
  const notes = [a, b, c];

  it('冻结 id 列表：评 A 之后 current 仍然是 B（顺序不动、总数不变）', () => {
    const frozenIds = buildReviewQueue(notes, TODAY).map((n) => n.id);
    expect(frozenIds).toEqual(['A', 'B', 'C']);

    const rated = grade(a, 'again', TODAY, NOW); // due 推到明天
    const nextNotes = notes.map((n) => (n.id === 'A' ? rated : n));
    const cursor = 1;
    const total = frozenIds.length;
    const current = nextNotes.find((n) => n.id === frozenIds[cursor]);

    expect(total).toBe(3);
    expect(current?.id).toBe('B');
  });

  it('重算版本（反模式）：评 A 之后队列只剩 2 张，游标 1 已越界 → B 被跳过', () => {
    const rated = grade(a, 'again', TODAY, NOW);
    const nextNotes = notes.map((n) => (n.id === 'A' ? rated : n));
    const recomputed = buildReviewQueue(nextNotes, TODAY).map((n) => n.id);

    expect(recomputed).toEqual(['B', 'C']); // 队列长度变了…
    const cursor = 1; // 界面上早已 setCursor(prev + 1)
    expect(recomputed[cursor]).toBe('C'); // …current 从 B 直接跳到 C
    expect(recomputed.length - 1).toBe(1); // 进度 "2 / 2"，但用户只评过 1 张
  });
});
