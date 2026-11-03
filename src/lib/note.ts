/**
 * 记事本的**零依赖叶子模块**。
 *
 * 为什么单独抽出来：`isNoteDeleted` 原本住在 `storage.ts`，而复习引擎
 * `srs.ts` 也需要它（判断一条记事是不是"已删除的空壳"）。
 * 如果放在 storage 里，依赖会变成
 *
 *     storage.ts → srs.ts → storage.ts   ← 环
 *
 * ESM 的循环依赖在 Vite / Node 下不报错，只在**运行时**随机变成 undefined ——
 * 表现是"某个函数有时能用、有时 TypeError"，且只在一部分打包产物里复现。
 * 所以把 `isNoteDeleted` 下沉到这个不 import 任何东西的叶子文件：
 *
 *     note.ts ← srs.ts ← storage.ts      ← 单向、无环
 *
 * `storage.ts` 继续 `export { isNoteDeleted } from './note'`，
 * 既有调用点（NotesView / search.ts / notes.test.ts）一行都不用改。
 */
import type { Note } from '../types';

/**
 * 这条记事是不是"已删除"状态。
 *
 * `NOTE_DELETE` 是软删除：不清条目，只把 content 置空并刷新 updatedAt ——
 * 那具空壳就是"这条被删过"的唯一凭据，它必须活着才能同步到别的设备
 * （否则另一台还留着正文的设备一合并，删掉的记事就复活了）。
 *
 * 所以**所有面向用户的地方**（记事列表、全局搜索、复习队列）都用它把空壳挡掉，
 * 用户看到的就是"删掉了"。
 *
 * content 不是字符串（脏数据 / 老数据缺字段）一律按已删处理：渲染出来也是空壳。
 */
export function isNoteDeleted(note: Note | null | undefined): boolean {
  if (!note || typeof note !== 'object') return true;
  return typeof note.content !== 'string' || note.content === '';
}
