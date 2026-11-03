import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FILTER_OPTIONS, TEXT } from '../constants';
import { useAppDispatch, useAppState } from '../store/StoreContext';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { useTaskActions } from '../hooks/useTaskActions';
import { useTaskDrag } from '../hooks/useTaskDrag';
import { formatDateTitle } from '../lib/date';
import { countDoneInView, getDayProgress } from '../lib/task';
import { selectDayView } from '../lib/dayView';
import { budgetSegments, dayBudget } from '../lib/budget';
import { nextGoal, formatGoalCountdown, goalPhaseHint } from '../lib/goal';
import { formatSleepSummary, nowTimeKey } from '../lib/sleep';
import { dueCount } from '../lib/srs';
import { habitDayProgress } from '../lib/habits';
import { recapDate } from '../lib/recap';
import { focusStatsByTask } from '../lib/focus';
import type { DateKey, FilterMode } from '../types';
import { Icon } from '../components/common/Icon';
import { ProgressBar } from '../components/common/ProgressBar';
import { Segmented } from '../components/common/Segmented';
import { OverdueSection } from '../components/task/OverdueSection';
import { HabitStrip } from '../components/task/HabitStrip';
import { DailyRecapCard } from '../components/task/DailyRecapCard';
import { QuickAdd } from '../components/task/QuickAdd';
import { TaskList } from '../components/task/TaskList';
import { TodaySummary } from '../components/today/TodaySummary';

export interface TodayViewProps {
  /** 当前真实今天（App 每 60s 检查跨天），避免各视图各自读时钟 */
  today: DateKey;
  /**
   * 「开始专注」的意图回调（F2）。由 App 注入 —— 它才持有 `pendingFocusTaskId`
   * 与切视图逻辑。不传也能用：任务行只是不出现那个 ▷。
   */
  onRequestFocus?: (taskId: string) => void;
}

/**
 * 今日视图（M2-5）：日期标题 + 切日 · 进度头 · QuickAdd · 逾期轻文字行 ·
 * 待办/已完成两段 · 筛选工具条。
 * 数据一律由 lib 的纯函数派生（useMemo），组件本身只持有一个「逾期区折叠」本地态。
 */
export function TodayView({ today, onRequestFocus }: TodayViewProps) {
  const { tasks, notes, settings, ui, focusSessions } = useAppState();
  const dispatch = useAppDispatch();
  const actions = useTaskActions(today, { onRequestFocus });
  const breakpoints = useBreakpoint();
  /** 拖拽排序：待办段里拖到某条之前 = 手动排序；逾期区拖进来 = 挪到这一天 */
  const drag = useTaskDrag(today);

  const [overdueCollapsed, setOverdueCollapsed] = useState(false);
  /**
   * 今日概览的展开态。**刻意不持久化**：每天打开就该看到清单，
   * 而不是昨天自己展开过就一直展开着 —— 那等于把默认值交给一次误触。
   */
  const [briefOpen, setBriefOpen] = useState(false);
  const quickAddRef = useRef<HTMLInputElement>(null);

  const date = settings.lastSelectedDate;
  const mode = settings.filterMode;
  const category = settings.filterCategory;

  /**
   * 今日待复习张数（F1 的入口）。
   * 口径由 lib/srs 的 dueCount 独占：逾期老卡不截断 + 新卡按天限流，
   * 视图这里只负责"有没有、几张"。
   */
  const dueReview = dueCount(notes, today);

  /** 按任务的专注累计（任务行上的「专注 50min · 预计 30min」） */
  const focusStats = useMemo(() => focusStatsByTask(focusSessions), [focusSessions]);

  /**
   * 今日时间预算（F1）：预计 / 已专注 / 未估时条数。
   * 口径全在 lib/budget 里（只算未完成 + 顶层任务，专注时长与自习室同源）。
   * 传**全量** focusSessions —— dayBudget 内部按 session.date 过滤，
   * 这里再筛一遍只会制造"两份归日逻辑"。
   */
  const budgetParts = useMemo(
    () => budgetSegments(dayBudget(tasks, date, focusSessions)),
    [tasks, date, focusSessions],
  );

  /**
   * 目标倒计时（F2）：最近一个**未过期**的目标。
   *
   * `today` 用的是 App 传下来的那个（= `todayKey(settings.dayStartHour)`）——
   * **绝不在视图里再读一次系统时钟**：日界设成 4 点时，凌晨 1 点的"今天"
   * 仍是前一天，两处口径不同会让横幅差一天（用户专门拍板了这条）。
   */
  const goalCountdown = useMemo(() => nextGoal(settings.goals, today), [settings.goals, today]);
  /** 横幅文案（空串 = 没目标，整行不渲染） */
  const goalText = useMemo(() => formatGoalCountdown(goalCountdown), [goalCountdown]);
  /** 阶段提示（F1）：只显示、不改数据，也不编"今天该做几条" */
  const goalHint = useMemo(
    () => (goalCountdown ? goalPhaseHint(goalCountdown.days) : ''),
    [goalCountdown],
  );

  /**
   * 作息打卡（F5）：今天这一条。
   * 只陈述「几点睡/几点起」，不评分不催促 —— 用户自己看得到，说教只会让人关掉它。
   */
  const todaySleep = useMemo(
    () => settings.sleepLog.find((item) => item.date === today) ?? null,
    [settings.sleepLog, today],
  );
  const sleepSummary = useMemo(() => formatSleepSummary(todaySleep), [todaySleep]);

  /**
   * 当日派生数据**一次算完**（progress + dayTasks + group）。
   *
   * 原来这里是三个 memo：progress 与 dayTasks 各扫一遍全表，group 内部又扫一遍
   * （`groupDayTasks` 自己会再调 `getTasksForDate`）。一次任务编辑下来，同一张表
   * 被 filter 三遍。
   *
   * 现在 `selectDayView` 一次取当日数组、喂给的两处，并且**返回引用稳定**：
   * 输入不变就返回同一个对象 —— 这是 `TaskList`（已 memo）能不能跳过重渲的前提。
   */
  /**
   * 折叠"已完成"的回调必须**稳定**：它是 `TaskList`（memo）的 props 之一，
   * 写成内联箭头函数会让 memo 每次都比较失败，列表照旧整棵重渲。
   */
  const onToggleCollapse = useCallback(
    () => dispatch({ type: 'TOGGLE_DONE_COLLAPSED' }),
    [dispatch],
  );

  const { progress, dayTasks, group } = useMemo(
    () =>
      selectDayView({
        tasks,
        date,
        today,
        mode,
        category,
        stickyDoneIds: ui.stickyDoneIds,
        includeOverdue: true,
      }),
    [tasks, date, today, mode, category, ui.stickyDoneIds],
  );

  /**
   * 概览条摘要（一行把"辅助信息"说完）。
   *
   * 只有**真的有内容**时才出一段：没设目标就不提目标，昨天没干活就不提昨天。
   * 全空 → 空数组 → `TodaySummary` 整块不渲染（连那行字都不占）。
   */
  const summaryChips = useMemo(() => {
    const chips: string[] = [];
    if (goalText) chips.push(goalText);

    const yesterday = getDayProgress(tasks, recapDate(today));
    if (yesterday.total > 0) chips.push(`昨日 ${yesterday.done}/${yesterday.total}`);

    const habits = habitDayProgress(settings.habits, settings.habitChecks, today);
    if (habits.total > 0) chips.push(`习惯 ${habits.done}/${habits.total}`);

    if (sleepSummary) chips.push(sleepSummary);
    return chips;
  }, [goalText, tasks, today, settings.habits, settings.habitChecks, sleepSummary]);

  const doneCount = countDoneInView(group);
  const hasAny = dayTasks.length > 0;
  const nothingToShow = group.open.length === 0 && doneCount === 0 && group.overdue.length === 0;

  // 空状态自动聚焦（P0-4）
  useEffect(() => {
    if (!hasAny) quickAddRef.current?.focus();
  }, [hasAny, date]);

  const setFilter = useCallback(
    (next: FilterMode) => dispatch({ type: 'SET_FILTER', mode: next }),
    [dispatch],
  );

  const percent = progress.percent;
  const showCategory = !breakpoints.isNarrow420;
  const showTime = !breakpoints.isNarrow360;

  return (
    <section aria-labelledby="todayTitle" className="flex flex-col">
      {/* 复习横幅：**section 的第一个子元素**，只在真的有卡要复习时出现。
          没有到期卡片时一个像素都不占 —— 常驻一个「今日待复习 0 张」
          只会变成噪音。 */}
      {dueReview > 0 ? (
        <button
          type="button"
          data-testid="review-banner"
          onClick={() => dispatch({ type: 'SET_VIEW', view: 'review' })}
          aria-label={`${TEXT.reviewBannerPrefix} ${dueReview} ${TEXT.reviewBannerUnit}`}
          className="mb-4 flex w-full items-center justify-between gap-2 rounded-lg border border-accent/30
            bg-accent-soft px-4 py-3 text-left"
        >
          <span className="text-body-sm font-semibold text-accent">
            {TEXT.reviewBannerPrefix}{' '}
            <b data-testid="review-banner-count" className="tnum font-num">
              {dueReview}
            </b>{' '}
            {TEXT.reviewBannerUnit}
          </span>
          <Icon name="chevron-right" size={15} className="shrink-0 text-accent" />
        </button>
      ) : null}

      {/* 单行头部：日期标题 + 切日 + 操作。≤640 时「新任务」收成 44×44 圆形图标按钮，
          与标题同一行右侧，避免独占一整行（P0-12 / 320 打磨）。 */}
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <button
            type="button"
            onClick={() => dispatch({ type: 'SHIFT_DATE', delta: -1 })}
            aria-label="前一天"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-md text-ink-2 hover:bg-surface hover:text-ink max-xxs:h-10 max-xxs:w-10"
          >
            <Icon name="chevron-left" />
          </button>
          <h1
            id="todayTitle"
            className="tnum min-w-0 truncate text-h1 font-bold leading-h1 tracking-[-0.02em] max-xxs:text-h2 sm:text-date sm:leading-date"
          >
            {formatDateTitle(date)}
          </h1>
          <button
            type="button"
            onClick={() => dispatch({ type: 'SHIFT_DATE', delta: 1 })}
            aria-label="后一天"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-md text-ink-2 hover:bg-surface hover:text-ink max-xxs:h-10 max-xxs:w-10"
          >
            <Icon name="chevron-right" />
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {date === today ? null : (
            <button
              type="button"
              onClick={() => dispatch({ type: 'SET_SELECTED_DATE', date: today })}
              className="btn btn-text max-xs:px-2"
            >
              <span className="max-xs:hidden">{TEXT.backToToday}</span>
              <span className="hidden max-xs:inline">今天</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => quickAddRef.current?.focus()}
            aria-label="新任务"
            title="新任务"
            className="btn btn-primary max-xs:h-11 max-xs:w-11 max-xs:rounded-full max-xs:px-0"
          >
            <Icon name="plus" size={15} />
            <span className="max-xs:hidden">新任务</span>
          </button>
        </div>
      </div>

      {/* 今日概览：辅助信息收成一行，默认收起 —— 首屏要留给任务清单。
          展开才铺开回顾卡 / 目标 / 作息 / 习惯（实测：这四块摊开共 384px，
          会把第一条任务顶到 1.18 屏）。 */}
      <TodaySummary
        chips={summaryChips}
        expanded={briefOpen}
        onToggle={() => setBriefOpen((prev) => !prev)}
      >
        <div className="flex flex-col">
          {/* 昨日回顾（F15-A）：**一天只出现一次**，关掉就不再打扰。
              放在最上面是因为它回答的是"我昨天推进了什么"——进门第一眼该看到的东西。 */}
          <DailyRecapCard today={today} />

          {/* 目标倒计时（F2）：紧跟在复习横幅下面的一条轻文字行。
              没有（未过期）目标时**整行不渲染** —— "没有目标"是个安静的状态，
              常驻一句"暂无目标"只会和复习横幅抢注意力。
              `days === 0` 换成"就是今天"：说"还有 0 天"是机器语言。 */}
          {goalText ? (
            <div
              data-testid="goal-countdown"
              className="mb-4 flex w-full items-center gap-2 card px-4 py-2.5"
            >
              <Icon name="calendar" size={14} className="shrink-0 text-ink-3" />
              <span className="min-w-0 truncate text-label text-ink-2">{goalText}</span>
              {goalHint ? (
                <span className="ml-auto shrink-0 pl-2 text-label text-ink-3">{goalHint}</span>
              ) : null}
            </div>
          ) : null}

          {/*
            作息打卡（F5）。

            ⚠️ `date` 用的是 **today** 而不是当前选中日：
            这个按钮的语义是"记录此刻发生的事"（我现在起床了），
            而 `date` 会被 ←/→ 改成任意一天 —— 翻到前天再点一下，
            就会把今天的起床时间写进前天，污染历史。
            要补记历史请在「记起床」之后用时间框改（那是显式修改，不会误写）。
          */}
          <div
            data-testid="sleep-log"
            className="mb-4 flex w-full flex-wrap items-center gap-2 card px-4 py-2"
          >
            <span className="text-label text-ink-2">作息</span>
            {/*
              未记录 → 一键打卡（记"现在"）；
              已记录 → 变成可编辑的时间框。
              只给按钮的话，点完就再也改不了 —— 用户报的"只能点一次"就是这个：
              凌晨随手一点，上午想起来要改成 02:10 就没入口了。
              清空时间框 = 撤销这项打卡（两项都空时整条记录自动消失）。
            */}
            {todaySleep?.wakeAt ? (
              <label className="flex items-center gap-1 text-label text-ink-2">
                起
                <input
                  type="time"
                  data-testid="sleep-wake"
                  value={todaySleep.wakeAt}
                  aria-label="修改起床时间"
                  onChange={(event) =>
                    dispatch({ type: 'SLEEP_LOG_SET', date: today, wakeAt: event.target.value || null })
                  }
                  className="tnum h-8 field px-1.5 text-label text-ink"
 />
 </label>
 ) : (
 <button
 type="button"
 data-testid="sleep-wake"
 onClick={() => dispatch({ type: 'SLEEP_LOG_SET', date: today, wakeAt: nowTimeKey() })}
 className="btn btn-text h-8 px-2 text-label"
              >
                记起床
              </button>
            )}

            {todaySleep?.sleepAt ? (
              <label className="flex items-center gap-1 text-label text-ink-2">
                睡
                <input
                  type="time"
                  data-testid="sleep-bed"
                  value={todaySleep.sleepAt}
                  aria-label="修改睡觉时间"
                  onChange={(event) =>
                    dispatch({ type: 'SLEEP_LOG_SET', date: today, sleepAt: event.target.value || null })
                  }
                  className="tnum h-8 field px-1.5 text-label text-ink"
 />
 </label>
 ) : (
 <button
 type="button"
 data-testid="sleep-bed"
 onClick={() => dispatch({ type: 'SLEEP_LOG_SET', date: today, sleepAt: nowTimeKey() })}
 className="btn btn-text h-8 px-2 text-label"
              >
                记睡觉
              </button>
            )}
            {sleepSummary ? (
              <span className="ml-auto text-label text-ink-3">{sleepSummary}</span>
            ) : null}
          </div>

          {/* 习惯打卡（F12）：紧跟在作息下面 —— 两块都是"一天一次的二值记录"。
              没配习惯时整块不渲染（组件自己返回 null）。 */}
          <HabitStrip today={today} />

        </div>
      </TodaySummary>

      {/* ≤420：`已完成 8/12 …… 67%` 一行 + 进度条独占下一行（320 打磨） */}
      <div className="mb-5 mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="flex items-baseline gap-2 whitespace-nowrap text-body-sm text-ink-2 max-xs:order-1">
          已完成
          <b
            data-testid="head-done"
            className="tnum font-num text-num-lg font-bold leading-none tracking-[-0.02em] text-ink"
          >
            {progress.done}
          </b>
          <span data-testid="head-total" className="tnum font-num text-body text-ink-2">
            / {progress.total}
          </span>
        </span>
        <div className="min-w-0 flex-1 basis-40 max-xs:order-3 max-xs:basis-full">
          <ProgressBar
            done={progress.done}
            total={progress.total}
            percent={percent}
            ariaLabel="当日完成进度"
          />
        </div>
        <span
          data-testid="head-pct"
          className="tnum min-w-11 shrink-0 text-right text-body-sm font-semibold text-ink-2 max-xs:order-2 max-xs:ml-auto"
        >
          {percent === null ? TEXT.emptyPercent : `${percent}%`}
        </span>
        {/* 今日时间预算：`预计 2小时30分钟 · 已专注 1小时5分钟 · 2 项未估时`。
            三段全为 0 时**整行不渲染**（不占位）—— 一个"预计 0分钟"的常驻行只是噪音。
            口径全部来自 lib/budget（只算未完成 + 顶层任务，子任务不重复计）。 */}
        {budgetParts.length > 0 ? (
          <span
            data-testid="today-budget"
            className="basis-full text-label text-ink-3 max-xs:order-4"
          >
            {budgetParts.join(' · ')}
          </span>
        ) : null}
      </div>

      <QuickAdd date={date} today={today} onAdd={actions.addTask} inputRef={quickAddRef} />

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Segmented
          ariaLabel="筛选任务"
          value={mode}
          options={FILTER_OPTIONS}
          onChange={setFilter}
        />
        <label className="sr-only" htmlFor="cat-filter">
          按分类筛选
        </label>
        <select
          id="cat-filter"
          value={category ?? ''}
          onChange={(event) =>
            dispatch({ type: 'SET_FILTER', category: event.target.value || null })
          }
          className="h-11 field px-3 text-body-sm font-medium text-ink"
 >
 <option value="">{TEXT.allCategories}</option>
 {settings.categories.map((item) => (
 <option key={item.id} value={item.name}>
 {item.name}
 </option>
 ))}
 </select>
 {mode === 'all' && !category ? null : (
 <span className="text-label text-ink-2">筛选中 · 只影响显示</span>
        )}
      </div>

      <OverdueSection
        tasks={group.overdue}
        collapsed={overdueCollapsed}
        today={today}
        onToggleCollapse={() => setOverdueCollapsed((prev) => !prev)}
        onMoveAll={actions.moveOverdueToToday}
        /* 逾期行与待办行同款能力（v0.9 议题 2）：▷ 起番茄 + 「专注 N 次」摘要。
           `onRequestFocus` 不存在时整块都不给 —— 与 TaskList 的接法逐字一致。 */
        onStartFocus={onRequestFocus ? actions.startFocus : undefined}
        focusStats={focusStats}
        onToggle={actions.toggleTask}
        onOpen={actions.openTask}
        onDelete={actions.deleteTask}
        onDragStart={drag.onRowPointerDown}
        draggingId={drag.draggingId}
        showCategory={showCategory}
        showTime={showTime}
      />

      {nothingToShow ? (
        <div className="mt-6 card-dashed px-4 py-12 text-center">
          <div className="text-h2 font-bold text-ink-2">
            {hasAny ? TEXT.emptyFiltered : date === today ? TEXT.emptyToday : TEXT.emptyOtherDay}
          </div>
          <div className="mt-2 text-body-sm text-ink-2">
            {hasAny ? TEXT.emptyFilteredHint : TEXT.emptyHint}
          </div>
        </div>
      ) : (
        <TaskList
          group={group}
          collapsed={settings.doneCollapsed}
          mode={mode}
          onToggle={actions.toggleTask}
          onOpen={actions.openTask}
          onDelete={actions.deleteTask}
          onStartFocus={onRequestFocus ? actions.startFocus : undefined}
          focusStats={focusStats}
          onToggleCollapse={onToggleCollapse}
          showCategory={showCategory}
          showTime={showTime}
          onDragStart={drag.onRowPointerDown}
          draggingId={drag.draggingId}
          dropTarget={drag.dropTarget}
          dropDate={date}
          className={group.overdue.length > 0 ? 'mt-3' : 'mt-6'}
        />
      )}
    </section>
  );
}
