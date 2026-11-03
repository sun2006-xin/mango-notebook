import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { AUTO_ENROLL_ON_CREATE } from '../../constants';
import {
  MISTAKE_CARET_ANCHOR,
  MISTAKE_CATEGORY,
  MISTAKE_TEMPLATE,
  createBlankNote,
  createMistakeNote,
  mistakeCaretIndex,
} from '../noteTemplate';
import { isCard, isNewCard } from '../srs';
import { isNoteDeleted } from '../note';
import { reducer, createEmptyState } from '../../store/reducer';

/* ============================================================================
   F3 · 错题笔记模板

   一次点击要把三件事同时做到，缺一个"记错题"就退化成"记了但不背"：
   ① 预填四个小标题（题目 / 我错在哪 / 正确思路 / 知识点）；
   ② `category === '错题'`（用字符串，**不静默新增分类**）；
   ③ **自动加入复习**：`sr = { due: today, ivl: 0, reps: 0 }`（走 srs.enroll）。

   同时必须保住旧语义：**普通「新建」仍然不入队**
   （`AUTO_ENROLL_ON_CREATE === false`，且 `createBlankNote` 上不能有 sr 键）。
   ========================================================================= */

const NOW = '2026-10-24T10:00:00.000Z';
const TODAY = '2026-10-24';

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '');
}

describe('错题模板正文', () => {
  it('四个小标题齐全且顺序固定（抄题 → 诊断 → 正解 → 知识点）', () => {
    const headings = MISTAKE_TEMPLATE.split('\n').filter((line) => line.startsWith('## '));
    expect(headings).toEqual(['## 题目', '## 我错在哪', '## 正确思路', '## 知识点']);
  });

  it('标题之间留空行（Markdown 渲染才不会粘成一坨）', () => {
    expect(MISTAKE_TEMPLATE).toContain('## 题目\n\n## 我错在哪');
  });

  it('光标锚点就在「## 题目」之后', () => {
    const caret = mistakeCaretIndex();
    expect(caret).toBe(MISTAKE_CARET_ANCHOR.length);
    expect(MISTAKE_TEMPLATE.slice(0, caret)).toBe(MISTAKE_CARET_ANCHOR);
  });

  it('内容被替换过（找不到锚点）时退回 0，绝不返回 -1', () => {
    expect(mistakeCaretIndex('没有小标题的正文')).toBe(0);
    expect(mistakeCaretIndex('')).toBe(0);
  });
});

describe('createMistakeNote：模板 + 分类 + 自动入队', () => {
  const note = createMistakeNote('n1', NOW, TODAY);

  it('预填内容正确', () => {
    expect(note.content).toBe(MISTAKE_TEMPLATE);
    expect(note.title).toBe('错题');
    expect(note.id).toBe('n1');
    expect(note.createdAt).toBe(NOW);
    expect(note.updatedAt).toBe(NOW);
  });

  it("category === '错题'（不往 settings.categories 里静默新增）", () => {
    expect(note.category).toBe(MISTAKE_CATEGORY);
    expect(note.category).toBe('错题');
  });

  it('已入队：sr 存在且 ivl === 0（新卡语义），due 就是今天', () => {
    expect(note.sr).toEqual({ due: TODAY, ivl: 0, reps: 0 });
    expect(isCard(note)).toBe(true);
    expect(isNewCard(note)).toBe(true);
  });

  it('不是"已删除空壳"（content 非空）', () => {
    expect(isNoteDeleted(note)).toBe(false);
  });

  it('经过 NOTE_UPSERT 后 sr 与 createdAt 都保真（走既有 action，没有新 action）', () => {
    const state = reducer(createEmptyState(), { type: 'NOTE_UPSERT', note, now: NOW });
    const stored = state.notes.find((item) => item.id === 'n1');
    expect(stored?.sr).toEqual({ due: TODAY, ivl: 0, reps: 0 });
    expect(stored?.category).toBe('错题');
    expect(stored?.createdAt).toBe(NOW);
  });
});

describe('普通「新建」不受影响：仍然默认不入队', () => {
  it('AUTO_ENROLL_ON_CREATE 仍是 false（这个常量的语义不该被本轮改掉）', () => {
    expect(AUTO_ENROLL_ON_CREATE).toBe(false);
  });

  it('createBlankNote 上没有 sr 键（不是 sr: undefined，是根本没有这个键）', () => {
    const blank = createBlankNote('n2', NOW);
    expect('sr' in blank).toBe(false);
    expect(isCard(blank)).toBe(false);
    expect(blank.title).toBe('');
    expect(blank.content).toBe('');
  });
});

describe('视图接线（source contract）：按钮在，且走同一个 NOTE_UPSERT', () => {
  const viewSrc = stripComments(readFileSync(new URL('../../views/NotesView.tsx', import.meta.url), 'utf8'));

  it('「记错题」按钮与「新建」并列，有稳定的 testid', () => {
    expect(viewSrc).toContain('data-testid="note-create-mistake"');
    expect(viewSrc).toContain('{TEXT.noteMistake}');
    // 原来的「新建」入口一字未改
    expect(viewSrc).toContain('data-testid="note-create"');
  });

  it('点击后创建模板笔记，并走 NOTE_UPSERT（没有专属 action）', () => {
    expect(viewSrc).toContain('const createMistake = useCallback(');
    expect(viewSrc).toContain('createMistakeNote(crypto.randomUUID(), now, today)');
    expect(viewSrc).toContain("dispatch({ type: 'NOTE_UPSERT', note: created, now })");
    expect(viewSrc).not.toContain('NOTE_MISTAKE');
  });

  it('光标落在「## 题目」之后（setSelectionRange 用的是 mistakeCaretIndex）', () => {
    expect(viewSrc).toContain('editor.setSelectionRange(caret, caret)');
    expect(viewSrc).toContain('mistakeCaretIndex(created.content)');
  });

  it('分类「错题」不在清单内时不静默新增分类（视图侧也不 dispatch CATEGORY_ADD）', () => {
    expect(viewSrc).not.toContain('CATEGORY_ADD');
  });
});
