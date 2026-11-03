import { useCallback, useEffect, useMemo, useState } from 'react';
import { DIARY_MAX, TEXT } from '../constants';
import { useAppDispatch, useAppState } from '../store/StoreContext';
import { useDebouncedCommit } from '../hooks/useDebouncedCommit';
import { addDays, formatDateTitle, nowIso } from '../lib/date';
import { formatFocusDuration } from '../lib/focus';
import { renderMarkdown, stripMarkdown } from '../lib/markdown';
import {
  buildWeeklyMarkdown,
  buildWeeklyStats,
  upsertWeeklySection,
  weeklyWriteDate,
  type WeeklyAnswers,
} from '../lib/weekly';
import type { DateKey, DiaryEntry } from '../types';
import { Icon } from '../components/common/Icon';
import { Segmented } from '../components/common/Segmented';

export interface DiaryViewProps {
  /** 当前真实今天（App 统一传入，视图自己不读时钟） */
  today: DateKey;
}

/** 空正文 = 被删除的墓碑，对用户来说等于"这天没写" */
function isWritten(entry: DiaryEntry | undefined): boolean {
  return Boolean(entry && entry.content.trim());
}

/** 周报指标卡（一行 label + 一行 value，和专注页的 StatCard 同款语义） */
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line bg-paper px-3 py-2">
      <div className="truncate text-label font-semibold text-ink-2">{label}</div>
      <div className="tnum mt-1 truncate text-body font-semibold text-ink">{value}</div>
    </div>
  );
}

/** '21:00–22:00'（与 lib/weekly 的展示口径一致，只在摘要卡里用） */
function hourRange(hour: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(hour)}:00–${pad(hour + 1)}:00`;
}

/**
 * 日记视图：一天一篇的记事本。
 *
 * - 上方是选中日期的编辑器，输入即存（保存防抖由 usePersist 统一负责）；
 * - 下方是写过的日记时间线，点一条切到那天继续写；
 * - 「清空这篇」= 把正文置空留墓碑，这样删除能同步到别的设备（详见 reducer 的 DIARY_DELETE）。
 */
export function DiaryView({ today }: DiaryViewProps) {
  const { diary, settings, tasks, focusSessions, notes } = useAppState();
  const dispatch = useAppDispatch();

  // 选中日与今日视图共用 `settings.lastSelectedDate`：日历点过的日期、
  // 搜索结果跳转，都能把日记切到同一天，不用各存一份"当前在看哪天"。
  const selected = settings.lastSelectedDate;
  const setSelected = useCallback(
    (date: DateKey) => dispatch({ type: 'SET_SELECTED_DATE', date }),
    [dispatch],
  );
  const current = useMemo(() => diary.find((entry) => entry.date === selected), [diary, selected]);

  // 编辑器本地草稿：输入时不直接依赖 store 回灌，避免光标跳动
  const [draft, setDraft] = useState(current?.content ?? '');
  /** 编辑 / 预览。默认编辑：日记的第一动作是写，不是看 */
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');

  /**
   * 预览态的 HTML **必须** useMemo。
   *
   * `renderMarkdown` 是渲染期**同步**求值的（日记上限 DIARY_MAX 字），
   * 不缓存的话父级任何一次重渲（切模式、改设置、自动同步回灌）都会把整篇
   * 重新解析一遍 —— 长日记上是肉眼可见的卡顿。
   * 只在预览态才算：编辑态算它纯属浪费。
   */
  const previewHtml = useMemo(
    () => (mode === 'preview' ? renderMarkdown(draft) : ''),
    [mode, draft],
  );

  // 切换日期 / 云端同步把日记换了 → 先把上一篇的待提交内容送出去，再换草稿
  useEffect(() => {
    diaryCommit.flush();
    setDraft(current?.content ?? '');
    // diaryCommit 的方法引用稳定（useCallback），不需要进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, current?.content]);

  const written = useMemo(
    () => diary.filter(isWritten).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
    [diary],
  );

  /**
   * 正文**防抖提交**（350ms）。
   *
   * 原来每敲一个字就 dispatch 一次全局 store：全树重渲 + 任务整表 map +
   * 字段时钟重算 + 300ms 后整包序列化。长日记上这就是"打字发涩"的正体。
   *
   * 防抖的风险是丢字，所以 `useDebouncedCommit` 在卸载 / pagehide / 切后台
   * 都会补交，并且 `cancel` 供"清空日记"用（否则清空之后草稿又被写回去）。
   *
   * ⚠️ 提交时带的是**schedule 那一刻的日期**，不是"现在选中的日期" ——
   * 否则快速翻两天再停下来，前一篇的正文会被写进后一篇。
   */
  const diaryCommit = useDebouncedCommit<{ date: DateKey; content: string }>({
    commit: ({ date, content }) =>
      dispatch({ type: 'DIARY_UPSERT', date, content, now: new Date().toISOString() }),
  });

  const onDraftChange = useCallback(
    (value: string) => {
      setDraft(value);
      diaryCommit.schedule({ date: selected, content: value });
    },
    [diaryCommit, selected],
  );

  const onClear = useCallback(() => {
    if (!isWritten(current)) return;
    /**
     * ⚠️ 先 **cancel** 再删（不是 flush）。
     * flush 会把刚敲的几个字写回去一次（删了又冒出来）；
     * 不管它的话，350ms 后定时器到点又把内容写进已被删掉的当天。
     */
    diaryCommit.cancel();
    dispatch({ type: 'DIARY_DELETE', date: selected, now: new Date().toISOString() });
    setDraft('');
  }, [current, diaryCommit, dispatch, selected]);

  const shift = useCallback(
    (delta: -1 | 1) => setSelected(addDays(selected, delta)),
    [selected, setSelected],
  );

  /* ---------- 周报复盘（F3） ---------- */

  /** 默认折叠：周报是"一周看一次"的东西，常驻展开会把日记编辑区挤下去 */
  const [weeklyOpen, setWeeklyOpen] = useState(false);
  const [answers, setAnswers] = useState<WeeklyAnswers>({ harvest: '', problem: '', next: '' });
  const [weeklyTruncated, setWeeklyTruncated] = useState(false);
  /**
   * 周区间三档：`-1` 上一周 / `0` 本周 / `+1` 下一周（v0.9 议题 3）。
   * 默认 0（本周）。它只影响**显示哪一周的统计**，不影响"今天"。
   */
  const [weekOffset, setWeekOffset] = useState<-1 | 0 | 1>(0);

  /**
   * 统计**总是**以"今天所在的这周"为基准，再按 weekOffset 整周平移，
   * 不受 selected 影响：用户可能在补写三天前的日记，但"本周回顾"锚在周。
   */
  const weeklyStats = useMemo(
    () =>
      buildWeeklyStats({
        tasks,
        focusSessions,
        notes,
        today,
        weekStart: settings.weekStart,
        weekOffset,
      }),
    [tasks, focusSessions, notes, today, settings.weekStart, weekOffset],
  );

  /**
   * 周报写进**哪一天**：`min(today, 那一周最后一天)`（规则抽在 `weeklyWriteDate` 里，
   * 因为它是纯逻辑、必须能单测，不能埋在 JSX 中间）。
   *
   * - 本周：`endKey >= today` → 写今天（与 v0.8 行为一致）；
   * - 历史周：`endKey < today` → 写那一周的最后一天（补写以前的周报）。
   */
  const weeklyTargetDate = weeklyWriteDate(today, weeklyStats.endKey);
  /** 判重与写入都必须看**目标那一篇**，否则切到历史周会错显示"已生成"（看的是今天那篇） */
  const targetEntry = useMemo(
    () => diary.find((entry) => entry.date === weeklyTargetDate),
    [diary, weeklyTargetDate],
  );
  const weeklyWritten = Boolean(targetEntry?.content?.includes(TEXT.weeklyMarker));
  /**
   * 可写范围（主理人 v0.8.1 裁决）：**历史周 + 本周可写，未来周仍只读**。
   *
   * 历史周放开是因为用户要补写以前的周报；未来周不放开是因为那一周还没发生，
   * 提前生成一份"这周的总结"就是编造。写入落点由 `weeklyTargetDate` 兜住，
   * 所以"看的是上周、写进今天"的歧义不存在了。
   */
  const canWriteWeekly = weekOffset <= 0;
  /** 历史周（`-1`）：写入目标不是今天，UI 必须明说，否则用户以为写进了今天 */
  const isBackfillWeek = weekOffset < 0;
  const weeklyTargetHint = `${TEXT.weeklyWriteTarget} ${formatDateTitle(weeklyTargetDate)}`;
  const weeklyWriteTitle = canWriteWeekly
    ? isBackfillWeek
      ? weeklyTargetHint
      : TEXT.weeklyWrite
    : TEXT.weeklyFutureReadOnly;

  const onWriteWeekly = useCallback(() => {
    // 未来周不写（按钮已禁用，这里是第二道闸：键盘 / 程序化调用都拦得住）
    if (!canWriteWeekly) return;
    const stamp = nowIso();
    const section = buildWeeklyMarkdown(weeklyStats, answers, stamp);
    const result = upsertWeeklySection(targetEntry?.content ?? '', section, TEXT.weeklyMarker);
    /**
     * 空间不足 → 这一下**什么都不写**（weekly.ts 已原样返回）。
     * 不 dispatch 是关键：写一份被截断的半截周报，下次点又追加一份，
     * 而界面还显示"已生成"—— 用户会在同一篇日记里攒出好几份周报。
     */
    if (result.skipped) {
      setWeeklyTruncated(true);
      return;
    }
    dispatch({ type: 'DIARY_UPSERT', date: weeklyTargetDate, content: result.content, now: stamp });
    setWeeklyTruncated(false);
    // 正在看目标那篇时草稿要跟着换，否则编辑器里还是旧内容（看起来像没写进去）
    if (selected === weeklyTargetDate) setDraft(result.content);
  }, [
    answers,
    canWriteWeekly,
    dispatch,
    selected,
    weeklyStats,
    targetEntry?.content,
    weeklyTargetDate,
  ]);

  const onAnswer = useCallback((key: keyof WeeklyAnswers, value: string) => {
    setAnswers((prev) => ({ ...prev, [key]: value }));
  }, []);

  const isToday = selected === today;
  const remaining = DIARY_MAX - draft.length;

  return (
    <section aria-labelledby="diaryTitle" className="flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 id="diaryTitle" className="text-h1 font-bold leading-h1 tracking-[-0.02em]">
          日记
        </h1>
        <div className="flex items-center gap-1">
          <button
            type="button"
            data-testid="diary-prev"
            onClick={() => shift(-1)}
            aria-label="前一天"
            className="grid h-11 w-11 place-items-center rounded-md text-ink-2 hover:bg-surface hover:text-ink"
          >
            <Icon name="chevron-left" size={16} />
          </button>
          <span data-testid="diary-date" className="tnum min-w-28 text-center text-body font-semibold">
            {formatDateTitle(selected)}
          </span>
          <button
            type="button"
            data-testid="diary-next"
            onClick={() => shift(1)}
            disabled={isToday}
            aria-label="后一天"
            className="grid h-11 w-11 place-items-center rounded-md text-ink-2 hover:bg-surface
              hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <Icon name="chevron-right" size={16} />
          </button>
          {!isToday ? (
            <button
              type="button"
              data-testid="diary-today"
              onClick={() => setSelected(today)}
              className="btn btn-outlined ml-1 shrink-0"
            >
              回到今天
            </button>
          ) : null}
        </div>
      </div>

      {/* ---------- 本周回顾（默认折叠） ---------- */}
      <div className="mt-4 card">
        <button
          type="button"
          data-testid="weekly-toggle"
          aria-expanded={weeklyOpen}
          onClick={() => setWeeklyOpen((prev) => !prev)}
          className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
        >
          <span className="flex min-w-0 items-center gap-2">
            <Icon
              name={weeklyOpen ? 'chevron-down' : 'chevron-right'}
              size={15}
              className="shrink-0 text-ink-3"
            />
            <span className="min-w-0 truncate text-body font-semibold text-ink">
              {TEXT.weekly} · {weeklyStats.rangeLabel}
            </span>
          </span>
          <span
            data-testid="weekly-status"
            className={`shrink-0 text-label ${weeklyWritten ? 'text-accent' : 'text-ink-3'}`}
          >
            {canWriteWeekly
              ? weeklyWritten
                ? TEXT.weeklyGenerated
                : TEXT.weeklyNotGenerated
              : TEXT.weeklyReadOnly}
          </span>
        </button>

        {weeklyOpen ? (
          <div className="border-t border-line px-4 py-4">
            {/* 三档周切换：‹ 上一周 | 本周 | 下一周 ›（v0.9 议题 3） */}
            <div className="mb-3 flex flex-wrap items-center gap-1">
              {(
                [
                  [-1, TEXT.weeklyPrevWeek, 'weekly-prev', '‹ '],
                  [0, TEXT.weeklyThisWeek, 'weekly-this', ''],
                  [1, TEXT.weeklyNextWeek, 'weekly-next', ''],
                ] as [-1 | 0 | 1, string, string, string][]
              ).map(([offset, label, testId, prefix]) => (
                <button
                  key={testId}
                  type="button"
                  data-testid={testId}
                  aria-pressed={weekOffset === offset}
                  onClick={() => setWeekOffset(offset)}
                  className={`btn h-8 px-2.5 text-label ${
                    weekOffset === offset ? 'btn-tonal' : 'btn-text'
                  }`}
                >
                  {prefix}
                  {label}
                  {offset === 1 ? ' ›' : ''}
                </button>
              ))}
              {isBackfillWeek ? (
                // 补写历史周：把目标日说出来（否则用户会以为写进了今天）
                <span data-testid="weekly-target" className="ml-auto text-label text-accent">
                  {weeklyTargetHint}
                </span>
              ) : !canWriteWeekly ? (
                <span data-testid="weekly-readonly" className="ml-auto text-label text-ink-3">
                  {TEXT.weeklyFutureReadOnly}
                </span>
              ) : null}
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Metric label={TEXT.weeklyFocusThisWeek} value={formatFocusDuration(weeklyStats.focusMs)} />
              <Metric
                label={TEXT.weeklyFocusLastWeek}
                value={
                  weeklyStats.focusDeltaPercent === null
                    ? formatFocusDuration(weeklyStats.prevFocusMs)
                    : `${formatFocusDuration(weeklyStats.prevFocusMs)}（${
                        weeklyStats.focusDeltaPercent >= 0 ? '+' : ''
                      }${weeklyStats.focusDeltaPercent}%）`
                }
              />
              <Metric
                label={TEXT.weeklyDone}
                value={`${weeklyStats.doneCount} / ${weeklyStats.totalCount}`}
              />
              <Metric
                label={TEXT.weeklyRate}
                value={weeklyStats.doneRate === null ? TEXT.emptyPercent : `${weeklyStats.doneRate}%`}
              />
              {/* 「本周复习 N 张」：区间内真的评过级的卡片数（靠 sr.last 归日） */}
              <Metric
                label={TEXT.weeklyReviewed}
                value={`${weeklyStats.reviewedCount} ${TEXT.weeklyReviewedUnit}`}
              />
              <Metric
                label={TEXT.weeklyPeakDay}
                value={weeklyStats.peakDay ? weeklyStats.peakDay.date : '—'}
              />
              <Metric
                label={TEXT.weeklyPeakHour}
                value={weeklyStats.peakHour ? hourRange(weeklyStats.peakHour.hour) : '—'}
              />
            </div>

            <div className="mt-4 flex flex-col gap-3">
              {(
                [
                  ['harvest', TEXT.weeklyAnswerHarvest, TEXT.weeklyAnswerHarvestPlaceholder],
                  ['problem', TEXT.weeklyAnswerProblem, TEXT.weeklyAnswerProblemPlaceholder],
                  ['next', TEXT.weeklyAnswerNext, TEXT.weeklyAnswerNextPlaceholder],
                ] as [keyof WeeklyAnswers, string, string][]
              ).map(([key, label, placeholder]) => (
                <label key={key} className="flex flex-col gap-1">
                  <span className="text-label font-semibold tracking-[0.06em] text-ink-2">{label}</span>
                  <textarea
                    data-testid={`weekly-answer-${key}`}
                    value={answers[key]}
                    onChange={(event) => onAnswer(key, event.target.value)}
                    placeholder={placeholder}
                    rows={2}
                    className="w-full resize-y rounded-md border border-line bg-paper px-3 py-2 text-body-sm
                      leading-relaxed text-ink"
                  />
                </label>
              ))}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                type="button"
                data-testid="weekly-write"
                onClick={onWriteWeekly}
                disabled={!canWriteWeekly}
                title={weeklyWriteTitle}
                className="btn btn-primary shrink-0 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isBackfillWeek
                  ? `${TEXT.weeklyWriteBackfill} ${formatDateTitle(weeklyTargetDate)}`
                  : TEXT.weeklyWrite}
              </button>
              <span className="text-label text-ink-3">
                {canWriteWeekly
                  ? weeklyWritten
                    ? TEXT.weeklyGenerated
                    : TEXT.weeklyCollapsedHint
                  : TEXT.weeklyFutureReadOnly}
              </span>
              {/*
                自动生成开关（长期迭代）。
                跟着「写入」按钮放在一起，是因为它俩改的是**同一件事**：
                周报进不进日记。开关只说"自动"，不改变手写的入口 ——
                关掉之后手动写入照样可用。
              */}
              <button
                type="button"
                data-testid="weekly-auto"
                aria-pressed={settings.weeklyAutoReport}
                onClick={() =>
                  dispatch({
                    type: 'SET_WEEKLY_AUTO_REPORT',
                    value: !settings.weeklyAutoReport,
                  })
                }
                title={TEXT.weeklyAutoHint}
                className={`btn ml-auto shrink-0 ${
                  settings.weeklyAutoReport ? 'btn-primary' : 'btn-outlined'
                }`}
              >
                {TEXT.weeklyAuto}：{settings.weeklyAutoReport ? '开' : '关'}
              </button>
              {/*
                说明必须是**可见文字**，不能只放 title ——
                手机上没有 hover，`title` 等于不存在，用户只看到一个开关
                却不知道它写的是哪一周（而上面这块显示的是**本周**统计，
                很容易误以为"自动生成没生效"）。`w-full` 让它单独占一行。
              */}
              {settings.weeklyAutoReport ? (
                <span data-testid="weekly-auto-hint" className="w-full text-label text-ink-3">
                  {TEXT.weeklyAutoHint}
                </span>
              ) : null}
            </div>

            {weeklyTruncated ? (
              <p data-testid="weekly-truncated" className="mt-2 text-label text-danger">
                {TEXT.weeklyTruncated}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="mt-4 card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Segmented
            ariaLabel="日记模式"
            variant="plain"
            value={mode}
            options={[
              { value: 'edit', label: '编辑' },
              { value: 'preview', label: '预览' },
            ]}
            onChange={setMode}
          />
          <div className="flex items-center gap-3">
            {remaining < 200 ? (
              <span className="tnum text-label text-warn">还可输入 {remaining} 字</span>
            ) : null}
            {isWritten(current) ? (
              <button
                type="button"
                data-testid="diary-clear"
                onClick={onClear}
                className="text-label text-ink-2 hover:text-danger"
              >
                清空这篇
              </button>
            ) : null}
          </div>
        </div>

        {mode === 'edit' ? (
          <>
            <textarea
              data-testid="diary-editor"
              value={draft}
              onChange={(event) => onDraftChange(event.target.value)}
              placeholder={'今天发生了什么？记一笔吧。\n\n支持 Markdown：# 标题、**粗体**、- 列表、- [ ] 待办'}
              aria-label={`${selected} 的日记`}
              rows={12}
              className="mt-3 w-full resize-y rounded-md border border-line bg-paper px-3 py-2 text-body
                leading-relaxed text-ink"
            />
            <p className="mt-1 text-label text-ink-3">
              支持 Markdown 语法，切到「预览」看效果
            </p>
          </>
        ) : (
          <div
            data-testid="diary-preview"
            className="diary-md mt-3 min-h-48 rounded-md border border-line bg-paper px-3 py-2"
            // renderMarkdown 内部**先转义再渲染**，输出里不可能出现用户写的标签
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        )}
      </div>

      <div className="mt-6">
        <div className="flex items-baseline justify-between">
          <h2 className="text-body font-semibold">写过的日记</h2>
          <span className="tnum text-label text-ink-2">{written.length} 篇</span>
        </div>
        {written.length === 0 ? (
          <p className="mt-2 text-label text-ink-2">{TEXT.emptyDiary}</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {written.map((entry) => (
              <li key={entry.date}>
                <button
                  type="button"
                  data-testid={`diary-item-${entry.date}`}
                  onClick={() => setSelected(entry.date)}
                  className={`w-full rounded-md border px-3 py-2 text-left transition-colors duration-short
                    ease-standard ${
                      entry.date === selected
                        ? 'border-accent bg-accent-soft'
                        : 'border-line bg-surface hover:bg-surface hover:border-accent/40'
                    }`}
                >
                  <div className="text-label font-semibold text-ink-2">{formatDateTitle(entry.date)}</div>
                  {/* 摘要去掉标记：列表里露出 ** 和 ### 很难看 */}
                  <p className="mt-1 line-clamp-2 text-body text-ink">{stripMarkdown(entry.content)}</p>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
