import { memo, useCallback } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { TEXT } from '../../constants';
import { countDoneInView } from '../../lib/task';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import type { DropTarget } from '../../lib/drag';
import type { TaskFocusStat } from '../../lib/focus';
import type { DateKey, DayGroup, FilterMode, Task } from '../../types';
import { Icon } from '../common/Icon';
import { TaskRow } from './TaskRow';

/** 稳定的空数组常量：`?? []` 每次都是新引用，会把 memo 的浅比较打穿 */
const NO_CHILDREN: Task[] = [];

interface RowWithChildrenProps {
  task: Task;
  /**
   * 这一行的子任务。
   *
   * ⚠️ 从前的 props 是**整个 `group`**（DayGroup）—— 那个对象由 TodayView 的
   * useMemo 产出，依赖 tasks / date / mode / category / stickyDoneIds 五个东西，
   * 其中任何一个变都会重建 → 所有行都重渲，`TaskRow` 上的 memo 形同虚设。
   * 现在只传这一行真正用到的：自己 + 自己的子任务。
   */
  children: Task[];
  isSticky: boolean;
  showCategory: boolean;
  showTime: boolean;
  /** 不传 = 这条不渲染「开始专注 ▷」（移动端 / 未接线） */
  onStartFocus?: (id: string) => void;
  /** 按任务的专注累计（用于行内「专注 N 次 · X 分钟」） */
  focusStats?: Map<string | null, TaskFocusStat>;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  /** 拖拽（引用稳定）；子任务行**不传** —— 它跟着父任务走，单独拖没有意义 */
  onDragStart?: (event: ReactPointerEvent<HTMLElement>) => void;
  /** 正被拖着的任务 id */
  draggingId?: string | null;
  /** 落点；命中 beforeId 时在那一行顶部画指示线 */
  dropTarget?: DropTarget | null;
}

/**
 * 一行 = 父任务 + 紧随其下的子任务（只有一层）。
 *
 * 子任务跟着父任务走，父任务在哪一段（待办 / 已完成）子任务就在哪一段：
 * 勾选联动保证两者 done 状态一致，所以不会出现"父在已完成、子在待办"。
 * 子任务不单独参与排序，因此这里用普通 map 而不是扁平化后重排。
 */
const RowWithChildren = memo(function RowWithChildren({
  task,
  children,
  isSticky,
  showCategory,
  showTime,
  onStartFocus,
  focusStats,
  onToggle,
  onOpen,
  onDelete,
  onDragStart,
  draggingId,
  dropTarget,
}: RowWithChildrenProps) {
  const done = children.filter((child) => child.done).length;
  /**
   * 落点指示线只可能画在**父任务行**上：子任务不参与当天的顶层序列，
   * 也就永远不会成为 `beforeId`。
   */
  const dropBefore = dropTarget?.kind === 'before' && dropTarget.beforeId === task.id;

  return (
    <>
      <TaskRow
        task={task}
        isSticky={isSticky}
        showCategory={showCategory}
        showTime={showTime}
        subtaskProgress={children.length > 0 ? { done, total: children.length } : undefined}
        onStartFocus={onStartFocus ? () => onStartFocus(task.id) : undefined}
        focusSummary={focusStats?.get(task.id)}
        onToggle={() => onToggle(task.id)}
        onOpen={() => onOpen(task.id)}
        onDelete={() => onDelete(task.id)}
        onDragStart={onDragStart}
        dropRow
        isDragging={draggingId === task.id}
        dropBefore={dropBefore}
      />
      {children.map((child) => (
        <TaskRow
          key={child.id}
          task={child}
          indent
          isSticky={false}
          showCategory={showCategory}
          showTime={showTime}
          onToggle={() => onToggle(child.id)}
          onOpen={() => onOpen(child.id)}
          onDelete={() => onDelete(child.id)}
        />
      ))}
    </>
  );
});

export interface TaskListProps {
  group: DayGroup;
  /** 已完成组是否收起（settings.doneCollapsed） */
  collapsed: boolean;
  mode: FilterMode;
  /** 「开始专注」（F2）：不传则整列都不出现 ▷ */
  onStartFocus?: (id: string) => void;
  /** 按任务的专注累计；不传则不显示「专注 N 次」 */
  focusStats?: Map<string | null, TaskFocusStat>;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onToggleCollapse: () => void;
  showCategory?: boolean;
  showTime?: boolean;
  className?: string;
  /** 拖拽起点（引用稳定）；不传 = 整列都不能拖 */
  onDragStart?: (event: ReactPointerEvent<HTMLElement>) => void;
  draggingId?: string | null;
  dropTarget?: DropTarget | null;
  /**
   * 这一天的日期 —— 待办段整段作为**落点容器**。
   * 已完成段不给：它按 doneAt 排序，往里插"第几位"是没有意义的操作。
   */
  dropDate?: DateKey;
}

/**
 * 分组渲染容器：待办 / 已完成两段。
 * - 待办段 = `group.open`（未完成 + sticky 混排后的结果，顺序已在 lib 里定好）
 * - 已完成段计数用 `countDoneInView`（含 sticky），与进度条口径绑定（§9 U7）
 * - 已完成组默认收起；收起/展开会清空 sticky（回到「已完成」里）
 */
function TaskListInner({
  group,
  collapsed,
  mode,
  onStartFocus,
  focusStats,
  onToggle,
  onOpen,
  onDelete,
  onToggleCollapse,
  showCategory = true,
  showTime = true,
  className,
  onDragStart,
  draggingId,
  dropTarget,
  dropDate,
}: TaskListProps) {
  const doneCount = countDoneInView(group);
  const stickyIds = new Set(group.sticky.map((task) => task.id));
  const { isMobile } = useBreakpoint();

  /**
   * ▷ 的 handler 用 useCallback 稳住引用 —— TaskRow 是 memo 的，
   * 每次渲染都传一个新函数会让整列失去 memo 的意义。
   * 移动端（<640）**不传**：没有 hover，触摸设备上这个按钮点不到，
   * 入口改走任务抽屉底部的「开始专注」（主理人裁定第 4 条）。
   */
  const handleStartFocus = useCallback(
    (id: string) => {
      onStartFocus?.(id);
    },
    [onStartFocus],
  );
  const startFocusHandler = onStartFocus && !isMobile ? handleStartFocus : undefined;

  return (
    <div className={`flex flex-col gap-6 ${className ?? ''}`}>
      {mode !== 'done' && group.open.length > 0 ? (
        <section aria-label={TEXT.openGroup}>
          <div className="mb-2 flex items-center gap-2 pl-1">
            <h2 className="text-h2 font-bold tracking-[-0.01em]">{TEXT.openGroup}</h2>
            <span data-testid="open-count" className="tnum text-label font-semibold text-ink-2">
              · {group.open.length}
            </span>
          </div>
          <div
            /**
             * `min-h-11`：拖拽时这一段是**唯一的落点容器**，
             * 高度为 0 的话（待办只有一条时也可能很矮）手指很难命中。
             * 44px 与全站最小热区同尺寸。
             */
            className={`divide-y divide-line ${onDragStart ? 'min-h-11' : ''}`}
            /* 只有真的能拖时才登记落点容器，避免给纯展示场景凭空加属性 */
            data-drop-day={onDragStart ? dropDate : undefined}
          >
            {group.open.map((task) => (
              <RowWithChildren
                key={task.id}
                task={task}
                children={group.childrenByParent[task.id] ?? NO_CHILDREN}
                isSticky={stickyIds.has(task.id)}
                showCategory={showCategory}
                showTime={showTime}
                onStartFocus={startFocusHandler}
                focusStats={focusStats}
                onToggle={onToggle}
                onOpen={onOpen}
                onDelete={onDelete}
                onDragStart={onDragStart}
                draggingId={draggingId}
                dropTarget={dropTarget}
              />
            ))}
          </div>
        </section>
      ) : null}

      {mode !== 'open' && doneCount > 0 ? (
        <section aria-label={TEXT.doneGroup}>
          <div className="mb-2 flex items-center gap-2 pl-1">
            <h2 className="text-h2 font-bold tracking-[-0.01em]">{TEXT.doneGroup}</h2>
            <span data-testid="done-count" className="tnum text-label font-semibold text-ink-2">
              · {doneCount}
            </span>
            <button
              type="button"
              onClick={onToggleCollapse}
              aria-expanded={!collapsed}
              className="btn btn-text ml-auto h-11 text-label font-semibold tracking-[0.06em]"
            >
              {collapsed ? TEXT.expand : TEXT.collapse}
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
              {group.done.map((task) => (
                <RowWithChildren
                  key={task.id}
                  task={task}
                  children={group.childrenByParent[task.id] ?? NO_CHILDREN}
                  isSticky={false}
                  showCategory={showCategory}
                  showTime={showTime}
                  onStartFocus={startFocusHandler}
                  focusStats={focusStats}
                  onToggle={onToggle}
                  onOpen={onOpen}
                  onDelete={onDelete}
                />
              ))}
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}

/**
 * `memo` 包一层：`group` 现在由 `selectDayView` 保证**引用稳定**（输入不变就返回
 * 同一个对象），所以打开抽屉 / 弹 toast / 拖拽结束这些与列表无关的 store 变化，
 * 整个列表子树可以被跳过 —— 而不是每次都把 N 行重新创建一遍元素并浅比较 props。
 */
export const TaskList = memo(TaskListInner);
