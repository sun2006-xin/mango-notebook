import { describe, expect, it } from 'vitest';
import { countHits, searchAll } from '../search';
import type { DiaryEntry, Note, Task } from '../../types';

/* ============================================================================
   全文搜索：任务标题/备注 + 日记正文 + 记事本标题/正文
   ========================================================================= */

function task(id: string, title: string, note = ''): Task {
  return {
    id,
    title,
    note,
    date: '2026-10-24',
    time: null,
    repeat: 'none',
    priority: 'medium',
    category: '学习',
    done: false,
    doneAt: null,
    createdAt: 'x',
    updatedAt: 'x',
    parentId: null,
    estimatedMinutes: 0,
  };
}

function entry(date: string, content: string): DiaryEntry {
  return { date, content, createdAt: 'x', updatedAt: 'x' };
}

function note(id: string, title: string, content: string): Note {
  return {
    id,
    title,
    content,
    category: '',
    pinned: false,
    createdAt: 'x',
    updatedAt: '2026-10-24T08:00:00.000Z',
  };
}

const TASKS = [task('a', '背单词', '考研核心词 List1'), task('b', '跑步 3 公里'), task('c', '买牛奶')];
const DIARY = [entry('2026-10-24', '今天做了数学真题，错了两道'), entry('2026-10-25', '天气不错')];
const NOTES = [note('n1', '快捷键大全', 'Ctrl+K 打开搜索'), note('n2', '报错记录', '白屏是因为 CORS')];

describe('searchAll', () => {
  it('空 query → 三个空数组', () => {
    expect(searchAll('', TASKS, DIARY, NOTES)).toEqual({ tasks: [], diary: [], notes: [] });
    expect(searchAll('   ', TASKS, DIARY, NOTES)).toEqual({ tasks: [], diary: [], notes: [] });
  });

  it('命中任务标题', () => {
    const r = searchAll('牛奶', TASKS, DIARY, NOTES);
    expect(r.tasks.map((t) => t.id)).toEqual(['c']);
  });

  it('命中任务备注（不只标题）', () => {
    const r = searchAll('List1', TASKS, DIARY, NOTES);
    expect(r.tasks.map((t) => t.id)).toEqual(['a']);
  });

  it('大小写不敏感', () => {
    const r = searchAll('list1', TASKS, DIARY, NOTES);
    expect(r.tasks.map((t) => t.id)).toEqual(['a']);
  });

  it('命中日记正文', () => {
    const r = searchAll('数学', TASKS, DIARY, NOTES);
    expect(r.tasks).toHaveLength(0);
    expect(r.diary.map((e) => e.date)).toEqual(['2026-10-24']);
  });

  it('同一个词任务和日记都能命中', () => {
    const r = searchAll('今天', TASKS, DIARY, NOTES);
    expect(countHits(r)).toBe(1); // 只有日记里出现"今天"
    const r2 = searchAll('天气', TASKS, DIARY, NOTES);
    expect(countHits(r2)).toBe(1);
  });

  it('空正文的墓碑日记不算命中', () => {
    const r = searchAll('a', TASKS, [entry('2026-10-24', '')], NOTES);
    expect(r.diary).toHaveLength(0);
  });

  it('没命中时返回空，不抛异常', () => {
    const r = searchAll('不存在的词', TASKS, DIARY, NOTES);
    expect(r.tasks).toEqual([]);
    expect(r.diary).toEqual([]);
    expect(r.notes).toEqual([]);
  });

  it('脏数据兜底（tasks / diary / notes 不是数组）', () => {
    expect(() => searchAll('x', undefined as unknown as Task[], DIARY, NOTES)).not.toThrow();
    expect(searchAll('x', undefined as unknown as Task[], DIARY, NOTES).tasks).toEqual([]);
    expect(searchAll('x', TASKS, undefined as unknown as DiaryEntry[], NOTES).diary).toEqual([]);
    expect(searchAll('x', TASKS, DIARY, undefined as unknown as Note[]).notes).toEqual([]);
  });

  it('countHits 合计三类结果', () => {
    expect(countHits(searchAll('今天', TASKS, DIARY, NOTES))).toBe(1);
    expect(countHits(searchAll('', TASKS, DIARY, NOTES))).toBe(0);
  });

  it('notes 默认 [] 时三参调用仍可用（向后兼容）', () => {
    const r = searchAll('牛奶', TASKS, DIARY);
    expect(r.tasks.map((t) => t.id)).toEqual(['c']);
    expect(r.notes).toEqual([]);
  });
});

describe('searchAll · 记事本', () => {
  it('命中记事标题', () => {
    const r = searchAll('快捷键', TASKS, DIARY, NOTES);
    expect(r.notes.map((n) => n.id)).toEqual(['n1']);
  });

  it('命中记事正文', () => {
    const r = searchAll('CORS', TASKS, DIARY, NOTES);
    expect(r.notes.map((n) => n.id)).toEqual(['n2']);
  });

  it('记事命中不影响任务/日记分区计数', () => {
    const r = searchAll('CORS', TASKS, DIARY, NOTES);
    expect(r.tasks).toHaveLength(0);
    expect(r.diary).toHaveLength(0);
    expect(r.notes).toHaveLength(1);
  });

  it('countHits 含 notes', () => {
    expect(countHits(searchAll('Ctrl', TASKS, DIARY, NOTES))).toBe(1);
    const r = searchAll('a', TASKS, DIARY, NOTES);
    expect(countHits(r)).toBeGreaterThanOrEqual(r.notes.length);
  });

  it('脏数据兜底（notes 内含非对象项不抛）', () => {
    const dirty = [note('n1', 'x', 'y'), null, 'junk'] as unknown as Note[];
    expect(() => searchAll('x', TASKS, DIARY, dirty)).not.toThrow();
    expect(searchAll('y', TASKS, DIARY, dirty).notes.map((n) => n.id)).toEqual(['n1']);
  });
});
