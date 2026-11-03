import { enroll } from './srs';
import type { DateKey, Note } from '../types';

/* ============================================================================
   记事模板（F3）—— 纯函数，零 React / 零 localStorage
   目前只有一个模板：**错题笔记**。它把"记错题"这件事从"新建 + 手打四个小标题 +
   再点一次加入复习"压缩成一次点击 —— 三个动作里任何一个被忘掉，
   这条错题就永远不会进复习队列，也就等于没记。

   === 两条刻意的设计 ===
   ① 分类写 `'错题'` 这个**字符串**，不往 settings.categories 里静默新增分类：
      分类是设置项，静默新增会让用户的分类列表越来越脏（每点一次错题就多一条）。
      记事模型里的 category 本来就允许不在清单内（渲染层会把不认识的分类
      当成"自定义分类"显示），代价远小于污染设置。
   ② 普通「新建」**仍然不入队**（`AUTO_ENROLL_ON_CREATE === false` 语义不变）：
      记事本里大部分是配置片段 / 点子，自动全变卡片会把复习队列灌满噪音。
      只有"错题"这一个显式入口才自动 enroll。
   ========================================================================= */

/** 错题笔记的分类名（注意：记事的 category 存的是**分类 id / 名字**都行，见上面 ①） */
export const MISTAKE_CATEGORY = '错题';

/** 错题笔记的默认标题（用户可随手改） */
export const MISTAKE_TITLE = '错题';

/**
 * 错题模板正文。
 *
 * 四个小标题就是"把一道错题想清楚"的四步：
 * 题目（是什么）→ 我错在哪（诊断）→ 正确思路（怎么对）→ 知识点（补哪块）。
 * 顺序不要动：先抄题再分析，符合实际复盘时的动作顺序。
 */
export const MISTAKE_TEMPLATE = `## 题目

## 我错在哪

## 正确思路

## 知识点
`;

/** 光标锚点：新建后把光标放在这个标题后面，用户可以直接开始写题目 */
export const MISTAKE_CARET_ANCHOR = '## 题目';

/**
 * 光标应该落在正文的第几个字符位置（`selectionStart`）。
 *
 * 放在「## 题目」这四个字之后：用户点「记错题」之后的第一件事就是写题目，
 * 不该再让他自己把光标挪到正确的位置（模板只要光标不对，用户就会在标题行
 * 前面开始打字，然后整份模板被写坏）。
 *
 * 找不到锚点（内容被替换过）时退回 0 —— 绝不返回 -1（`setSelectionRange(-1)`
 * 会把光标甩到末尾）。
 */
export function mistakeCaretIndex(content: string = MISTAKE_TEMPLATE): number {
  const at = content.indexOf(MISTAKE_CARET_ANCHOR);
  return at < 0 ? 0 : at + MISTAKE_CARET_ANCHOR.length;
}

/**
 * 空白记事（普通「新建」用）。
 *
 * id 由调用方给（组件里是 `crypto.randomUUID()`），保持本函数纯、可单测。
 * **不带 sr 键** —— "有没有 sr 键"就是"是不是复习卡片"的判据，
 * 普通新建绝不能凭空多出一个 sr。
 */
export function createBlankNote(id: string, now: string): Note {
  return {
    id,
    title: '',
    content: '',
    category: '',
    pinned: false,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 错题笔记：预填模板 + `category: '错题'` + **自动加入复习**。
 *
 * 自动入队复用 `srs.enroll`（不另写一份 sr 字面量）：
 * 它给出的正是 `{ due: today, ivl: 0, reps: 0 }` —— `ivl === 0` 的语义是
 * "已入队但还没学过的新卡"，于是这张卡会按 `NEW_CARD_DAILY_CAP` 限流进队列，
 * 而不是一上来就被当成逾期老卡。
 */
export function createMistakeNote(id: string, now: string, today: DateKey): Note {
  const base: Note = {
    ...createBlankNote(id, now),
    title: MISTAKE_TITLE,
    content: MISTAKE_TEMPLATE,
    category: MISTAKE_CATEGORY,
  };
  return enroll(base, today, now);
}
