import { describe, expect, it } from 'vitest';
import { buildReviewQueue, countNewCardsLearnedToday } from '../srs';
import type { Note } from '../../types';

/* ============================================================================
   F9 修正：新卡额度是"每天总共几张"，不是"每次进几张"

   原实现每次进复习页都按上限放一批新卡 —— 进出三次就会看到三批，
   额度形同虚设。现在按 `sr.last`（归日）扣掉今天已学的新卡数。
   ========================================================================= */

const TODAY = '2026-10-29';

/** 一张"今天刚学完"的卡：ivl > 0（不再是新卡）、reps === 1（只评过一次） */
function learnedToday(id: string, at = `${TODAY}T10:00:00.000Z`): Note {
  return {
    id, title: id, content: '内容', category: '错题', pinned: false,
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: at,
    sr: { ivl: 3, due: '2026-11-01', ease: 2.5, reps: 1, lapses: 0, last: at },
  } as Note;
}

function freshCard(id: string): Note {
  return {
    id, title: id, content: '内容', category: '错题', pinned: false,
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    sr: { ivl: 0, due: TODAY, ease: 2.5, reps: 0, lapses: 0 },
  } as Note;
}

function matureDue(id: string): Note {
  return {
    id, title: id, content: '内容', category: '错题', pinned: false,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z',
    sr: { ivl: 10, due: '2026-10-28', ease: 2.5, reps: 4, lapses: 0, last: '2026-10-20T00:00:00.000Z' },
  } as Note;
}

describe('countNewCardsLearnedToday', () => {
  it('只数"今天学过的、只评过一次的"卡', () => {
    const notes = [
      learnedToday('a'),
      learnedToday('b'),
      matureDue('c'), // reps=4，是复习不是学新卡
      freshCard('d'), // ivl=0，还没学
      learnedToday('e', '2026-10-28T10:00:00.000Z'), // 昨天学的
    ];
    expect(countNewCardsLearnedToday(notes, TODAY)).toBe(2);
  });

  it('日界 4 点时，凌晨 1 点学的卡算"昨天"', () => {
    // 本地时间 2026-10-29 01:00 学完 → 日界 4 点下属于 10-28
    const at = new Date(2026, 9, 29, 1, 0).toISOString();
    const notes = [learnedToday('a', at)];
    expect(countNewCardsLearnedToday(notes, TODAY, 0)).toBe(1); // 日界 0：算今天
    expect(countNewCardsLearnedToday(notes, '2026-10-28', 4)).toBe(1); // 日界 4：算昨天
    expect(countNewCardsLearnedToday(notes, TODAY, 4)).toBe(0);
  });

  it('脏数据不抛（缺 sr / last 非法）', () => {
    expect(countNewCardsLearnedToday(null as unknown as Note[], TODAY)).toBe(0);
    expect(countNewCardsLearnedToday([{ id: 'x' } as Note], TODAY)).toBe(0);
  });
});

describe('buildReviewQueue：按剩余额度放新卡', () => {
  it('上限 3 且今天已学 2 张 → 只再放 1 张新卡', () => {
    const notes = [
      learnedToday('l1'),
      learnedToday('l2'),
      freshCard('f1'),
      freshCard('f2'),
      freshCard('f3'),
    ];
    const queue = buildReviewQueue(notes, TODAY, 3);
    const newOnes = queue.filter((note) => note.id.startsWith('f'));
    expect(newOnes).toHaveLength(1);
  });

  it('额度用尽 → 一张新卡都不放，但老卡照常放（逾期优先）', () => {
    const notes = [learnedToday('l1'), learnedToday('l2'), freshCard('f1'), matureDue('m1')];
    const queue = buildReviewQueue(notes, TODAY, 2);
    expect(queue.map((note) => note.id)).toEqual(['m1']);
  });

  it('上限 0 = 不限制，完全不扣额度', () => {
    // 已学完的卡（ivl>0 且未到期）本来就不进队列，所以这里只剩两张新卡
    const notes = [learnedToday('l1'), learnedToday('l2'), freshCard('f1'), freshCard('f2')];
    const queue = buildReviewQueue(notes, TODAY, 0);
    expect(queue.map((note) => note.id)).toEqual(['f1', 'f2']);
  });

  it('进出复习页多次，看到的新卡数量一致（这就是本次修复的核心）', () => {
    const notes = [learnedToday('l1'), freshCard('f1'), freshCard('f2'), freshCard('f3')];
    const first = buildReviewQueue(notes, TODAY, 3).map((note) => note.id);
    const second = buildReviewQueue(notes, TODAY, 3).map((note) => note.id);
    expect(second).toEqual(first);
    expect(first.filter((id) => id.startsWith('f'))).toHaveLength(2); // 3 - 已学 1
  });
});
