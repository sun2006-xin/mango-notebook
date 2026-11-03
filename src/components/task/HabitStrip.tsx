import { memo, useMemo } from 'react';
import { useAppDispatch, useAppState } from '../../store/StoreContext';
import { activeHabits, checkedHabitIds, habitDayProgress, habitStreakMap } from '../../lib/habits';
import type { DateKey } from '../../types';
import { Icon } from '../common/Icon';

export interface HabitStripProps {
  /** 真实今天（App 统一传入）。习惯打卡只记在"今天"，不跟随 ←/→ 翻日 */
  today: DateKey;
}

/**
 * 今日页的习惯打卡条（F12）。
 *
 * 三个刻意的克制：
 * - **没有习惯时整块不渲染**（一个像素都不占）——和复习横幅同一条规矩。
 * - **只记今天**：`date` 用 `today` 而不是当前选中日。翻到前天再点一下，
 *   会把今天的打卡写到前天，污染历史（作息打卡踩过这个坑）。
 * - 断了一天不催、不标红、不给"失败"字样。打卡是给自己看的，不是被记账。
 *
 * 做成 chip 而不是列表行：习惯是"一天一次的二值事"，占一整行会把
 * 任务清单挤下去 —— 而任务才是这个应用的主体。
 */
export const HabitStrip = memo(function HabitStrip({ today }: HabitStripProps) {
  const { settings } = useAppState();
  const dispatch = useAppDispatch();

  const habits = activeHabits(settings.habits);
  /**
   * 连续天数一次算完（`useMemo` 必须在下面那个 early return **之前** ——
   * 钩子不能写在条件后面）。原来是在 `map` 里逐个 `habitStreak`，
   * 每个习惯都把几千条打卡流水过滤一遍；今日页每勾一次任务就要付一次。
   */
  const streaks = useMemo(
    () => habitStreakMap(settings.habitChecks, today),
    [settings.habitChecks, today],
  );

  if (habits.length === 0) return null;

  const done = checkedHabitIds(settings.habitChecks, today);
  const progress = habitDayProgress(settings.habits, settings.habitChecks, today);

  return (
    <div
      data-testid="habit-strip"
      className="mb-4 flex w-full flex-wrap items-center gap-2 card px-4 py-2.5"
    >
      <span className="text-label text-ink-2">习惯</span>
      <span data-testid="habit-progress" className="tnum text-label font-semibold text-ink-3">
        {progress.done}/{progress.total}
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
        {habits.map((habit) => {
          const checked = done.has(habit.id);
          const streak = streaks.get(habit.id) ?? 0;
          return (
            <button
              key={habit.id}
              type="button"
              data-testid={`habit-${habit.id}`}
              data-checked={checked ? 'true' : undefined}
              aria-pressed={checked}
              aria-label={`${checked ? '取消打卡' : '打卡'}：${habit.name}${
                streak > 0 ? `，连续 ${streak} 天` : ''
              }`}
              title={streak > 0 ? `连续 ${streak} 天` : undefined}
              onClick={() =>
                dispatch({ type: 'HABIT_TOGGLE_CHECK', habitId: habit.id, date: today })
              }
              className={`inline-flex h-8 items-center gap-1 rounded-full border px-3 text-label font-semibold
                transition-colors duration-short ease-standard
                ${
                  checked
                    ? 'border-accent bg-accent-soft text-accent'
                    : 'border-line bg-paper text-ink-2 hover:border-accent/40 hover:text-ink'
                }`}
            >
              {checked ? <Icon name="check" size={12} /> : null}
              <span className="max-w-24 truncate">{habit.name}</span>
              {streak > 1 ? (
                <span className="tnum shrink-0 text-ink-3">{streak}</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
});
