import { useCallback, useEffect, useMemo, useState } from 'react';
import { TEXT, VIEW_META } from '../constants';
import { useAppDispatch, useAppState } from '../store/StoreContext';
import { nowIso } from '../lib/date';
import { renderMarkdown } from '../lib/markdown';
import { buildReviewQueue, grade, isCard, unenroll, type ReviewRating } from '../lib/srs';
import { resolveReviewKey } from '../lib/listSlice';
import { Icon } from '../components/common/Icon';
import type { DateKey } from '../types';

/* ============================================================================
   复习会话（F1）—— 间隔重复的"考试现场"

   三条设计决定，改之前请先读：
   1. **队列冻结 id 列表**（`useState(() => …)` 只跑一次）。
      若写成 `useMemo(() => buildReviewQueue(notes, today), [notes])`，评级会改 notes
      → 队列重算 → 刚评完那张因为 due 被推到明天而离开队列 → 后面的卡整体前移，
      用户看到的现象是"我评完一张，界面上的卡自己跳走了、还少了一张"。
      冻结之后"这一轮是哪几张"在开始时就已经定了。
   2. **不用 Anki 的 learning steps**：`again → ivl=1, due=today+1`，
      所以同一张卡不会在同一次会话内复现，不需要秒级重排。
      硬加回来会和第 1 点打架（current 反复跳回上一张）。
   3. 评级 / 退出复习都走 `NOTE_UPSERT`，**不新增 reducer action** ——
      卡片的正文与进度是同一份数据，一条 upsert 路径就够。
   ========================================================================= */

export interface ReviewViewProps {
  /** 当前真实今天（App 统一传入，视图自己不读时钟） */
  today: DateKey;
  /** 退出会话。目标视图由 App 决定，这里不写死 */
  onExit: () => void;
}

export function ReviewView({ today, onExit }: ReviewViewProps) {
  const { notes, settings } = useAppState();
  const dispatch = useAppDispatch();

  /** ⚠️ 冻结：本次会话的卡片顺序只在挂载时算一次（理由见文件头第 1 点） */
  const [queueIds] = useState<string[]>(() =>
    // 新卡上限（F9）从设置来：0 = 不限制。挂载时定死，本次会话不再变（见文件头第 1 点）
    buildReviewQueue(notes, today, settings.dailyNewCardLimit, settings.dayStartHour).map(
      (note) => note.id,
    ),
  );
  const [cursor, setCursor] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [ratedCount, setRatedCount] = useState(0);
  const [remembered, setRemembered] = useState(0);

  const total = queueIds.length;
  const finished = cursor >= total;
  const current = cursor < total ? (notes.find((note) => note.id === queueIds[cursor]) ?? null) : null;

  /**
   * 答案区的 HTML 只在**换卡**时才重算。
   *
   * `renderMarkdown` 是渲染期同步求值的（markdown 源码上限 2 万字），
   * 而这张卡片所在的视图会因为"评级 / 显示答案 / 光标"频繁重渲 ——
   * 不缓存的话每次点一下都把整篇 Markdown 重解析一遍。缓存键就是内容本身。
   */
  const answerHtml = useMemo(
    () => (current ? renderMarkdown(current.content, 0, { maskImages: true }) : ''),
    [current],
  );

  /**
   * 卡片在会话中途消失（另一端把它删了 / 退出复习了）→ 静默跳过。
   * 不这样处理的话 current 会是 null、界面剩一块空白，用户不知道怎么继续。
   */
  useEffect(() => {
    if (cursor < total && !current) setCursor((prev) => prev + 1);
  }, [cursor, total, current]);

  /** 评级：写盘（NOTE_UPSERT）+ 前进一张 */
  const rate = useCallback(
    (rating: ReviewRating) => {
      if (!current) return;
      const now = nowIso();
      const next = grade(current, rating, today, now);
      // now 用 grade 自己写进去的 updatedAt —— 云同步靠它判断"这张被改过"
      dispatch({ type: 'NOTE_UPSERT', note: next, now: next.updatedAt });
      setRatedCount((prev) => prev + 1);
      if (rating === 'good') setRemembered((prev) => prev + 1);
      setRevealed(false);
      setCursor((prev) => prev + 1);
    },
    [current, dispatch, today],
  );

  /** 「这题不再复习」：删掉 sr 键后前进一张（不是删掉这条记事） */
  const dropCard = useCallback(() => {
    if (!current) return;
    const now = nowIso();
    const next = unenroll(current, now);
    dispatch({ type: 'NOTE_UPSERT', note: next, now: next.updatedAt });
    setRevealed(false);
    setCursor((prev) => prev + 1);
  }, [current, dispatch]);

  /** 下次到期提示：所有卡里最近的、且在今天之后的那个 due */
  const nextDue = useMemo(() => {
    let best: DateKey | null = null;
    for (const note of notes) {
      if (!isCard(note) || !note.sr) continue;
      if (note.sr.due <= today) continue;
      if (best === null || note.sr.due < best) best = note.sr.due;
    }
    return best;
  }, [notes, today]);

  /**
   * 快捷键：空格 = 显示答案（必须 preventDefault，否则整页跟着滚）、
   * 1/2/3 = 评级、Esc = 退出。
   * ⚠️ 这里只挂自己的监听，**不要卸载全局 useKeyboard** —— 任务行的
   * Space/Enter/Delete 在别的视图仍要工作，两套监听互不干扰。
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      /**
       * 键位翻译交给纯函数（`lib/listSlice.ts` 的 `resolveReviewKey`），
       * 这里只负责"拦不拦 + 调谁"。
       *
       * ⚠️ 拿到非 null 就**必须** preventDefault：全局快捷键把 1–9 映射成
       * 「切到第 N 个视图」，它只在 `defaultPrevented` 为真时才退让。
       * 曾经这里没拦，评一次级顺带把页面切走 —— 会话整个卸载、进度全丢，
       * 用户看到的是"评完这张卡它自己跳走了"。
       */
      const action = resolveReviewKey(event.key, revealed);
      if (!action) return;
      // 会话还没开始 / 已结束时，只允许 Esc 退出，其余按键原样还给页面
      if (action !== 'exit' && (finished || !current)) return;

      event.preventDefault();
      if (action === 'exit') {
        onExit();
        return;
      }
      if (action === 'reveal') {
        if (!revealed) setRevealed(true);
        return;
      }
      rate(action);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [current, finished, onExit, rate, revealed]);

  const categoryName = current?.category
    ? (settings.categories.find((item) => item.id === current.category)?.name ?? '')
    : '';

  /* ---------- 完成页 ---------- */
  if (finished) {
    return (
      <section aria-labelledby="reviewTitle" className="flex flex-col">
        <h1 id="reviewTitle" className="text-h1 font-bold leading-h1 tracking-[-0.02em]">
          {VIEW_META.review.label}
        </h1>
        <div
          data-testid="review-done"
          className="mt-6 card px-5 py-8 text-center"
        >
          <div className="text-h2 font-bold text-ink">{TEXT.reviewDoneTitle}</div>
          <div className="mt-4 flex items-center justify-center gap-6">
            <div>
              <div className="text-label text-ink-2">{TEXT.reviewDoneRated}</div>
              <div className="tnum mt-1 font-num text-h1 font-bold leading-none text-ink">
                {ratedCount}
              </div>
            </div>
            <div>
              <div className="text-label text-ink-2">{TEXT.reviewDoneRemembered}</div>
              <div className="tnum mt-1 font-num text-h1 font-bold leading-none text-accent">
                {remembered}
              </div>
            </div>
          </div>
          <p className="mt-5 text-body-sm text-ink-2">
            {TEXT.reviewDoneNext}：
            <span className="tnum ml-1 font-semibold text-ink">
              {nextDue ?? TEXT.reviewDoneNextNone}
            </span>
          </p>
          <button type="button" data-testid="review-exit" onClick={onExit} className="btn btn-primary mt-6">
            {TEXT.reviewBackToday}
          </button>
        </div>
      </section>
    );
  }

  /* ---------- 空队列（一张都没有） ---------- */
  if (total === 0) {
    return (
      <section aria-labelledby="reviewTitle" className="flex flex-col">
        <h1 id="reviewTitle" className="text-h1 font-bold leading-h1 tracking-[-0.02em]">
          {VIEW_META.review.label}
        </h1>
        <div className="mt-6 card-dashed px-5 py-12 text-center">
          <div className="text-h2 font-bold text-ink-2">{TEXT.reviewEmptyTitle}</div>
          <p className="mt-2 text-body-sm text-ink-2">{TEXT.reviewEmptyHint}</p>
          <button type="button" onClick={onExit} className="btn btn-outlined mt-6">
            {TEXT.reviewBackToday}
          </button>
        </div>
      </section>
    );
  }

  /* ---------- 卡片在会话中被删掉的那一瞬间 ---------- */
  if (!current) return null;

  return (
    <section aria-labelledby="reviewTitle" className="flex flex-col">
      <div className="flex items-center justify-between gap-2">
        <h1 id="reviewTitle" className="text-h1 font-bold leading-h1 tracking-[-0.02em]">
          {VIEW_META.review.label}
        </h1>
        <div className="flex items-center gap-2">
          <span data-testid="review-progress" className="tnum text-body-sm text-ink-2">
            {TEXT.reviewIndexPrefix} {cursor + 1} {TEXT.reviewIndexMiddle} {total}{' '}
            {TEXT.reviewIndexSuffix}
          </span>
          <button
            type="button"
            data-testid="review-quit"
            onClick={onExit}
            aria-label={TEXT.reviewBackToday}
            className="grid h-11 w-11 place-items-center rounded-md text-ink-2 hover:bg-surface hover:text-ink"
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      </div>

      <div className="mt-4 card p-5">
        {categoryName ? (
          <div className="flex items-center gap-2">
            <span className="chip shrink-0">{categoryName}</span>
          </div>
        ) : null}

        <div
          data-testid="review-question"
          className="mt-3 text-h2 font-bold leading-snug tracking-[-0.01em] text-ink"
        >
          {current.title || TEXT.uncategorized}
        </div>

        {revealed ? (
          <>
            {/* renderMarkdown 内部先转义再渲染（XSS 已内置），限深已有。
                F13：`maskImages` 让答案里的照片默认糊住，点一张看一张 ——
                错题照片常常就是解法本身，一口气摊开等于直接看答案。
                只在这一处开：记事本 / 日记要看的就是内容本身。 */}
            <div
              data-testid="review-answer"
              className="diary-md mt-4 rounded-md border border-line bg-paper px-4 py-3"
              onClick={(event) => {
                // 事件委托：HTML 是渲染出来的字符串，挂不了 React 处理器
                const mask = (event.target as HTMLElement).closest('.md-img-mask');
                if (mask) mask.classList.add('is-revealed');
              }}
              dangerouslySetInnerHTML={{ __html: answerHtml }}
            />

            <div className="mt-5 flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-testid="review-rate-again"
                onClick={() => rate('again')}
                className="btn btn-danger flex-1 min-w-24"
              >
                {TEXT.reviewAgain}
                <span className="ml-1 text-label opacity-70">1</span>
              </button>
              <button
                type="button"
                data-testid="review-rate-hard"
                onClick={() => rate('hard')}
                className="btn btn-outlined flex-1 min-w-24 text-warn"
              >
                {TEXT.reviewHard}
                <span className="ml-1 text-label opacity-70">2</span>
              </button>
              <button
                type="button"
                data-testid="review-rate-good"
                onClick={() => rate('good')}
                className="btn btn-primary flex-1 min-w-24"
              >
                {TEXT.reviewGood}
                <span className="ml-1 text-label opacity-70">3</span>
              </button>
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <span className="text-label text-ink-3">
                {TEXT.reviewAgainHint} · {TEXT.reviewHardHint} · {TEXT.reviewGoodHint}
              </span>
              <button
                type="button"
                data-testid="review-unenroll"
                onClick={dropCard}
                className="text-label text-ink-2 hover:text-danger"
              >
                {TEXT.reviewUnenroll}
              </button>
            </div>
          </>
        ) : (
          <div className="mt-5 flex flex-col items-center gap-2">
            <button
              type="button"
              data-testid="review-show-answer"
              onClick={() => setRevealed(true)}
              className="btn btn-primary min-w-32"
            >
              {TEXT.reviewShowAnswer}
            </button>
            <span className="text-label text-ink-3">空格</span>
          </div>
        )}
      </div>
    </section>
  );
}
