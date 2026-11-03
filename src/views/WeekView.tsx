import { useCallback, useMemo } from 'react';
import { Icon } from '../components/common/Icon';
import { ProgressBar } from '../components/common/ProgressBar';
import { TaskRow } from '../components/task/TaskRow';
import { TEXT, WEEK_MAX_ROWS } from '../constants';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { useTaskActions } from '../hooks/useTaskActions';
import { useTaskDrag } from '../hooks/useTaskDrag';
import { buildWeekDays, formatWeekTitle, startOfWeek, weekdayLabels } from '../lib/date';
import { buildWeekColumns } from '../lib/task';
import { countWeekPlanItems, weekPlanToTasks } from '../lib/weekPlan';
import { nowIso } from '../lib/date';
import { useToast } from '../hooks/useToast';
import { TOAST_TIMEOUT } from '../constants';
import { useAppDispatch, useAppState } from '../store/StoreContext';
import type { DateKey } from '../types';

export interface WeekViewProps {
  /** 当前真实今天（App 每 60s 检查跨天） */
  today: DateKey;
}

/**
 * 周视图（M2-9）：
 * - ≥1024：7 列横排，列头 = 周几 + 日号（列序与 weekdayLabels 同源）
 * - 768–1023：仍 7 列，列宽压缩、字号降级、`showTime=false`（只留高优先级竖条）
 * - <768：竖向堆叠，严禁横向滚动
 * 列内**复用** `<TaskRow density="compact" />`（§11 第 4 条唯一实现）。
 * 列高：grid `items-stretch` 让所有列等高 + 列上 `min-h-week-col` 兜底 + 列底 `mt-auto`。
 */
/**
 * 行回调的兜底（模块级、引用恒定）。
 * `rowHandlers` 是按 `column.tasks` 建的，遍历的是同一批 task，理论上不会取空；
 * 但类型上 `Map.get` 是 `| undefined`，兜底必须**引用稳定** ——
 * 写成 `?? (() => {})` 就又变回每次渲染新建函数，memo 白包。
 */
const NOOP = (): void => undefined;

export function WeekView({ today }: WeekViewProps) {
  const { tasks, settings } = useAppState();
  const dispatch = useAppDispatch();
  const actions = useTaskActions(today);
  const breakpoints = useBreakpoint();
  /**
   * 拖拽（改日期）：**整列都是落点**，不只是任务区。
   * 只把任务区做成落点的话，往一个空列上拖会落空 ——
   * 而"把事情挪到还没排任务的那天"恰恰是最常用的动作。
   */
  const drag = useTaskDrag(today);

  const days = useMemo(
    () => buildWeekDays(settings.lastSelectedDate, settings.weekStart),
    [settings.lastSelectedDate, settings.weekStart],
  );
  const columns = useMemo(
    () => buildWeekColumns(tasks, days, today, settings.lastSelectedDate, WEEK_MAX_ROWS),
    [tasks, days, today, settings.lastSelectedDate],
  );
  const labels = weekdayLabels(settings.weekStart);
  const weekTotal = columns.reduce((sum, column) => sum + column.progress.total, 0);

  const startKey = days[0] as DateKey;
  const endKey = days[6] as DateKey;
  const isCurrentWeek = startKey === startOfWeek(today, settings.weekStart);

  /**
   * 每行的三个回调**按 task id 缓存**。
   *
   * 为什么不能直接写 `onToggle={() => actions.toggleTask(task.id)}`：
   * `TaskRow` 是 memo 的，内联箭头每次渲染都是新函数 → 父级（周视图）一重渲，
   * 整周几十行全部重渲，memo 等于白包。
   *
   * 缓存的生命周期挂在 `columns` 上：换周 / 改任务会重建（不会无限增长），
   * 而 `actions.*` 本身是稳定引用（useTaskActions 里读 tasks 走 ref），
   * 所以同一批行在普通重渲里拿到的是**同一批函数**。
   */
  const rowHandlers = useMemo(() => {
    const map = new Map<string, { toggle: () => void; open: () => void; remove: () => void }>();
    for (const column of columns) {
      for (const task of column.tasks) {
        map.set(task.id, {
          toggle: () => actions.toggleTask(task.id),
          open: () => actions.openTask(task.id),
          remove: () => actions.deleteTask(task.id),
        });
      }
    }
    return map;
  }, [columns, actions.toggleTask, actions.openTask, actions.deleteTask]);

  const gotoDay = useCallback(
    (key: DateKey) => {
      dispatch({ type: 'SET_SELECTED_DATE', date: key });
      dispatch({ type: 'SET_VIEW', view: 'today' });
    },
    [dispatch],
  );

  // 768–1023 隐藏时间（列宽只有约 100，时间会把标题挤到 2~3 个字）
  const showTime = !breakpoints.isTablet;

  /* ---------- 周计划模板（F3） ---------- */

  const toast = useToast();
  const weekPlanTotal = useMemo(
    () => countWeekPlanItems(settings.weekPlanTemplate),
    [settings.weekPlanTemplate],
  );
  /**
   * 这一周还能展开几条（幂等：已经在同一天存在同标题同分类的任务不算）。
   * 用纯函数先算一遍，按钮上直接显示"会加几条" —— 点下去之前就知道结果。
   */
  /**
   * 只套用**今天及以后**的那几天。
   *
   * 模板是"排下周/本周剩余"，而 `days` 是整周 7 天（含已经过完的）。
   * 不过滤的话，周四点一下会把任务填进周一~周三 —— 那几条一出生就是逾期，
   * 用户第二天打开会看到"3 项逾期"，还以为是模板算错了。
   */
  const planDays = useMemo(() => days.filter((day) => day >= today), [days, today]);
  const planPending = useMemo(
    () => weekPlanToTasks(settings.weekPlanTemplate, planDays, tasks).length,
    [settings.weekPlanTemplate, planDays, tasks],
  );

  const applyWeekPlan = useCallback(() => {
    dispatch({ type: 'WEEK_PLAN_APPLY', days: planDays, now: nowIso() });
    toast.show(
      planPending > 0 ? `已按模板添加 ${planPending} 条任务` : '这一周已经按模板排过了',
      null,
      TOAST_TIMEOUT.info,
    );
  }, [dispatch, planDays, planPending, toast]);

  return (
    <section aria-labelledby="weekTitle" className="flex flex-col">
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <button
            type="button"
            onClick={() => dispatch({ type: 'SHIFT_WEEK', delta: -1 })}
            aria-label="上一周"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-md text-ink-2 hover:bg-surface hover:text-ink"
          >
            <Icon name="chevron-left" />
          </button>
          <h1
            id="weekTitle"
            data-testid="week-title"
            className="tnum min-w-0 truncate text-h1 font-bold leading-h1 tracking-[-0.02em] sm:text-date sm:leading-date"
          >
            {formatWeekTitle(startKey, endKey)}
          </h1>
          <button
            type="button"
            onClick={() => dispatch({ type: 'SHIFT_WEEK', delta: 1 })}
            aria-label="下一周"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-md text-ink-2 hover:bg-surface hover:text-ink"
          >
            <Icon name="chevron-right" />
          </button>
        </div>
        {/*
          周 ⇄ 月（v0.29.5）：日历不再是底部 Tab 里的第 4 个格子。
          它本来就是"周"的缩放层级 —— 同一件事换个粒度看，所以做成这里的切换。
          只放图标：这一行在 320px 上已经很挤（标题 + 前后周 + 套用模板 + 本周）。
        */}
        <button
          type="button"
          data-testid="week-to-calendar"
          onClick={() => dispatch({ type: 'SET_VIEW', view: 'calendar' })}
          aria-label="按月查看"
          title="按月查看"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-md text-ink-2 hover:bg-surface hover:text-ink"
        >
          <Icon name="calendar" size={18} />
        </button>
        {/* 套用模板（F3）：只在配过模板时出现，并直接显示会加几条 */}
        {weekPlanTotal > 0 ? (
          <button
            type="button"
            data-testid="week-plan-apply"
            onClick={applyWeekPlan}
            disabled={planPending === 0}
            className="btn btn-outlined shrink-0 max-xs:px-2 disabled:opacity-40"
            title={
              planPending === 0
                ? '这周剩余的日子已经按模板排过了'
                : `会添加到今天及以后，共 ${planPending} 条`
            }
          >
            {planPending > 0 ? `套用模板（${planPending}）` : '已套用'}
          </button>
        ) : null}
        {isCurrentWeek ? null : (
          <button
            type="button"
            onClick={() => dispatch({ type: 'SET_SELECTED_DATE', date: today })}
            className="btn btn-text shrink-0 max-xs:px-2"
          >
            <span className="max-xs:hidden">{TEXT.backToToday}</span>
            <span className="hidden max-xs:inline">本周</span>
          </button>
        )}
      </div>

      <div
        data-testid="week-grid"
        className="mt-5 grid items-stretch gap-2 md:grid-cols-7 md:gap-1 lg:gap-2"
      >
        {columns.map((column, index) => (
          <div
            key={column.key}
            data-day={column.key}
            data-today={column.isToday ? 'true' : undefined}
            data-drop-day={column.key}
            className={`flex min-w-0 flex-col gap-2 border-line md:min-h-week-col
              md:rounded-lg md:border md:bg-surface md:p-2
              ${
                column.isToday
                  ? /* 手机端：今天是一张强调卡片，与其它天的分隔线区分开 */
                    'max-md:rounded-lg max-md:border max-md:border-accent/40 max-md:bg-surface max-md:p-2 max-md:shadow-1'
                  : /* 手机端：非今天只留分隔线 */
                    'max-md:border-b'
              } ${column.isEmpty ? 'max-md:pb-1' : 'max-md:pb-3'}
              ${drag.dropTarget?.date === column.key ? 'ring-2 ring-accent/45' : ''}`}
          >
            <button
              type="button"
              onClick={() => gotoDay(column.key)}
              aria-label={`${labels[index]} ${column.day} 日，查看当日`}
              className={`flex min-w-0 flex-col items-start rounded-md border p-1 text-left
                transition-colors duration-short ease-standard hover:bg-surface-sunk
                max-md:flex-row max-md:items-baseline max-md:gap-2 max-md:border-0
                ${column.isToday ? 'border-accent' : 'border-transparent'} ${
                  column.isSelected ? 'cal-selected' : ''
                } ${column.isToday ? 'max-md:shadow-none' : ''}`}
            >
              <span
                className={`text-label font-semibold tracking-[0.06em] ${
                  column.isToday ? 'text-accent' : 'text-ink-2'
                }`}
              >
                {labels[index]}
              </span>
              <span
                className={`tnum text-h2 font-bold leading-none md:text-body lg:text-h2 ${
                  column.isToday ? 'text-accent' : 'text-ink'
                }`}
              >
                {column.day}
              </span>
              {/* 手机端空日压缩成一行：计数跟在列头后面，不再单独占三段 */}
              {column.isEmpty ? (
                <span className="tnum ml-auto text-label text-ink-3 md:hidden">
                  {column.progress.done}/{column.progress.total}
                </span>
              ) : null}
            </button>

            <div className="flex min-w-0 flex-1 flex-col gap-1">
              {column.tasks.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  isSticky={false}
                  density="compact"
                  showTime={showTime}
                  onToggle={rowHandlers.get(task.id)?.toggle ?? NOOP}
                  onOpen={rowHandlers.get(task.id)?.open ?? NOOP}
                  onDelete={rowHandlers.get(task.id)?.remove ?? NOOP}
                  /* 周视图里只改日期，不做列内排序（列里还有"+N 条"折叠，
                     插入位说不清），所以不传 dropRow */
                  onDragStart={drag.onRowPointerDown}
                  isDragging={drag.draggingId === task.id}
                />
              ))}
              {column.overflow > 0 ? (
                <button
                  type="button"
                  onClick={() => gotoDay(column.key)}
                  className="tnum self-start rounded-sm px-1 py-1 text-label font-semibold text-ink-2 hover:bg-accent-soft hover:text-accent"
                >
                  +{column.overflow} 条
                </button>
              ) : null}
              {column.isEmpty ? (
                <span
                  className="max-md:hidden px-1 pt-1 text-body-sm text-ink-3 opacity-55"
                  aria-hidden="true"
                >
                  —
                </span>
              ) : null}
            </div>

            {/* 手机端空日不显示进度条（已在列头行内给出 0/0），减少空日的视觉噪音 */}
            <div
              className={`mt-auto flex items-center gap-2 border-t border-line pt-2 ${
                column.isEmpty ? 'max-md:hidden' : ''
              }`}
            >
              <span className="tnum shrink-0 text-label font-semibold text-ink-2">
                {column.progress.done}/{column.progress.total}
              </span>
              <div className="min-w-0 flex-1">
                <ProgressBar
                  done={column.progress.done}
                  total={column.progress.total}
                  percent={column.progress.percent}
                  size="xs"
                  ariaLabel={`${labels[index]} ${column.day} 日完成度`}
                />
              </div>
            </div>
          </div>
        ))}
      </div>

      {weekTotal === 0 ? (
        <p className="mt-6 text-center text-body-sm text-ink-2">{TEXT.weekEmpty}</p>
      ) : null}
    </section>
  );
}
