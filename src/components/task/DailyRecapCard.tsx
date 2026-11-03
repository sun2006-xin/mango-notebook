import { memo, useMemo } from 'react';
import { formatDateTitle } from '../../lib/date';
import {
  buildDailyRecap,
  hasTrend,
  recapDate,
  recapLines,
  recapTrend,
  shouldShowRecap,
  todayOutlook,
} from '../../lib/recap';
import { useAppDispatch, useAppState } from '../../store/StoreContext';
import type { DateKey } from '../../types';
import { Icon } from '../common/Icon';

export interface DailyRecapCardProps {
  /** 真实今天（App 统一传入） */
  today: DateKey;
}

/**
 * 每日收尾卡（F15-A）。
 *
 * 它回答的问题不是"我今天打卡了吗"，而是"**我昨天到底推进了什么**"——
 * 这个问题在备考期最容易丢，而且只能从数据里捞，靠手点签到签不出来。
 *
 * 四条约束：
 * - **一天只出现一次**（`settings.lastRecapSeen` 记住被回顾的那一天）。
 *   不记的话每次刷新都再弹一遍，用户第二天早上会被同一张卡拦住三次。
 * - 昨天三样全空 → 整块不渲染（"完成 0/0 项"只是提醒人失败）。
 * - 不评价、不打分：数据摆出来就够。
 * - 顺手承接今天：待办几项、逾期几项，一眼看到"接下来要做什么"。
 */
export const DailyRecapCard = memo(function DailyRecapCard({ today }: DailyRecapCardProps) {
  const { tasks, focusSessions, settings } = useAppState();
  const dispatch = useAppDispatch();

  const date = recapDate(today);
  /**
   * `memo` 挡不住 Context：这个组件内部 `useAppState()`，于是今日页每次重渲
   * （勾一个框、拖一次拽、抽屉里改一个字）都会重跑一遍回顾计算 ——
   * `buildDailyRecap` 内部对 tasks / focusSessions / habitChecks 各做多次全表
   * filter，`recapTrend` 又是 7 次 `getTasksForDate`（每次 filter + sort）。
   * 合计十几次全表遍历，而这段内容一天只需要变一次。
   */
  const recap = useMemo(
    () =>
      buildDailyRecap({
        tasks,
        focusSessions,
        habits: settings.habits,
        habitChecks: settings.habitChecks,
        date,
        today,
      }),
    [tasks, focusSessions, settings.habits, settings.habitChecks, date, today],
  );
  /**
   * 显示与否**只有这一个判据**（在 lib/recap 里，有用例守着）：
   * 已经看过这一天 → 不打扰；昨天三样全空 → 也不显示。
   * 别在这里再补一个 `if (lastRecapSeen === date) return null` ——
   * 两份判断迟早会走岔（一份改了另一份没改）。
   */
  const show = shouldShowRecap(recap, settings.lastRecapSeen);
  /**
   * 趋势以**回顾日**结尾（不是今天）：这张卡讲的是"昨天之前这一周"，把今天
   * 算进去等于拿半天数据跟满勤的日子比。
   *
   * ⚠️ 钩子必须在下面那个 early return **之前**算（不能写在条件后面），
   * 所以把"要不要显示"并进依赖里：不显示时返回空数组，连 7 次全表扫描都省了。
   */
  const trend = useMemo(() => (show ? recapTrend(tasks, date, 7) : []), [show, tasks, date]);

  if (!show) return null;

  const lines = recapLines(recap);
  const showTrend = hasTrend(trend);
  const trendDone = trend.reduce((sum, point) => sum + point.done, 0);
  const trendTotal = trend.reduce((sum, point) => sum + point.total, 0);

  return (
    <div
      data-testid="daily-recap"
      className="mb-4 card px-4 py-3"
    >
      <div className="flex items-center gap-2">
        <span className="text-label font-semibold tracking-[0.06em] text-ink-2">昨日回顾</span>
        <span className="tnum text-label text-ink-3">{formatDateTitle(date)}</span>
        <button
          type="button"
          onClick={() => dispatch({ type: 'SET_RECAP_SEEN', date })}
          aria-label="知道了，关闭昨日回顾"
          className="ml-auto grid h-11 w-11 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-surface-sunk hover:text-ink"
        >
          <Icon name="close" size={14} />
        </button>
      </div>

      {lines.map((line) => (
        <p key={line} data-testid="daily-recap-line" className="mt-1.5 text-body-sm text-ink">
          {line}
        </p>
      ))}

      {/* 最近 7 天完成率：柱子高度 = 完成率，空槽 = 那天没安排任务（不是 0 分） */}
      {showTrend ? (
        <div className="mt-2.5" data-testid="daily-recap-trend">
          <div className="flex items-baseline justify-between">
            <span className="text-label text-ink-3">最近 7 天</span>
            <span className="tnum text-label text-ink-2">
              {trendDone} / {trendTotal} 项
            </span>
          </div>
          <div
            className="mt-1 flex h-9 items-end gap-1"
            role="img"
            aria-label={`最近 7 天完成率：${trend
              .map((point) => (point.total === 0 ? '未安排' : `${Math.round(point.ratio * 100)}%`))
              .join('，')}`}
          >
            {trend.map((point, index) => {
              const isLast = index === trend.length - 1;
              // 空槽留 2px 的底（看得出"这天存在"，但不高过任何真实数据）
              const height = point.total === 0 ? 2 : Math.max(4, Math.round(point.ratio * 36));
              return (
                <div
                  key={point.date}
                  data-testid="daily-recap-bar"
                  className={`min-w-0 flex-1 rounded-sm ${
                    point.total === 0
                      ? 'bg-line'
                      : isLast
                        ? 'bg-accent'
                        : 'bg-accent/35'
                  }`}
                  style={{ height: `${height}px` }}
                />
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-line pt-2">
        <span data-testid="daily-recap-today" className="text-label text-ink-2">
          {todayOutlook(recap)}
        </span>
        <button
          type="button"
          data-testid="daily-recap-open"
          onClick={() => dispatch({ type: 'SET_SELECTED_DATE', date })}
          className="btn btn-text ml-auto h-8 shrink-0 px-2 text-label"
        >
          回看这一天
        </button>
      </div>
    </div>
  );
});
