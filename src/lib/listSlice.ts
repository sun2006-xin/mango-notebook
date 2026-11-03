/* ============================================================================
   列表"先看几条"的截断规则（纯函数）
   ----------------------------------------------------------------------------
   从 `OverdueSection` 里抽出来的。原来这段逻辑写在 JSX 上方三行：
     const LIMIT = 3;
     const overflow = tasks.length - LIMIT;
     const visibleTasks = showAll || overflow <= 0 ? tasks : tasks.slice(0, LIMIT);
   它有三个容易写错的边界，只有把它变成可测函数才看得见：
     ① 刚好 3 条 → 没有"还有 N 条"（overflow = 0 不算溢出）；
     ② 2 条而 LIMIT=3 → overflow 是负数，按钮不能出现（"还有 -1 条"）；
     ③ 展开后再删掉几条 → 显示全部，但 overflow 仍要按原始长度算，不能变负数。
   ========================================================================= */

export interface ListSlice<T> {
  /** 当前该渲染的那些 */
  visible: T[];
  /** 被折叠起来的条数（>0 才显示"还有 N 条"） */
  overflow: number;
}

/**
 * 按"先看前 N 条"折叠长列表。
 *
 * @param items   全量
 * @param expanded 用户是否点开了"还有 N 条"
 * @param limit   预览条数（默认 3）
 */
export function sliceForPreview<T>(items: T[], expanded: boolean, limit = 3): ListSlice<T> {
  /**
   * 非法上限（0 / 负数 / NaN）回落到默认 3，而不是"夹到 1"。
   * 夹到 1 会让调用方传错参数时静默变成"每次只显示一条"，
   * 那种 bug 在界面上看起来只是"列表怎么只剩一条"，很难联想到参数。
   */
  const safeLimit = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 3;
  const overflow = Math.max(0, items.length - safeLimit);
  if (expanded || overflow === 0) return { visible: items, overflow };
  return { visible: items.slice(0, safeLimit), overflow };
}

/* ============================================================================
   复习会话的键盘映射（纯函数）
   ----------------------------------------------------------------------------
   从 `ReviewView` 的 keydown 处理里抽出来的。抽的理由不是"更短"，而是：
   哪种按键该**拦掉浏览器默认行为**是这条链路的关键（曾经不拦，评一次级
   顺带把页面切走、会话全丢），而"拦不拦"埋在事件处理里根本没法单测。
   ========================================================================= */

export type ReviewKeyAction = 'reveal' | 'again' | 'hard' | 'good' | 'exit';

/**
 * 把一个按键翻译成复习会话该做的动作。
 *
 * 返回 `null` = 这个键不归会话管（交还给全局快捷键）。
 * 调用方拿到非 null 就**必须** `preventDefault()` —— 因为非 null 意味着
 * 会话要独占这个键；不拦的话全局的「1–9 切视图」会同时触发。
 */
export function resolveReviewKey(key: string, revealed: boolean): ReviewKeyAction | null {
  if (key === 'Escape') return 'exit';
  /**
   * 空格**永远**算会话的键：已翻开时是 no-op，但同样要拦掉默认行为 ——
   * 不拦的话按一下就整页往下滚，用户会以为"翻页"了。
   */
  if (key === ' ' || key === 'Spacebar') return 'reveal';
  // 评级只在翻开之后生效：没翻开时按数字不该把这张卡评掉
  if (!revealed) return null;
  if (key === '1') return 'again';
  if (key === '2') return 'hard';
  if (key === '3') return 'good';
  return null;
}
