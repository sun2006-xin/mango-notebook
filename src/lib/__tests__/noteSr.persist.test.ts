import { describe, expect, it } from 'vitest';
import { migrate, sanitizeNotes } from '../storage';
import { SCHEMA_VERSION } from '../../constants';
import type { Note } from '../../types';

/* ============================================================================
   Note.sr（复习进度）的持久化边界

   这是 F1 全部改动里唯一的高危点：`sanitizeNotes` 是**字面量逐字段重建**的。
   如果为了带上 sr 而写成 `sr`（简写）或 `sr: sr ?? undefined`，会有两种事故：

   ① `sr` 简写 —— sr 为 null 时给 note 挂上一个 `sr: null` 的键。
      "有没有 sr 键" = "它是不是复习卡片"，凭空多出一个键会让一条普通记事
      被当成「已退出复习的卡片」或「新卡」，语义彻底坏掉。
   ② 更严重的是另一头：为了让类型过审，有人会加一句
      `if (!validSr) continue;`（把坏 sr 的整条 note 丢掉）——
      复习进度可以重建，**笔记正文不能重建**。丢一条 note = 丢用户写的东西。

   所以本文件守两件事：
   - 坏 sr：只丢 sr，note 的七个字段一个不能少；
   - 无 sr：note 上**不允许存在** sr 这个键（这是"退出复习"的唯一表达方式）。
   ========================================================================= */

const BASE = {
  id: 'n1',
  title: '单调栈模板',
  content: '遇到更小的就弹栈……',
  category: 'c_learn',
  pinned: false,
  createdAt: '2026-10-20T08:00:00.000Z',
  updatedAt: '2026-10-21T08:00:00.000Z',
};

function only(raw: Record<string, unknown>): Note {
  const list = sanitizeNotes([raw]);
  expect(list).toHaveLength(1);
  return list[0] as Note;
}

describe('sanitizeNotes：坏 sr 只丢 sr，绝不丢 note', () => {
  it('due 是非法日期（2026-02-30）→ note 保留、sr 被丢', () => {
    const note = only({ ...BASE, sr: { due: '2026-02-30', ivl: 3, reps: 2 } });
    expect(note.content).toBe('遇到更小的就弹栈……');
    expect(note.title).toBe('单调栈模板');
    expect(note.category).toBe('c_learn');
    expect('sr' in note).toBe(false);
  });

  it('sr 是垃圾（字符串 / 数组 / null）→ note 保留、sr 被丢', () => {
    for (const bad of ['2026-10-24', 42, [], null, true]) {
      const note = only({ ...BASE, sr: bad });
      expect(note.id).toBe('n1');
      expect('sr' in note).toBe(false);
    }
  });

  it('ivl / reps 不是数字 → note 保留、sr 被丢', () => {
    const note = only({ ...BASE, sr: { due: '2026-10-24', ivl: 'abc', reps: 2 } });
    expect(note.id).toBe('n1');
    expect('sr' in note).toBe(false);
  });

  it('合法 sr 原样保留（越界值被夹紧）', () => {
    const ok = only({ ...BASE, sr: { due: '2026-10-24', ivl: 6, reps: 3 } });
    expect(ok.sr).toEqual({ due: '2026-10-24', ivl: 6, reps: 3 });

    const clamped = only({ ...BASE, sr: { due: '2026-10-24', ivl: 9999, reps: -5 } });
    expect(clamped.sr).toEqual({ due: '2026-10-24', ivl: 365, reps: 0 });
  });

  it('没有 sr 字段的 note，结果里不允许出现 sr 键（"退出复习"的唯一表达）', () => {
    const note = only({ ...BASE });
    expect('sr' in note).toBe(false);
    expect(Object.keys(note).sort()).toEqual([
      'category',
      'content',
      'createdAt',
      'id',
      'pinned',
      'title',
      'updatedAt',
    ]);
  });

  it('坏 sr 的那条 note 在 migrate 全链路上也活着（不是只在 sanitizeNotes 单测里活着）', () => {
    const payload = migrate({
      schemaVersion: SCHEMA_VERSION,
      savedAt: '2026-10-24T10:00:00.000Z',
      tasks: [],
      notes: [{ ...BASE, sr: { due: 'nope', ivl: 1, reps: 1 } }],
    });
    expect(payload?.notes).toHaveLength(1);
    expect(payload?.notes[0]?.title).toBe('单调栈模板');
    expect(payload?.notes[0] && 'sr' in payload.notes[0]).toBe(false);
  });
});
