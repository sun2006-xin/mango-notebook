import type { DiaryEntry, Note, Task } from '../types';
import { isNoteDeleted } from './storage';

/* ============================================================================
   全文搜索（任务 + 日记 + 记事本）
   本文件不依赖 React / window / localStorage，全部可单测。
   ========================================================================= */

export interface SearchResult {
  /** 命中的任务（标题或备注里出现过关键词） */
  tasks: Task[];
  /** 命中的日记（正文里出现过关键词；空正文的墓碑不计入） */
  diary: DiaryEntry[];
  /** 命中的记事（标题或正文里出现过关键词；与记事本内部搜索一致） */
  notes: Note[];
}

/**
 * 大小写不敏感的包含匹配。
 * 空 query → 空集（调用方据此显示"输入点什么开始搜索"）。
 *
 * 命中即返回，不做排序：任务 / 日记 / 记事各自保留原顺序，
 * 结果量级在单机待办场景下都很小，排序收益低于多写一套规则的维护成本。
 *
 * `notes` 默认 `[]`：老的"三参"调用（search.test.ts）零改动仍可用。
 */
export function searchAll(
  query: string,
  tasks: Task[],
  diary: DiaryEntry[],
  notes: Note[] = [],
): SearchResult {
  const q = query.trim().toLowerCase();
  if (!q) return { tasks: [], diary: [], notes: [] };

  const taskList = Array.isArray(tasks) ? tasks : [];
  const diaryList = Array.isArray(diary) ? diary : [];
  const noteList = Array.isArray(notes) ? notes : [];

  return {
    tasks: taskList.filter(
      (task) =>
        task &&
        (String(task.title ?? '').toLowerCase().includes(q) ||
          String(task.note ?? '').toLowerCase().includes(q)),
    ),
    diary: diaryList.filter(
      (entry) =>
        entry &&
        typeof entry.content === 'string' &&
        entry.content.trim() !== '' &&
        entry.content.toLowerCase().includes(q),
    ),
    /**
     * 记事：标题或正文命中。**已删除的（content 为空的空壳）必须先剔掉** ——
     * 记事删除是软删除（NOTE_DELETE 只把 content 置空），搜到的空壳会让用户
     * 以为"删掉的东西还在"。
     */
    notes: noteList.filter(
      (note) =>
        note &&
        !isNoteDeleted(note) &&
        (String(note.title ?? '').toLowerCase().includes(q) ||
          String(note.content ?? '').toLowerCase().includes(q)),
    ),
  };
}

/** 结果总数（供浮层标题与"无结果"判断使用） */
export function countHits(result: SearchResult): number {
  return result.tasks.length + result.diary.length + result.notes.length;
}
