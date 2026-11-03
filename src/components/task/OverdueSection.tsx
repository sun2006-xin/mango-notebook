import { useCallback, useMemo, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { formatRelativeDay } from '../../lib/date';
import { taskLastDate } from '../../lib/task';
import { sliceForPreview } from '../../lib/listSlice';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import type { TaskFocusStat } from '../../lib/focus';
import type { DateKey, Task } from '../../types';
import { Icon } from '../common/Icon';
import { TaskRow } from './TaskRow';

export interface OverdueSectionProps {
  tasks: Task[];
  collapsed: boolean;
  today: DateKey;
  onToggleCollapse: () => void;
  /** 批量「移到今天」（可撤销） */
  onMoveAll: () => void;
  /**
   * 「开始专注」（F2）。不传 = 整块逾期区都不出现 ▷。
   *
   * ⚠️ 与 TaskList **完全同款机制**（主理人裁定：一处能力，两条入口）：
   * - 用 `useCallback` 稳住 handler（TaskRow 是 memo 的）；
   * - 移动端（<640）**不传** —— 触屏没有 hover，那个悬浮按钮点不到，
   *   入口改走任务抽屉底部的「开始专注」（见 TaskDrawer 的 drawer-start-focus）。
   * 两个细节都别自己发明：漏了第一条会整列失去 memo 意义，漏了第二条
   * 会在手机上渲染出一个"看得见但点不到"的按钮。
   */
  onStartFocus?: (taskId: string) => void;
  /** 按任务的专注累计（行内「专注 N 次 · X 分钟」）；不传则不显示 */
  focusStats?: Map<string | null, TaskFocusStat>;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  showCategory?: boolean;
  showTime?: boolean;
  /**
   * 拖拽起点（引用稳定）。逾期行**能拖但不能被插** ——
   * 它们归属的是过去的日子，那些日子不是落点容器，
   * 所以这里不传 `dropRow`：拖起来之后只会落到"今天"的待办段里。
   */
  onDragStart?: (event: ReactPointerEvent<HTMLElement>) => void;
  draggingId?: string | null;
}

/**
 * 逾期区（§8.2 R2，用户 M1 拍板）：轻文字行，**无卡片底 / 无描边 / 无阴影**。
 * 标题行 = warn 6px 圆点 + 「逾期 N 项」+ 右侧「移到今天」文字按钮 + 折叠箭头；
 * 任务行与待办行同款 TaskRow（density=default），时间列显示「昨天 09:00」这类原日期文字。
 * tasks 为空时**整块不渲染**（由调用方保证），因此不会占位。
 *
 * 逾期行同样是**未完成 + 顶层**的真实任务，所以行内的 ▷（开始专注）与
 * 「专注 N 次」在逾期区里必须同样可用 —— 用户从"昨天没做完的事"直接开一个
 * 番茄钟，是最自然的一条路径（v0.9 议题 2）。
 */
/** 拿不到 handler 时的兜底（模块级常量：引用稳定，不破坏 TaskRow 的 memo） */
const noop = (): void => {
  /* 理论上不会走到：tasks 与 rowHandlers 由同一份数组生成 */
};

export function OverdueSection({
  tasks,
  collapsed,
  today,
  onToggleCollapse,
  onMoveAll,
  onStartFocus,
  focusStats,
  onToggle,
  onOpen,
  onDelete,
  showCategory = true,
  showTime = true,
  onDragStart,
  draggingId,
}: OverdueSectionProps) {
  const { isMobile } = useBreakpoint();
  /**
   * 默认只铺前几条。
   *
   * 逾期区在清单**上方**，攒了一周的欠账会把它撑成半屏，把今天要做的事顶下去 ——
   * 而"昨天没做完的 12 条"这个数字本身，比逐条读一遍更有用。
   * 所以先给数字 + 前 3 条，要看得自己点开。
   */
  const [showAll, setShowAll] = useState(false);
  /**
   * 截断规则抽到 `lib/listSlice.ts` 了（纯函数，可单测）。
   * 三个边界以前只藏在 JSX 上方三行里：刚好 N 条不算溢出、少于 N 条时
   * overflow 不能是负数（否则按钮显示"还有 -1 条"）、展开后要显示全部。
   */
  const { visible: visibleTasks, overflow } = sliceForPreview(tasks, showAll);

  /** 与 TaskList 同款：先 useCallback 稳引用，再按移动端裁掉（详见 props 注释） */
  const handleStartFocus = useCallback(
    (id: string) => {
      onStartFocus?.(id);
    },
    [onStartFocus],
  );
  const startFocusHandler = onStartFocus && !isMobile ? handleStartFocus : undefined;

  /**
   * 按 id **预建**每行要用的回调（同 `WeekView` 的 `rowHandlers`）。
   *
   * 直接在 JSX 里写 `onToggle={() => onToggle(task.id)}` 会每渲一次就造一个新函数，
   * 而 `TaskRow` 是 `memo` 的 —— 逐行比对必然失败，等于把 memo 整个废掉。
   * 逾期区恰恰是最常被重渲的一块（`TodayView` 订阅整份 state，勾一个框、
   * 改一个字、拖拽时每一次落点变化都会重渲），十几二十行全部重画。
   */
  const rowHandlers = useMemo(
    () =>
      new Map(
        tasks.map((task) => [
          task.id,
          {
            focus: startFocusHandler ? () => startFocusHandler(task.id) : undefined,
            toggle: () => onToggle(task.id),
            open: () => onOpen(task.id),
            remove: () => onDelete(task.id),
          },
        ]),
      ),
    [tasks, startFocusHandler, onToggle, onOpen, onDelete],
  );

  if (tasks.length === 0) return null;

  return (
    <section aria-label="逾期任务" className="mt-6 border-b border-line pb-2">
      <div className="flex items-center gap-2 pl-1">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" aria-hidden="true" />
        <span
          data-testid="overdue-count"
          className="tnum text-label font-semibold tracking-[0.06em] text-warn"
        >
          逾期 {tasks.length} 项
        </span>
        <button
          type="button"
          onClick={onMoveAll}
          className="btn btn-text ml-auto h-11 text-label font-semibold tracking-[0.06em] hover:text-warn"
        >
          移到今天
        </button>
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-expanded={!collapsed}
          aria-label={collapsed ? '展开逾期任务' : '收起逾期任务'}
          className="grid h-11 w-11 place-items-center rounded-sm text-ink-2 hover:bg-surface hover:text-ink"
        >
          <Icon
            name="chevron-down"
            className={`transition-transform duration-short ease-standard ${
              collapsed ? '-rotate-90' : ''
            }`}
          />
        </button>
      </div>

      {collapsed ? null : (
        <div className="divide-y divide-line">
          {visibleTasks.map((task) => {
            const h = rowHandlers.get(task.id);
            return (
            <TaskRow
              key={task.id}
              task={task}
              isSticky={false}
              showCategory={showCategory}
              showTime={showTime}
              /* 逾期按**最后一天**算（多天任务从第 2 天起就算逾期等于逼人拆任务），
                 所以这里显示的也必须是最后一天，否则「昨天」会其实是「上周」 */
              timeLabel={
                formatRelativeDay(taskLastDate(task), today) + (task.time ? ` ${task.time}` : '')
              }
              // 未完成 / 非子任务这两个条件由 TaskRow 自己把（focusable 判定），
              // 所以这里只需要把 handler 传下去 —— 逾期区内永远是未完成的任务。
              onStartFocus={h?.focus}
              focusSummary={focusStats?.get(task.id)}
              onToggle={h?.toggle ?? noop}
              onOpen={h?.open ?? noop}
              onDelete={h?.remove ?? noop}
              onDragStart={onDragStart}
              isDragging={draggingId === task.id}
            />
            );
          })}
          {overflow > 0 ? (
            <button
              type="button"
              data-testid="overdue-more"
              onClick={() => setShowAll((prev) => !prev)}
              className="btn btn-text h-11 w-full text-label font-semibold text-ink-2"
            >
              {showAll ? '收起' : `还有 ${overflow} 条逾期`}
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}
