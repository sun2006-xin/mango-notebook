import { useMemo, useState } from 'react';
import { formatMonthTitle, formatRelativeDay, monthOfKey, shiftMonth } from '../../lib/date';
import { formatFocusDuration } from '../../lib/focus';
import { buildMonthlyReport, monthComparison, monthlyHeadline } from '../../lib/monthly';
import type { DateKey, FocusSession, Task } from '../../types';
import { Icon } from '../common/Icon';

export interface MonthlyReportCardProps {
  tasks: Task[];
  focusSessions: FocusSession[];
  /** 真实今天：决定"回到本月"落在哪，以及相对日期文案 */
  today: DateKey;
}

/**
 * 月报（F14）。
 *
 * 为什么放在设置页而不是新开一个导航档：导航已经有 6 档，
 * 而"回看一个月"是低频动作 —— 低频的东西不该占常驻的导航位。
 * 设置页本来就有「完成率趋势」，月报和它是同一个问题（我到底推进得怎么样）
 * 的两种时间尺度，放在一起读最顺。
 *
 * 刻意不做的事：
 * - 不打分、不给"你应该……"的建议。数据摆出来，结论留给用户。
 * - 空月份不画 0%（`percent === null` 时明说"还没有安排任务"）。
 */
export function MonthlyReportCard({ tasks, focusSessions, today }: MonthlyReportCardProps) {
  const [cursor, setCursor] = useState(() => monthOfKey(today));
  const current = monthOfKey(today);
  const isCurrentMonth = cursor.year === current.year && cursor.month === current.month;

  const report = useMemo(
    () => buildMonthlyReport(tasks, focusSessions, cursor.year, cursor.month),
    [tasks, focusSessions, cursor],
  );
  const headline = useMemo(() => monthlyHeadline(report), [report]);
  /** 环比：和上个月比。上月空白时给一句"这是第一个月"，不硬算百分比 */
  const compare = useMemo(() => monthComparison(report), [report]);
  const compareText = [compare.focus, compare.done].filter(Boolean).join(' · ');
  const top = report.byCategory.slice(0, 5);
  const maxCategoryTotal = top.length > 0 ? Math.max(...top.map((item) => item.total)) : 0;

  return (
    <div data-testid="monthly-report">
      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1">
          <div className="text-body font-semibold">月报</div>
          <div className="mt-1 text-label text-ink-2">按月回看：完成了什么、时间花在哪</div>
        </div>
        <button
          type="button"
          onClick={() => setCursor((prev) => shiftMonth(prev, -1))}
          aria-label="上一月"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-md text-ink-2 hover:bg-surface-sunk hover:text-ink"
        >
          <Icon name="chevron-left" size={16} />
        </button>
        <span
          data-testid="monthly-title"
          className="tnum shrink-0 text-body-sm font-semibold text-ink"
        >
          {formatMonthTitle(cursor.year, cursor.month)}
        </span>
        <button
          type="button"
          onClick={() => setCursor((prev) => shiftMonth(prev, 1))}
          aria-label="下一月"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-md text-ink-2 hover:bg-surface-sunk hover:text-ink"
        >
          <Icon name="chevron-right" size={16} />
        </button>
        {isCurrentMonth ? null : (
          <button
            type="button"
            onClick={() => setCursor(current)}
            className="btn btn-text h-9 shrink-0 px-2 text-label"
          >
            本月
          </button>
        )}
      </div>

      <div className="mt-3 card px-4 py-3">
        {headline.map((line) => (
          <p key={line} className="text-body-sm text-ink">
            {line}
          </p>
        ))}

        {/*
          环比现状：三段取其一
          ① 上月有数据 → 两段文案（专注 / 完成数）
          ② 上月完全空白 → 明说"上月还没有记录"，不拿"无"当"零"算百分比
          ③ 本月也空白 → 什么都不说（headline 已经说了"这个月还没有安排任务"）
        */}
        {compareText ? (
          <p data-testid="monthly-compare" className="mt-1 text-label text-ink-2">
            {compareText}
          </p>
        ) : report.previous === null && report.tasks.total > 0 ? (
          <p data-testid="monthly-compare" className="mt-1 text-label text-ink-3">
            上月还没有记录，这是第一个有数据的月份
          </p>
        ) : null}

        {/* 完成率条：percent 为 null 时整条不画（空月份不该显示 0%） */}
        {report.tasks.percent === null ? null : (
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-sunk">
            <span
              className="block h-full rounded-full bg-accent"
              style={{ width: `${Math.min(100, Math.max(0, report.tasks.percent))}%` }}
            />
          </div>
        )}

        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-label">
          <div>
            <dt className="text-ink-3">有任务的天数</dt>
            <dd className="tnum mt-0.5 text-body-sm font-semibold text-ink">
              {report.activeDays} 天
            </dd>
          </div>
          <div>
            <dt className="text-ink-3">日均专注</dt>
            <dd
              data-testid="monthly-avg-focus"
              className="tnum mt-0.5 text-body-sm font-semibold text-ink"
            >
              {report.focus.activeDays === 0 ? '—' : formatFocusDuration(report.focus.averageMs)}
            </dd>
          </div>
          <div>
            <dt className="text-ink-3">完成最多的一天</dt>
            <dd className="mt-0.5 text-body-sm font-semibold text-ink">
              {report.bestDay
                ? `${formatRelativeDay(report.bestDay.date, today)} · ${report.bestDay.done} 项`
                : '—'}
            </dd>
          </div>
          <div>
            <dt className="text-ink-3">最专注的一天</dt>
            <dd className="mt-0.5 text-body-sm font-semibold text-ink">
              {report.bestFocusDay
                ? `${formatRelativeDay(report.bestFocusDay.date, today)} · ${formatFocusDuration(
                    report.bestFocusDay.ms,
                  )}`
                : '—'}
            </dd>
          </div>
        </dl>

        {/* 分类分布：按完成数排序，条长按"该分类任务数"归一 */}
        {top.length > 0 ? (
          <div className="mt-4" data-testid="monthly-categories">
            <div className="text-label font-semibold text-ink-2">分类</div>
            <ul className="mt-2 flex flex-col gap-1.5">
              {top.map((item) => (
                <li key={item.category} className="flex items-center gap-2">
                  <span className="w-16 shrink-0 truncate text-label text-ink">{item.category}</span>
                  <span className="flex h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-sunk">
                    <span
                      className="block h-full rounded-full bg-accent"
                      style={{
                        width: `${maxCategoryTotal === 0 ? 0 : Math.round((item.total / maxCategoryTotal) * 100)}%`,
                      }}
                    />
                  </span>
                  <span className="tnum w-14 shrink-0 text-right text-label text-ink-2">
                    {item.done}/{item.total}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}
