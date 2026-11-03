import { memo } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { TEXT } from '../../constants';
import { formatTime } from '../../lib/date';
import { taskLastDate, taskSpanDays } from '../../lib/task';
import { useSwipe } from '../../hooks/useSwipe';
import type { Task, TaskDensity } from '../../types';
import { Checkbox } from '../common/Checkbox';
import { Icon } from '../common/Icon';

export interface TaskRowProps {
  task: Task;
  /** 本次会话刚勾选、需要「原地停留」的项 */
  isSticky: boolean;
  /** 响应式开关：<420 由父级传 false（隐藏分类 Chip）；默认 true */
  showCategory?: boolean;
  /** 响应式开关：<360 或 768–1023 的周列传 false（只留高优先级竖条）；默认 true */
  showTime?: boolean;
  /** 'default' = 48 行高（今日视图/逾期区）；'compact' = 40（周列内，标题在上时间在下） */
  density?: TaskDensity;
  /** 时间列文案覆盖：逾期区传「昨天 09:00」类原日期文字 */
  timeLabel?: string;
  /** 子任务行：左侧缩进 + 去掉高优先级竖条的位置冲突 */
  indent?: boolean;
  /** 父任务行上的小进度（'2/5'）；total=0 时不显示 */
  subtaskProgress?: { done: number; total: number };
  /**
   * 「开始专注」（F2）。**不传就不渲染那个 ▷** —— 由父级决定给不给这个能力
   * （周视图的 compact 行、移动端都不传，入口改走抽屉）。
   */
  onStartFocus?: () => void;
  /** 这条任务累计的专注（>0 且非 compact 时才显示「专注 N 次 · X分钟」） */
  focusSummary?: { count: number; ms: number };
  onToggle: () => void;
  onOpen: () => void;
  onDelete: () => void;
  /**
   * 拖拽起点（**引用必须稳定**，否则 memo 失效）。
   * 传了 = 这一行可以拖；不传 = 拖不动（子任务行就走这条）。
   * 任务 id 由 hook 从 DOM 的 `data-drag-id` 上读，不经过闭包。
   */
  onDragStart?: (event: ReactPointerEvent<HTMLElement>) => void;
  /**
   * 这一行是否参与"插到它前面"的落点判定。
   *
   * 今日视图的待办段传 true（要能排序）；周视图传 **false** ——
   * 那里一列只显示前 4 条还有"+N 条"折叠，插入位的意义说不清，
   * 拖过去就只做"改到这一天"，保持那天的自动排序。
   */
  dropRow?: boolean;
  /** 正被拖着 → 半透明 + 抬起来 */
  isDragging?: boolean;
  /** 落点正好在它前面 → 顶部画一条强调线 */
  dropBefore?: boolean;
}

/**
 * 任务行 —— **全站唯一实现**（§11 第 4 条）。
 * 今日视图、逾期区、周视图三处共用，差异只能通过
 * density / showCategory / showTime / timeLabel 四个开关表达。
 *
 * 一行布局（default）：勾选框(44 热区) | 标题(单行省略) | 时间(右对齐 tabular) | 分类 Chip，
 * 高优先级在行最左缘多一条 3px 竖条；hover 时行尾浮出「…」。
 * compact：勾选框与两行文字并排（标题在上、时间在下），行高 40，无 Chip/无「…」。
 *
 * 键位（Space/Enter/Delete）统一由 useKeyboard 按 activeElement 分派，
 * 所以这里不挂 onKeyDown，避免与全局键盘重复处理。
 */
export const TaskRow = memo(function TaskRow({
  task,
  isSticky,
  showCategory = true,
  showTime = true,
  density = 'default',
  timeLabel,
  indent = false,
  subtaskProgress,
  onStartFocus,
  focusSummary,
  onToggle,
  onOpen,
  onDragStart,
  dropRow = false,
  isDragging = false,
  dropBefore = false,
}: TaskRowProps) {
  const compact = density === 'compact';
  const done = task.done;
  const time = timeLabel ?? formatTime(task.time);
  /**
   * ▷ 的显示条件（缺一不可）：
   * - 顶层任务（子任务是"步骤"，给它单独开番茄钟没有意义）；
   * - 未完成（已经做完的事不需要再专注）；
   * - default 密度（compact 行高 40，塞不下第三个悬浮按钮）；
   * - 父级传了 onStartFocus（移动端 / 周视图不传，入口走抽屉）。
   */
  const focusable = Boolean(onStartFocus) && !task.parentId && !done && !compact;
  /**
   * 行内摘要（用户裁决：统一用「分钟」口径，不再显示"专注 N 次"）：
   *   `专注 50min · 预计 30min`
   *
   * - `专注`：只有真专注过（`count > 0` 且时长 > 0）才出现 —— 0 次不占位置；
   *   次数保留在 `title` / `aria-label` 里（鼠标悬停仍能看到"几次"）。
   * - `预计`：只有 `estimatedMinutes > 0` 才出现（0 = 未估时，不是"0 分钟"）。
   * - 两段都有才用 ` · ` 连接；都没有 → 整段不渲染（不占位）。
   * - compact 行（周视图列，行高 40）一律不显示，塞不下。
   *
   * 时间戳/时长都做一次运行时收敛：`task` 可能来自云同步（老版本载荷里
   * 没有 estimatedMinutes 这个字段），一个 undefined 不该让整行崩掉。
   */
  const focusMinutes =
    focusSummary && focusSummary.count > 0
      ? Math.max(1, Math.round(focusSummary.ms / 60000))
      : 0;
  const estimateMinutes =
    Number.isFinite(task.estimatedMinutes) && task.estimatedMinutes > 0
      ? Math.trunc(task.estimatedMinutes)
      : 0;
  /** 计划在前、实际在后：先看"打算花多久"，再看"实际花了多久"，对照更直观 */
  const summaryParts: string[] = [];
  if (estimateMinutes > 0) {
    summaryParts.push(`${TEXT.estimateSummaryPrefix} ${estimateMinutes}${TEXT.estimateMinutesUnit}`);
  }
  if (focusMinutes > 0) {
    /**
     * 估时校准（F10）：两者都有时把它写成「预计 30min · 实际 45min」——
     * 一眼能看出估得准不准，估时这件事才会越用越靠谱。
     * 只有实际时仍写「专注 45min」，不为还没估时的任务编一个对比。
     */
    const prefix = estimateMinutes > 0 ? TEXT.actualSummaryPrefix : TEXT.focusSummaryPrefix;
    summaryParts.push(`${prefix} ${focusMinutes}${TEXT.estimateMinutesUnit}`);
  }
  const summaryText = compact ? '' : summaryParts.join(' · ');
  /** 无障碍/悬停文案把"次数"留着：视觉上省掉，信息不丢 */
  const summaryLabel = [
    estimateMinutes > 0
      ? `${TEXT.estimateSummaryPrefix} ${estimateMinutes}${TEXT.estimateMinutesUnit}`
      : '',
    focusMinutes > 0
      ? `${TEXT.focusSummaryPrefix} ${focusSummary?.count ?? 0} ${TEXT.focusSummaryUnit}，${focusMinutes}${TEXT.estimateMinutesUnit}`
      : '',
  ]
    .filter(Boolean)
    .join('；');
  const timeClass = timeLabel
    ? 'text-label text-ink-2'
    : task.time === null
      ? 'text-body-sm text-ink-3'
      : 'text-body-sm text-ink-2';

  /**
   * 触摸设备的侧滑手势：右滑完成、左滑打开详情。
   * 桌面端不会触发 touch 事件，因此这里无条件挂载是安全的。
   * 键盘用户不受影响（Space/Enter/Delete 仍由 useKeyboard 分派）。
   */
  /**
   * 侧滑与拖拽是**同一根手指**上的两种手势，必须互斥：
   * 手指长按进入拖拽后还留着侧滑，横拖到另一列的一路上会触发"右滑完成"。
   */
  const { offset, settling, handlers } = useSwipe({
    onSwipeRight: onToggle,
    onSwipeLeft: onOpen,
    enabled: !isDragging,
  });

  const draggable = Boolean(onDragStart);
  /**
   * 多天任务的「持续 N 天」标记。
   *
   * 只在 default 密度显示：compact（周视图列）每列只有 100px 宽，
   * 塞进去会把标题挤成两个字。`title` 里带上完整区间，鼠标停一下能看到起止日。
   */
  const spanDays = compact ? 1 : taskSpanDays(task);

  return (
    <div
      className={`swipe row-enter ${isDragging ? 'is-dragging' : ''}`}
      /**
       * 拖拽的两个 data 属性挂在**最外层**：
       * 量矩形要量整行（含手势提示层），而不是里面的按钮区。
       */
      data-drag-id={draggable ? task.id : undefined}
      data-drag-date={draggable && dropRow ? task.date : undefined}
      onPointerDown={onDragStart}
      {...handlers}
    >
      {/* 落点指示线：只在"插到这一行前面"时画，位置在行顶缘 */}
      {dropBefore ? (
        <span className="drop-line" aria-hidden="true" data-testid={`drop-line-${task.id}`} />
      ) : null}
      {/* 手势提示：藏在行下方，只有滑动时才被看见 */}
      {compact ? null : (
        <>
          <span className="swipe-hint swipe-hint--done" aria-hidden="true">
            <Icon name="check" />
          </span>
          <span className="swipe-hint swipe-hint--open" aria-hidden="true">
            <Icon name="more" />
          </span>
        </>
      )}

      <div
        className={`swipe-surface ${compact ? 'bg-surface' : 'bg-paper'} ${
          settling ? 'swipe-surface--settling' : ''
        } ${draggable ? 'cursor-grab' : ''}`}
        style={offset === 0 ? undefined : { transform: `translateX(${offset}px)` }}
      >
        <div
          role="button"
          tabIndex={0}
          data-task-id={task.id}
          data-sticky={isSticky ? 'true' : undefined}
          aria-label={`${task.title}，${done ? '已完成' : '未完成'}`}
          onClick={onOpen}
          data-indent={indent ? 'true' : undefined}
          className={`group row-hover relative flex items-center rounded-md
            ${compact ? 'h-10 gap-1' : 'h-12 gap-2 pr-11'} ${indent ? 'pl-7' : ''} ${
              done ? 'is-done opacity-60 hover:opacity-90' : ''
            }`}
        >
          {task.priority === 'high' ? (
            <span className="prio-flag" role="img" aria-label="优先级 高" />
          ) : null}

      {/* 勾选框点击不能冒泡成"打开抽屉" */}
      <span onClick={(event) => event.stopPropagation()}>
        <Checkbox
          checked={done}
          onChange={onToggle}
          label={`${done ? '取消完成' : '完成'} ${task.title}`}
          density={compact ? 'compact' : 'default'}
        />
      </span>

      {compact ? (
        <span className="flex min-w-0 flex-1 flex-col justify-center">
          <span
            className={`relative min-w-0 max-w-full ${done ? 'text-ink-3' : 'text-ink'}`}
          >
            <span className="block truncate text-body-sm">{task.title}</span>
            <span className="strike" aria-hidden="true" />
          </span>
          {showTime ? (
            <span className={`tnum truncate text-left ${timeClass}`}>{time}</span>
          ) : null}
        </span>
      ) : (
        <>
          <span className="flex min-w-0 flex-1 items-center gap-1">
            <span
              className={`relative min-w-0 max-w-full flex-initial ${
                done ? 'text-ink-3' : 'text-ink'
              }`}
            >
              <span className="block truncate text-body">{task.title}</span>
              <span className="strike" aria-hidden="true" />
            </span>
            {task.note ? (
              <span className="shrink-0 text-body font-bold leading-none text-ink-3" aria-label="有备注">
                ·
              </span>
            ) : null}
            {subtaskProgress && subtaskProgress.total > 0 ? (
              <span
                className="tnum shrink-0 text-label font-semibold text-ink-3"
                aria-label={`子任务 ${subtaskProgress.done}/${subtaskProgress.total}`}
              >
                {subtaskProgress.done}/{subtaskProgress.total}
              </span>
            ) : null}
            {/* 多天任务：一眼看出它不只属于今天 */}
            {spanDays > 1 ? (
              <span
                data-testid="task-span"
                className="tnum shrink-0 rounded-sm bg-accent-soft px-1 text-label font-semibold text-accent"
                title={`${task.date} → ${taskLastDate(task)}`}
                aria-label={`跨 ${spanDays} 天：${task.date} 到 ${taskLastDate(task)}`}
              >
                {spanDays}天
              </span>
            ) : null}
            {/* 行内摘要：`专注 50min · 预计 30min`（两段都可能不存在 → 整段不渲染） */}
            {summaryText ? (
              <span
                data-testid="task-summary"
                className="tnum hidden shrink-0 text-label text-ink-3 md:inline"
                title={summaryLabel}
                aria-label={summaryLabel}
              >
                {summaryText}
              </span>
            ) : null}
          </span>

          {showTime ? (
            // 逾期行的时间是「昨天 09:00」这类原日期文字，宽度不固定 → 用 nowrap 而不是固定列宽
            <span
              className={`tnum shrink-0 text-right ${
                timeLabel ? 'min-w-0 whitespace-nowrap' : 'w-11'
              } ${timeClass}`}
            >
              {time}
            </span>
          ) : null}

          {showCategory ? (
            <span className="chip max-w-24 shrink-0 truncate">{task.category}</span>
          ) : null}

          {/* 「开始专注」：位置在「…」左侧（right-11 = 44px 热区），group-hover 浮现 */}
          {focusable ? (
            <button
              type="button"
              tabIndex={-1}
              data-testid={`task-focus-${task.id}`}
              aria-label={`${TEXT.startFocus}：${task.title}`}
              title={TEXT.startFocus}
              onClick={(event) => {
                event.stopPropagation();
                onStartFocus?.();
              }}
              className="row-focus absolute right-11 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center
                rounded-full text-ink-2 opacity-0 transition-opacity duration-short ease-standard
                hover:bg-surface-sunk hover:text-accent group-hover:opacity-100 focus-visible:opacity-100"
            >
              <Icon name="play" size={14} />
            </button>
          ) : null}

          {/* 「…」绝对定位，不参与布局（hover 不改变行宽）；M2 里它直接打开抽屉 */}
          <button
            type="button"
            tabIndex={-1}
            aria-label="更多操作"
            onClick={(event) => {
              event.stopPropagation();
              onOpen();
            }}
            className="row-more absolute right-0 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center
              rounded-full text-ink-2 opacity-0 transition-opacity duration-short ease-standard
              hover:bg-surface-sunk hover:text-ink group-hover:opacity-100 focus-visible:opacity-100"
          >
            <Icon name="more" />
          </button>
        </>
          )}
        </div>
      </div>
    </div>
  );
});
