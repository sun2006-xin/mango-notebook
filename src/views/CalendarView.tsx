import { useCallback, useMemo } from 'react';
import { MonthGrid, StatusMarker } from '../components/calendar/MonthGrid';
import { Icon } from '../components/common/Icon';
import { STATUS_LABEL, TEXT } from '../constants';
import { useTaskActions } from '../hooks/useTaskActions';
import {
  buildMonthGrid,
  formatDateTitle,
  formatMonthTitle,
  shiftMonth,
  weekdayLabels,
} from '../lib/date';
import {
  compareDoneTasks,
  compareOpenTasks,
  getDayProgress,
  getMonthStatusMap,
  getTasksForDate,
  indexByDate,
} from '../lib/task';
import { useAppDispatch, useAppState } from '../store/StoreContext';
import type { DateKey } from '../types';

export interface CalendarViewProps {
  /** 当前真实今天（App 每 60s 检查跨天） */
  today: DateKey;
}

const LEGEND_ORDER = ['empty', 'none-done', 'partial', 'all-done'] as const;

/**
 * 日历视图（M2-7）：月份标题 + 切月 / 42 格四态网格 / 图例 / 选中日摘要条。
 * 口径（与 M1 一致）：
 * - 展示的月份是 `ui.monthCursor`，**切月不改选中日**（SET_MONTH 只动游标）；
 * - 点格才 SET_SELECTED_DATE（只更新下方摘要，**不跳视图**）；
 * - 「查看当日」才切到今日视图。
 */
export function CalendarView({ today }: CalendarViewProps) {
  const { tasks, settings, ui } = useAppState();
  const dispatch = useAppDispatch();
  const actions = useTaskActions(today);

  const cursor = ui.monthCursor;
  const selected = settings.lastSelectedDate;

  const cells = useMemo(
    () => buildMonthGrid(cursor.year, cursor.month, settings.weekStart, today),
    [cursor.year, cursor.month, settings.weekStart, today],
  );
  const index = useMemo(() => indexByDate(tasks), [tasks]);
  const statusMap = useMemo(() => getMonthStatusMap(index, cells), [index, cells]);
  const progress = useMemo(() => getDayProgress(tasks, selected), [tasks, selected]);

  const summaryTasks = useMemo(() => {
    const all = getTasksForDate(tasks, selected);
    return all
      .filter((task) => !task.done)
      .sort(compareOpenTasks)
      .concat(all.filter((task) => task.done).sort(compareDoneTasks));
  }, [tasks, selected]);

  const shiftMonthBy = useCallback(
    (delta: number) => {
      dispatch({ type: 'SET_MONTH', cursor: shiftMonth(cursor, delta) });
    },
    [cursor, dispatch],
  );

  const onSelect = useCallback(
    (key: DateKey) => {
      dispatch({ type: 'SET_SELECTED_DATE', date: key });
    },
    [dispatch],
  );

  const labels = weekdayLabels(settings.weekStart);
  const shown = summaryTasks.slice(0, 3);
  const rest = summaryTasks.length - shown.length;

  return (
    <section aria-labelledby="calendarTitle" className="flex flex-col">
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <button
            type="button"
            data-testid="calendar-to-week"
            onClick={() => dispatch({ type: 'SET_VIEW', view: 'week' })}
            aria-label="按周查看"
            title="按周查看"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-md text-ink-2 hover:bg-surface hover:text-ink"
          >
            <Icon name="calendar-week" size={18} />
          </button>
          <button
            type="button"
            onClick={() => shiftMonthBy(-1)}
            aria-label="上个月"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-md text-ink-2 hover:bg-surface hover:text-ink"
          >
            <Icon name="chevron-left" />
          </button>
          <h1
            id="calendarTitle"
            data-testid="cal-title"
            className="tnum min-w-0 truncate text-h1 font-bold leading-h1 tracking-[-0.02em] sm:text-date sm:leading-date"
          >
            {formatMonthTitle(cursor.year, cursor.month)}
          </h1>
          <button
            type="button"
            onClick={() => shiftMonthBy(1)}
            aria-label="下个月"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-md text-ink-2 hover:bg-surface hover:text-ink"
          >
            <Icon name="chevron-right" />
          </button>
        </div>
        <button
          type="button"
          onClick={() => dispatch({ type: 'SET_SELECTED_DATE', date: today })}
          className="btn btn-text shrink-0 max-xs:px-2"
        >
          <span className="max-xs:hidden">{TEXT.backToToday}</span>
          <span className="hidden max-xs:inline">今天</span>
        </button>
      </div>

      <div className="mt-5">
        <div className="grid grid-cols-7 gap-2" aria-hidden="true">
          {labels.map((label) => (
            <span
              key={label}
              className="py-1 text-center text-label font-semibold tracking-[0.06em] text-ink-2"
            >
              {label}
            </span>
          ))}
        </div>
        <MonthGrid
          cells={cells}
          statusMap={statusMap}
          selected={selected}
          transitionKey={`${cursor.year}-${cursor.month}`}
          onSelect={onSelect}
        />
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line pt-4">
        {LEGEND_ORDER.map((status) => (
          <span key={status} className="flex items-center gap-2 text-label text-ink-2">
            <StatusMarker status={status} />
            {STATUS_LABEL[status]}
          </span>
        ))}
      </div>

      <div data-testid="day-summary" className="mt-5 card px-4 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="tnum text-body font-bold">{formatDateTitle(selected)}</span>
          <span className="tnum text-label text-ink-2">
            共 {progress.total} 项 · 已完成 {progress.done}
            {progress.percent === null ? '' : ` · ${progress.percent}%`}
          </span>
          <button
            type="button"
            onClick={() => dispatch({ type: 'SET_VIEW', view: 'today' })}
            className="btn btn-text ml-auto h-11 text-label font-semibold tracking-[0.06em]"
          >
            查看当日
            <Icon name="chevron-right" size={14} />
          </button>
        </div>

        {shown.length === 0 ? (
          <p className="mt-3 text-body-sm text-ink-2">这一天还没有任务。</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {shown.map((task) => (
              <li key={task.id} className="flex min-w-0 items-center gap-3 text-body-sm">
                <span
                  className={`h-2.5 w-0.5 shrink-0 rounded-full ${
                    task.priority === 'high' ? 'bg-warn' : 'bg-ink-3'
                  }`}
                  aria-hidden="true"
                />
                <button
                  type="button"
                  onClick={() => actions.openTask(task.id)}
                  className={`min-w-0 flex-1 truncate text-left hover:underline ${
                    task.done ? 'text-ink-3 line-through' : 'text-ink'
                  }`}
                >
                  {task.title}
                </button>
                <span className={`tnum shrink-0 text-label ${task.time ? 'text-ink-2' : 'text-ink-3'}`}>
                  {task.time ?? TEXT.anytime}
                </span>
              </li>
            ))}
          </ul>
        )}
        {rest > 0 ? (
          <p className="mt-3 text-body-sm text-ink-2">还有 {rest} 项，点「查看当日」看全部</p>
        ) : null}
      </div>
    </section>
  );
}
