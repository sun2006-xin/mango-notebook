import { useMemo, useState, type CSSProperties } from 'react';
import { formatMonthTitle, monthOfKey, shiftMonth } from '../../lib/date';
import { activeHabits, habitCalendar, habitSummaryMap } from '../../lib/habits';
import type { DateKey, Habit, HabitCheck } from '../../types';
import { Icon } from '../common/Icon';

export interface HabitCalendarProps {
  habits: Habit[];
  habitChecks: HabitCheck[];
  /** 周起始日：0 = 周日，1 = 周一（跟随设置里的同一项） */
  weekStart: 0 | 1;
  today: DateKey;
}

const WEEKDAYS_MON = ['一', '二', '三', '四', '五', '六', '日'];
const WEEKDAYS_SUN = ['日', '一', '二', '三', '四', '五', '六'];

/**
 * 习惯日历（F15-B）。
 *
 * 原来只有"连续 N 天" —— 那个数字只记得住最近，看不见"这个月我漏了哪几天"。
 * 而漏在哪天恰恰是最有用的信息：周三总是断？周末全废？一张月历就摊开了。
 *
 * 色深 = 这天打了几个习惯（相对在用的总数）。**0 个不是灰色的"失败"**，
 * 只是一个空格 —— 打卡是给自己看的，不该被做成一张"满屏红叉的刑具"。
 */
export function HabitCalendar({ habits, habitChecks, weekStart, today }: HabitCalendarProps) {
  const [cursor, setCursor] = useState(() => monthOfKey(today));
  const active = activeHabits(habits);
  const current = monthOfKey(today);
  const isCurrentMonth = cursor.year === current.year && cursor.month === current.month;

  /**
   * 每个习惯的「本月天数 + 连续天数」一次算完。
   * 原来在 `map` 里逐个调 `habitMonthCount` + `habitStreak`，每个习惯扫两遍全表；
   * 设置页切一次月份就要付 16 次全扫（8 个习惯）。
   */
  const summary = useMemo(
    () => habitSummaryMap(habitChecks, today, cursor.year, cursor.month),
    [habitChecks, today, cursor.year, cursor.month],
  );

  const days = useMemo(
    () =>
      habitCalendar({
        habits,
        checks: habitChecks,
        year: cursor.year,
        month0: cursor.month,
        weekStart,
        today,
      }),
    [habits, habitChecks, cursor, weekStart, today],
  );

  /** 每格的颜色：0 个 = 空底，达满 = 实色。用 CSS 变量拼 alpha，深浅主题都跟着走 */
  const cellStyle = (ratio: number): CSSProperties | undefined => {
    if (ratio <= 0) return undefined;
    const alpha = 0.18 + 0.72 * Math.min(1, ratio);
    return { backgroundColor: `rgb(var(--rgb-accent) / ${alpha.toFixed(3)})` };
  };

  const labels = weekStart === 1 ? WEEKDAYS_MON : WEEKDAYS_SUN;
  const monthPrefix = `${cursor.year}-${String(cursor.month + 1).padStart(2, '0')}`;

  return (
    <div data-testid="habit-calendar" className="mt-4">
      <div className="flex items-center gap-1">
        <span className="text-label font-semibold text-ink-2">打卡日历</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setCursor((prev) => shiftMonth(prev, -1))}
            aria-label="上一月"
            className="grid h-11 w-11 place-items-center rounded-md text-ink-3 hover:bg-surface-sunk hover:text-ink"
          >
            <Icon name="chevron-left" size={14} />
          </button>
          <span className="tnum text-label font-semibold text-ink">
            {formatMonthTitle(cursor.year, cursor.month)}
          </span>
          <button
            type="button"
            onClick={() => setCursor((prev) => shiftMonth(prev, 1))}
            aria-label="下一月"
            className="grid h-11 w-11 place-items-center rounded-md text-ink-3 hover:bg-surface-sunk hover:text-ink"
          >
            <Icon name="chevron-right" size={14} />
          </button>
          {isCurrentMonth ? null : (
            <button
              type="button"
              onClick={() => setCursor(current)}
              className="btn btn-text h-8 px-2 text-label"
            >
              本月
            </button>
          )}
        </div>
      </div>

      <div className="mt-2 grid grid-cols-7 gap-1">
        {labels.map((label) => (
          <span key={label} className="pb-1 text-center text-label text-ink-3">
            {label}
          </span>
        ))}
        {days.map((day) => (
          <span
            key={day.date}
            data-day={day.date}
            data-done={day.done}
            title={`${day.date} · ${day.done}/${day.total} 个习惯`}
            aria-label={`${day.date} 打卡 ${day.done} 个`}
            style={cellStyle(day.ratio)}
            className={`grid aspect-square place-items-center rounded-sm text-label
              ${day.inMonth ? 'text-ink' : 'text-ink-3 opacity-40'}
              ${day.ratio > 0 ? '' : 'bg-surface-sunk'}
              ${day.isToday ? 'ring-1 ring-accent' : ''}`}
          >
            <span className="tnum">{day.day}</span>
          </span>
        ))}
      </div>

      {/* 每个习惯的本月出勤：回答"哪个习惯在掉链子" */}
      {active.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
          {active.map((habit) => {
            const item = summary.get(habit.id);
            const monthCount = item?.monthCount ?? 0;
            const streak = item?.streak ?? 0;
            return (
              <li key={habit.id} className="text-label text-ink-2">
                <span className="text-ink">{habit.name}</span>
                <span className="tnum"> · 本月 {monthCount} 天</span>
                {streak > 1 ? <span className="tnum"> · 连续 {streak}</span> : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      <p className="mt-2 text-label text-ink-3">
        {`${monthPrefix} · 色深 = 当天打了几个习惯；空格是没有记录，不是失败`}
      </p>
    </div>
  );
}
