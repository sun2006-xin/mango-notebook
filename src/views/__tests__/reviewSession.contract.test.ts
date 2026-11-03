import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { reducer, createEmptyState } from '../../store/reducer';
import { buildReviewQueue, dueCount, grade } from '../../lib/srs';
import type { Note } from '../../types';

/* ============================================================================
   F1 复习会话的四条契约

   本环境渲染不了 React（项目没有 @testing-library），所以采用项目里既有的
   「源码级契约扫描 + 纯函数行为」两路并进：
   - 扫描**先剥掉注释**再断言（本项目已被注释误伤过两次）；
   - 行为用真实 lib/srs + reducer 证明，不靠读源码猜。

   四条契约对应四个真实会翻车的场景：
   ① dueCount=0 时不渲染横幅（常驻「待复习 0 张」= 噪音）
   ② 评级按钮必须在「显示答案」之后（先看题再评，否则等于乱按）
   ③ 评级必须刷 updatedAt（否则 sr 永远同步不到另一台设备）
   ④ 队列必须冻结 id（否则评完一张，界面上的卡会"自己跳走"）
   ========================================================================= */

const TODAY = '2026-10-24';
const NOW = '2026-10-24T10:00:00.000Z';

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '');
}

function readTodayView(): string {
  return stripComments(readFileSync(new URL('../TodayView.tsx', import.meta.url), 'utf8'));
}

function readReviewView(): string {
  return stripComments(readFileSync(new URL('../ReviewView.tsx', import.meta.url), 'utf8'));
}

const note = (id: string, sr?: Note['sr']): Note => ({
  id,
  title: id,
  content: `${id} 的正文`,
  category: '',
  pinned: false,
  createdAt: '2026-10-20T08:00:00.000Z',
  updatedAt: '2026-10-20T08:00:00.000Z',
  ...(sr ? { sr } : {}),
});

describe('① 今日横幅：只在真有卡要复习时出现', () => {
  it('TodayView 的横幅以 dueCount > 0 为条件', () => {
    const src = readTodayView();
    /**
     * v0.20 起 `dueCount(notes, today)` 只算一次并存进 `dueReview`，
     * 横幅判断改成 `dueReview > 0` —— 原来同一个调用写了两遍（一次给文案、
     * 一次给条件）。守卫要钉的是"条件来自 dueCount 而不是写死的数字"，
     * 所以两处都断言：先有取值，再有判断。
     */
    expect(src).toContain('const dueReview = dueCount(notes, today)');
    expect(src).toContain('{dueReview > 0 ? (');
    expect(src).toContain('data-testid="review-banner"');
    expect(src).toContain("dispatch({ type: 'SET_VIEW', view: 'review' })");
  });

  it('没有卡片时 dueCount 为 0 → 横幅条件不成立', () => {
    expect(dueCount([], TODAY)).toBe(0);
    expect(dueCount([note('plain')], TODAY)).toBe(0);
    // 已删除的空壳也不算
    expect(dueCount([{ ...note('ghost', { due: TODAY, ivl: 3, reps: 1 }), content: '' }], TODAY)).toBe(0);
  });

  it('有到期卡片时 dueCount > 0 → 横幅渲染', () => {
    expect(dueCount([note('c1', { due: TODAY, ivl: 3, reps: 1 })], TODAY)).toBe(1);
    expect(dueCount([note('n1', { due: TODAY, ivl: 0, reps: 0 })], TODAY)).toBe(1);
  });
});

describe('② 先「显示答案」，再出评级按钮', () => {
  /**
   * 结构是 `{revealed ? (答案 + 三个评级按钮) : (「显示答案」按钮)}`，
   * 所以评级按钮在**源码里**排在「显示答案」之前，但它们在**渲染上**属于
   * revealed 的真分支 —— 未揭示时根本不在 DOM 里（条件渲染，不是 CSS 隐藏）。
   * 断言按这个结构来，而不是按源码行号先后。
   */
  it('三个评级按钮与答案区都落在 revealed 的真分支内', () => {
    const src = readReviewView();
    const gate = src.indexOf('{revealed ? (');
    expect(gate).toBeGreaterThan(-1);
    const elseIdx = src.indexOf(') : (', gate);
    expect(elseIdx).toBeGreaterThan(gate);

    for (const id of ['review-answer', 'review-rate-again', 'review-rate-hard', 'review-rate-good']) {
      const idx = src.indexOf(`data-testid="${id}"`);
      expect(idx).toBeGreaterThan(gate);
      expect(idx).toBeLessThan(elseIdx); // 在真分支里 → 未揭示时不渲染
    }
  });

  it('「显示答案」在假分支里', () => {
    const src = readReviewView();
    const gate = src.indexOf('{revealed ? (');
    const elseIdx = src.indexOf(') : (', gate);
    expect(src.indexOf('data-testid="review-show-answer"')).toBeGreaterThan(elseIdx);
  });
});

describe('③ 评级后 now 必须等于 note.updatedAt', () => {
  it('ReviewView 用 grade 写出的 updatedAt 作为 now', () => {
    const src = readReviewView();
    expect(src).toContain('now: next.updatedAt');
    expect(src).toContain("dispatch({ type: 'NOTE_UPSERT'");
  });

  it('行为：grade 的 updatedAt 就是传入的 now，reducer 也照此落库', () => {
    const card = note('c1', { due: TODAY, ivl: 3, reps: 1 });
    const next = grade(card, 'good', TODAY, NOW);
    expect(next.updatedAt).toBe(NOW);

    const state = reducer(createEmptyState(), {
      type: 'NOTE_UPSERT',
      note: next,
      now: next.updatedAt,
    });
    expect(state.notes[0]?.updatedAt).toBe(NOW);
    expect(state.notes[0]?.sr?.ivl).toBe(7); // 3 × 2.2 ≈ 7
  });
});

describe('④ 评级后当前卡不能"自己跳走"', () => {
  it('ReviewView 冻结 queueIds（useState 惰性初始化），不是 useMemo 重算', () => {
    const src = readReviewView();
    expect(src).toContain('useState<string[]>(() =>');
    expect(src).toContain('queueIds[cursor]');
    // 反向断言：绝不允许按 notes 重算队列
    expect(src).not.toContain('useMemo(() => buildReviewQueue');
  });

  it('行为：冻结的队列在评级后保持原顺序与原长度', () => {
    const notes = [
      note('b', { due: '2026-10-20', ivl: 3, reps: 1 }), // 逾期老卡，排第一
      note('a', { due: TODAY, ivl: 0, reps: 0 }), // 新卡，排第二
    ];
    const ids = buildReviewQueue(notes, TODAY).map((n) => n.id);
    expect(ids).toEqual(['b', 'a']);

    const graded = grade(notes[0] as Note, 'good', TODAY, NOW);
    const after = notes.map((n) => (n.id === graded.id ? graded : n));

    // 冻结的 id 列表：游标 +1 后指向的仍是第二张，不是我刚评完又原地不动
    expect(ids[1]).toBe('a');
    expect(ids).toHaveLength(2);

    // 反证：如果按新 notes 重算，刚评完那张已经不在队列里（这就是"卡片跳走"的成因）
    expect(buildReviewQueue(after, TODAY).map((n) => n.id)).toEqual(['a']);
  });
});
