import { describe, expect, it } from 'vitest';
import {
  buildReviewQueue,
  dueCount,
  enroll,
  grade,
  isCard,
  isDue,
  isNewCard,
  reviewStats,
  sanitizeSr,
  unenroll,
} from '../srs';
import { NEW_CARD_DAILY_CAP, MATURE_INTERVAL_DAYS } from '../../constants';
import type { Note, NoteSr } from '../../types';

/* ============================================================================
   SRS 引擎的算例表 + 四条容易被改坏的语义

   算例表是**契约**：改乘数、改阶梯、改 clamp 都会让它变红。
   四条语义（新卡不用乘数 / again 不复现 / grade 刷 updatedAt / 软删除不进队列）
   每一条都对应一个真实会翻车的事故场景，注释里写清了。
   ========================================================================= */

const NOW = '2026-10-24T10:00:00.000Z';
const TODAY = '2026-10-24';

function note(id: string, sr?: NoteSr, content = `${id} 的正文`): Note {
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

/** 已排期的卡（ivl > 0） */
function scheduled(id: string, ivl: number, due = '2026-10-24'): Note {
  return note(id, { due, ivl, reps: 1 });
}

/** 新卡（ivl === 0） */
function fresh(id: string, enrolledOn = '2026-10-24'): Note {
  return note(id, { due: enrolledOn, ivl: 0, reps: 0 });
}

describe('grade：间隔算例表', () => {
  // [当前 ivl, again→, hard→, good→]
  const TABLE: [number, number, number, number][] = [
    [0, 1, 2, 3], // 新卡：固定阶梯，不是乘数
    [1, 1, 2, 2],
    [10, 1, 15, 22],
    [100, 1, 150, 220],
    [200, 1, 300, 365], // good 440 → clamp 365
    [365, 1, 365, 365], // hard 548 / good 803 → clamp 365
  ];

  for (const [prevIvl, again, hard, good] of TABLE) {
    it(`ivl=${prevIvl}：again→${again} / hard→${hard} / good→${good}`, () => {
      const base = note('c1', { due: TODAY, ivl: prevIvl, reps: 3 });
      expect(grade(base, 'again', TODAY, NOW).sr?.ivl).toBe(again);
      expect(grade(base, 'hard', TODAY, NOW).sr?.ivl).toBe(hard);
      expect(grade(base, 'good', TODAY, NOW).sr?.ivl).toBe(good);
    });
  }

  it('due = today + ivl（跨月也正确）', () => {
    const base = scheduled('c1', 10, '2026-10-24');
    expect(grade(base, 'hard', TODAY, NOW).sr?.due).toBe('2026-11-08');
    const endOfMonth = grade(note('c2', { due: '2026-10-31', ivl: 1, reps: 1 }), 'good', '2026-10-31', NOW);
    expect(endOfMonth.sr?.due).toBe('2026-11-02');
  });

  it('reps 每次 +1，again 也不重置', () => {
    const base = note('c1', { due: TODAY, ivl: 5, reps: 7 });
    expect(grade(base, 'again', TODAY, NOW).sr?.reps).toBe(8);
    expect(grade(base, 'good', TODAY, NOW).sr?.reps).toBe(8);
  });

  it('reps 有上限，脏数据撑不爆', () => {
    const base = note('c1', { due: TODAY, ivl: 5, reps: 9999 });
    expect(grade(base, 'good', TODAY, NOW).sr?.reps).toBe(9999);
  });

  /**
   * 这条守的是**云同步**：`sameNoteSet` 只比 `id + updatedAt`，对 sr 不可见。
   * 评级不刷 updatedAt → 云端永远判"两边一样"→ 复习进度永远传不到另一台设备，
   * 而且 mergeNotes 会拿对端的旧 sr 覆盖掉刚评的这张卡。
   */
  it('grade 必须把 updatedAt 写成 now（否则 sr 永远同步不到另一台设备）', () => {
    const base = note('c1', { due: TODAY, ivl: 3, reps: 1 });
    const next = grade(base, 'good', TODAY, NOW);
    expect(next.updatedAt).toBe(NOW);
    expect(next.updatedAt).not.toBe(base.updatedAt);
    // 不能就地改原对象（reducer 依赖不可变更新）
    expect(base.updatedAt).toBe('2026-10-20T08:00:00.000Z');
  });

  it('again → due = today + 1，所以同一次会话里不会复现（不需要 Anki learning steps）', () => {
    const base = scheduled('c1', 10, TODAY);
    const next = grade(base, 'again', TODAY, NOW);
    expect(next.sr?.ivl).toBe(1);
    expect(next.sr?.due).toBe('2026-10-25');
    // 评级后今天不再到期 → buildReviewQueue(今天) 里不会再出现它
    expect(isDue(next, TODAY)).toBe(false);
  });

  it('脏 note（没有 sr）也能被评级：按新卡处理', () => {
    const next = grade(note('plain'), 'good', TODAY, NOW);
    // v0.9 起 grade 会写入 last（最近一次评级的 ISO 时间），用于「本周复习 N 张」统计
    expect(next.sr).toEqual({ due: '2026-10-27', ivl: 3, reps: 1, last: NOW });
  });
});

describe('sanitizeSr：只认合法值', () => {
  it('合法值原样返回', () => {
    expect(sanitizeSr({ due: '2026-10-24', ivl: 3, reps: 2 })).toEqual({
      due: '2026-10-24',
      ivl: 3,
      reps: 2,
    });
  });

  it('日期不存在（2026-02-30）→ null', () => {
    expect(sanitizeSr({ due: '2026-02-30', ivl: 3, reps: 2 })).toBeNull();
    expect(sanitizeSr({ due: '2026-13-01', ivl: 3, reps: 2 })).toBeNull();
  });

  it('非对象 / 缺字段 / 非数字 → null，绝不抛', () => {
    for (const bad of [null, undefined, 'x', 42, [], true, {}, { due: '2026-10-24' }]) {
      expect(sanitizeSr(bad)).toBeNull();
    }
    expect(sanitizeSr({ due: '2026-10-24', ivl: NaN, reps: 1 })).toBeNull();
    expect(sanitizeSr({ due: '2026-10-24', ivl: Infinity, reps: 1 })).toBeNull();
  });

  it('越界值被夹紧（ivl 0..365 / reps 0..9999），小数截断', () => {
    expect(sanitizeSr({ due: '2026-10-24', ivl: 9999, reps: -3 })).toEqual({
      due: '2026-10-24',
      ivl: 365,
      reps: 0,
    });
    expect(sanitizeSr({ due: '2026-10-24', ivl: 2.7, reps: 1.9 })).toEqual({
      due: '2026-10-24',
      ivl: 2,
      reps: 1,
    });
  });
});

describe('卡片判定与队列', () => {
  it('没有 sr 的记事不是卡片，也不进队列', () => {
    expect(isCard(note('plain'))).toBe(false);
    expect(isNewCard(note('plain'))).toBe(false);
    expect(dueCount([note('plain')], TODAY)).toBe(0);
    expect(buildReviewQueue([note('plain')], TODAY)).toEqual([]);
  });

  it('软删除的空壳不算卡片（用户已经把它删了）', () => {
    const ghost = note('ghost', { due: TODAY, ivl: 3, reps: 1 }, '');
    expect(isCard(ghost)).toBe(false);
    expect(dueCount([ghost], TODAY)).toBe(0);
    expect(buildReviewQueue([ghost], TODAY)).toEqual([]);
  });

  it('isDue 不含新卡（否则新卡当天会被重复计数）', () => {
    expect(isDue(fresh('n1'), TODAY)).toBe(false);
    expect(isNewCard(fresh('n1'))).toBe(true);
    expect(dueCount([fresh('n1')], TODAY)).toBe(1);
  });

  it('老卡未到期不算 due；逾期算', () => {
    expect(isDue(scheduled('c1', 5, '2026-10-25'), TODAY)).toBe(false);
    expect(isDue(scheduled('c2', 5, '2026-10-20'), TODAY)).toBe(true);
    expect(isDue(scheduled('c3', 5, TODAY), TODAY)).toBe(true);
  });

  it(`dueCount：新卡上限 ${NEW_CARD_DAILY_CAP} 张，老卡逾期不截断`, () => {
    const fresh20 = Array.from({ length: 20 }, (_, i) => fresh(`n${i}`));
    expect(dueCount(fresh20, TODAY)).toBe(NEW_CARD_DAILY_CAP);

    const overdue30 = Array.from({ length: 30 }, (_, i) => scheduled(`o${i}`, 3, '2026-10-01'));
    expect(dueCount(overdue30, TODAY)).toBe(30); // 债务滚雪球的前提：不能截断

    expect(dueCount([...fresh20, ...overdue30], TODAY)).toBe(30 + NEW_CARD_DAILY_CAP);
  });

  it('buildReviewQueue：老卡按 due 升序在前，新卡在后且截断，无重复 id', () => {
    const notes = [
      fresh('n1', '2026-10-22'),
      scheduled('o-late', 4, '2026-10-23'),
      scheduled('o-early', 4, '2026-10-01'),
      scheduled('future', 4, '2026-12-01'), // 未到期，不该进队列
      note('plain'),
      ...Array.from({ length: 15 }, (_, i) => fresh(`nf${i}`, '2026-10-24')),
    ];
    const queue = buildReviewQueue(notes, TODAY);
    const ids = queue.map((n) => n.id);

    expect(ids.slice(0, 2)).toEqual(['o-early', 'o-late']);
    expect(ids).not.toContain('future');
    expect(ids).not.toContain('plain');
    expect(queue.filter((n) => isNewCard(n))).toHaveLength(NEW_CARD_DAILY_CAP);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('enroll / unenroll', () => {
  it('enroll 造新卡：ivl 0、due 今天、reps 0', () => {
    const next = enroll(note('n1'), TODAY, NOW);
    expect(next.sr).toEqual({ due: TODAY, ivl: 0, reps: 0 });
    expect(next.updatedAt).toBe(NOW);
    expect(isNewCard(next)).toBe(true);
  });

  it('已经是卡片时 enroll 是 no-op（同一个引用，不产生一次无用写盘）', () => {
    const card = scheduled('c1', 5);
    expect(enroll(card, TODAY, NOW)).toBe(card);
  });

  /**
   * 退出复习 = **删掉 sr 键**。
   * 写成 `sr: undefined` 时 `'sr' in note` 仍为 true，
   * 而"有没有 sr 键"就是"它是不是卡片"的判据 —— 等于没退出。
   */
  it('unenroll 删掉 sr 这个键（不是置 null/undefined）', () => {
    const card = scheduled('c1', 5);
    const off = unenroll(card, NOW);
    expect('sr' in off).toBe(false);
    expect(isCard(off)).toBe(false);
    expect(off.updatedAt).toBe(NOW);
    // 正文与其它字段一个都不能丢
    expect(off.content).toBe(card.content);
    expect(off.title).toBe(card.title);
  });
});

describe('reviewStats：队列健康度', () => {
  it('卡片数 / 已排期 / 成熟卡（ivl ≥ 7）', () => {
    const notes = [
      fresh('n1'),
      fresh('n2'),
      scheduled('s1', 1),
      scheduled('m1', MATURE_INTERVAL_DAYS),
      scheduled('m2', 30),
      note('plain'),
    ];
    expect(reviewStats(notes)).toEqual({ total: 5, scheduled: 3, mature: 2 });
  });

  it('空数组与脏数据不抛', () => {
    expect(reviewStats([])).toEqual({ total: 0, scheduled: 0, mature: 0 });
    expect(reviewStats(null as unknown as Note[])).toEqual({ total: 0, scheduled: 0, mature: 0 });
  });
});
