import { useCallback, useEffect, useRef, useState } from 'react';
import { useDebouncedCommit } from '../../hooks/useDebouncedCommit';
import {
  ESTIMATE_MINUTES_MAX,
  NOTE_MAX,
  PRIORITY_META,
  PRIORITY_ORDER,
  REPEAT_META,
  REPEAT_ORDER,
  TEXT,
  TITLE_MAX,
} from '../../constants';
import { formatFocusDuration } from '../../lib/focus';
import type { BreakdownResult } from '../../lib/breakdown';
import { taskSpanDays } from '../../lib/task';
import type { Category, Task } from '../../types';
import { Icon } from '../common/Icon';
import { Segmented } from '../common/Segmented';

export interface TaskDrawerProps {
  task: Task | null;
  open: boolean;
  categories: Category[];
  /** 该任务的子任务（已排序）；子任务自己不再有子任务，所以这里恒为空 */
  subtasks?: Task[];
  onClose: () => void;
  /** 六字段即时生效：每次输入直接 patch，没有保存按钮 */
  onPatch: (patch: Partial<Task>) => void;
  onDelete: () => void;
  onToggleDone: () => void;
  /** 在当前任务下加一条子任务 */
  onAddSubtask?: (title: string) => void;
  /**
   * 「智能拆解」：按规则把这条任务拆成几条子任务。
   * 返回 `{ added, reason }` 由抽屉自己显示（"怎么拆的"必须看得见，
   * 拆错了用户才知道该删哪几条）。不传就不显示这个按钮。
   */
  onBreakdown?: () => BreakdownResult | null;
  /** 勾选某条子任务 */
  onToggleSubtask?: (id: string) => void;
  /**
   * 底部「开始专注」（F2）。**移动端的唯一入口** ——
   * 手机上没有 hover，任务行里那个 ▷ 点不到，所以从抽屉进。
   */
  onStartFocus?: () => void;
  /** 这条任务累计的专注（次数 + 毫秒）；0 次时只显示按钮不显示摘要 */
  focusSummary?: { count: number; ms: number };
}

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 任务抽屉（P0-2）：420 宽，右侧浮层 + 遮罩。
 * - 六字段即时保存（标题/备注/日期/时间/优先级/分类），关闭重开即最新值
 * - `Esc` 关闭、遮罩点击关闭（焦点归还由 App 负责，它持有 returnFocusId）
 * - Tab 焦点陷阱：在首尾之间循环，不逃逸到背后的列表
 * - 底部：删除（可撤销，由 App 编排）+ 标记完成
 */
export function TaskDrawer({
  task,
  open,
  categories,
  subtasks = [],
  onClose,
  onPatch,
  onDelete,
  onToggleDone,
  onAddSubtask,
  onBreakdown,
  onToggleSubtask,
  onStartFocus,
  focusSummary,
}: TaskDrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  // 打开后把焦点送进抽屉并选中标题，方便直接改
  useEffect(() => {
    if (!open) return undefined;
    const timer = setTimeout(() => {
      titleRef.current?.focus();
      titleRef.current?.select();
    }, 40);
    return () => clearTimeout(timer);
  }, [open]);

  // 焦点陷阱：Tab / Shift+Tab 在抽屉内循环
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (node) => node.offsetParent !== null,
      );
      if (nodes.length === 0) return;
      const first = nodes[0] as HTMLElement;
      const last = nodes[nodes.length - 1] as HTMLElement;
      const active = document.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const patch = (next: Partial<Task>): void => onPatch(next);

  /**
   * 标题 / 备注是长文本，**防抖**提交（350ms）；日期、优先级、分类这些离散动作
   * 仍走 `patch` 立即生效。
   *
   * 为什么要本地 state：输入框的 value 原来直接绑 `task.title`，不 dispatch 就
   * 不回显。改成"本地立刻回显、落库延后"之后，打字才不再每键重渲整棵 App
   * （抽屉后面还有一整个任务列表在跟着重排）。
   *
   * ⚠️ 只在 `task.id` 变化时重置本地值：`task` 每次保存都会换新对象，
   * 拿它当依赖会在打字过程中把光标/内容来回重置。
   */
  const [titleDraft, setTitleDraft] = useState(task?.title ?? '');
  const [noteDraft, setNoteDraft] = useState(task?.note ?? '');
  useEffect(() => {
    setTitleDraft(task?.title ?? '');
    setNoteDraft(task?.note ?? '');
  }, [task?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const titleCommit = useDebouncedCommit<string>({
    commit: (value) => onPatch({ title: value }),
  });
  const noteCommit = useDebouncedCommit<string>({
    commit: (value) => onPatch({ note: value }),
  });

  /**
   * ⚠️ 关闭必须走这里，**不能**直接调 `onClose`。
   *
   * `patchDrawerTask` 的第一行是 `if (!ui.drawerTaskId) return` ——
   * 一关抽屉，`drawerTaskId` 就变 null，此时任何迟到的提交都会被静默丢弃。
   * 而防抖提交恰恰是"迟到的"：敲完最后一个字立刻点关闭，那 350ms 内的输入
   * 会连同补交一起被这个守卫吃掉（实测：改名后关抽屉，标题回到旧值）。
   *
   * 先 flush（此时 drawerTaskId 还在）再关，顺序反了就等于丢字。
   */
  const closeWithFlush = useCallback(() => {
    titleCommit.flush();
    noteCommit.flush();
    onClose();
  }, [noteCommit, onClose, titleCommit]);

  return (
    <>
      <div
        className={`scrim fixed inset-0 z-40 transition-opacity duration-base ease-standard ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        onClick={closeWithFlush}
        aria-hidden="true"
      />

      {/* 手机端：底部弹层（bottom sheet），移动端编辑面板的通行形态；桌面端：右侧抽屉 */}
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="编辑任务"
        aria-hidden={!open}
        className={`fixed z-50 flex flex-col border-line bg-surface shadow-2 transition-transform
          duration-base ease-decelerate max-sm:overflow-y-auto
          max-sm:inset-x-0 max-sm:bottom-0 max-sm:max-h-[85dvh] max-sm:w-auto
          max-sm:rounded-t-xl max-sm:border-x max-sm:border-t max-sm:pb-[env(safe-area-inset-bottom)]
          sm:bottom-3 sm:right-3 sm:top-3 sm:w-drawer sm:max-w-[calc(100vw-var(--space-6))]
          sm:rounded-xl sm:border ${
            open
              ? 'translate-x-0 translate-y-0'
              : 'sm:translate-x-[calc(100%+var(--space-6))] max-sm:translate-y-full'
          }`}
      >
        {task ? (
          <>
            <div className="flex items-center justify-between py-4 pl-5 pr-4">
              <h2 className="text-h2 font-bold tracking-[-0.01em]">编辑任务</h2>
              <button
                type="button"
                onClick={closeWithFlush}
                aria-label="关闭"
                className="grid h-11 w-11 place-items-center rounded-md text-ink-2 hover:bg-surface-sunk hover:text-ink"
              >
                <Icon name="close" />
              </button>
            </div>

            <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-5 pb-5 pt-2">
              <div className="flex flex-col gap-2">
                <label className="text-label font-semibold tracking-[0.06em] text-ink-2" htmlFor="dr-title">
                  标题
                </label>
                <input
                  ref={titleRef}
                  id="dr-title"
                  type="text"
                  value={titleDraft}
                  maxLength={TITLE_MAX}
                  placeholder="要做什么？"
                  onChange={(event) => {
                    setTitleDraft(event.target.value);
                    titleCommit.schedule(event.target.value);
                  }}
                  className="h-11 field bg-surface-sunk px-3 text-body text-ink"
 />
 </div>
 <div className="flex flex-col gap-2">
                <label className="text-label font-semibold tracking-[0.06em] text-ink-2" htmlFor="dr-note">
                  备注
                </label>
                <textarea
                  id="dr-note"
                  value={noteDraft}
                  maxLength={NOTE_MAX}
                  placeholder="补充细节、页数、章节…"
                  onChange={(event) => {
                    setNoteDraft(event.target.value);
                    noteCommit.schedule(event.target.value);
                  }}
                  className="min-h-24 resize-y field bg-surface-sunk px-3 py-3 text-body-sm text-ink"
 />
 </div>
 <div className="flex flex-col gap-4 sm:flex-row">
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <label className="text-label font-semibold tracking-[0.06em] text-ink-2" htmlFor="dr-date">
                    日期
                  </label>
                  {/*
                    ⚠️ 子任务的日期**不让改**。
                    任务列表只把"没有 parentId 的任务"按日期分组渲染，
                    子任务是挂在父任务下面出现的。一旦子任务的日期和父任务分家，
                    它在两个日期下都渲染不出来 —— 列表里永久消失，进度条也少算，
                    只有全局搜索还找得到。要挪就挪父任务。
                  */}
                  <input
                    id="dr-date"
                    type="date"
                    value={task.date}
                    disabled={Boolean(task.parentId)}
                    title={task.parentId ? '子任务跟随父任务的日期' : undefined}
                    onChange={(event) => patch({ date: event.target.value })}
                    className="h-11 field bg-surface-sunk px-3 text-body-sm text-ink disabled:cursor-not-allowed disabled:opacity-50"
 />
 {task.parentId ? (
 <span className="text-label text-ink-2">子任务跟随父任务日期</span>
                  ) : null}
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <label className="text-label font-semibold tracking-[0.06em] text-ink-2" htmlFor="dr-time">
                    时间
                  </label>
                  <input
                    id="dr-time"
                    type="time"
                    value={task.time ?? ''}
                    onChange={(event) => patch({ time: event.target.value || null })}
                    className="h-11 field bg-surface-sunk px-3 text-body-sm text-ink"
 />
 </div>
 </div>
 {/* 结束日（多天任务）：留空 = 只有「日期」那一天。
 `min` 卡在开始日，从 UI 就堵掉"结束早于开始"这种脏数据 ——
 那种数据会让任务从所有视图里静默消失。 */}
 <div className="flex flex-col gap-2">
                <label className="text-label font-semibold tracking-[0.06em] text-ink-2" htmlFor="dr-end">
                  结束日（可选）
                </label>
                <div className="flex items-center gap-3">
                  <input
                    id="dr-end"
                    type="date"
                    data-testid="drawer-end-date"
                    value={task.endDate ?? ''}
                    min={task.date}
                    disabled={Boolean(task.parentId)}
                    onChange={(event) => patch({ endDate: event.target.value || null })}
                    className="h-11 min-w-0 flex-1 field bg-surface-sunk px-3 text-body-sm text-ink disabled:cursor-not-allowed disabled:opacity-50"
 />
 {task.endDate ? (
 <button
 type="button"
 onClick={() => patch({ endDate: null })}
 className="btn btn-text h-11 shrink-0 px-2 text-label"
                    >
                      改回单天
                    </button>
                  ) : null}
                </div>
                <span className="text-label text-ink-2">
                  {task.endDate
                    ? `跨 ${taskSpanDays(task)} 天：${task.date} → ${task.endDate}`
                    : '留空 = 只在「日期」那一天出现'}
                </span>
              </div>

              {/* 预计用时：今日时间预算的数据源。留空 = 0 = 未估时（不是"0 分钟"，
                  而是"还没想好要多久"），因此空值渲染成空框而不是一个 `0`。 */}
              <div className="flex flex-col gap-2">
                <label className="text-label font-semibold tracking-[0.06em] text-ink-2" htmlFor="dr-estimate">
                  {TEXT.estimateLabel}
                </label>
                <div className="flex items-center gap-3">
                  <input
                    id="dr-estimate"
                    data-testid="drawer-estimate"
                    type="number"
                    min={0}
                    max={ESTIMATE_MINUTES_MAX}
                    step={5}
                    inputMode="numeric"
                    value={task.estimatedMinutes > 0 ? String(task.estimatedMinutes) : ''}
                    placeholder="留空"
                    aria-label={TEXT.estimateLabel}
                    onChange={(event) => patch({ estimatedMinutes: Number(event.target.value) })}
                    className="tnum h-11 w-28 field bg-surface-sunk px-3 text-right
 text-body-sm text-ink"
 />
 <span className="text-label text-ink-3">留空表示暂不估时；今日视图按它汇总预算</span>
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <span className="text-label font-semibold tracking-[0.06em] text-ink-2">优先级</span>
                <Segmented
                  ariaLabel="优先级"
                  variant="plain"
                  className="self-start"
                  value={task.priority}
                  options={PRIORITY_ORDER.map((value) => ({
                    value,
                    label: PRIORITY_META[value].label,
                  }))}
                  onChange={(value) => patch({ priority: value })}
                />
              </div>

              <div className="flex flex-col gap-2">
                <span className="text-label font-semibold tracking-[0.06em] text-ink-2">重复</span>
                <Segmented
                  ariaLabel="重复"
                  variant="plain"
                  className="self-start"
                  value={task.repeat}
                  options={REPEAT_ORDER.map((value) => ({
                    value,
                    label: REPEAT_META[value].label,
                  }))}
                  onChange={(value) => patch({ repeat: value })}
                />
                <span className="text-label text-ink-3">{REPEAT_META[task.repeat].hint}</span>
              </div>

              <div className="flex flex-col gap-2">
                <span className="text-label font-semibold tracking-[0.06em] text-ink-2">分类</span>
                <div role="group" aria-label="分类" className="flex flex-wrap gap-2">
                  {categories.map((category) => {
                    const active = category.name === task.category;
                    return (
                      <button
                        key={category.id}
                        type="button"
                        aria-pressed={active}
                        onClick={() => patch({ category: category.name })}
                        className={`inline-flex h-11 items-center rounded-full border px-4 text-body-sm font-semibold
                          transition-colors duration-short ease-standard ${
                            active
                              ? 'border-accent bg-accent-soft text-accent'
                              : 'border-line bg-surface text-ink-2 hover:border-ink-3 hover:text-ink'
                          }`}
                      >
                        {category.name}
                      </button>
                    );
                  })}
                </div>
              </div>

              {task.time ? (
                <button
                  type="button"
                  onClick={() => patch({ time: null })}
                  className="btn btn-outlined self-start"
                >
                  设为「{TEXT.anytime}」（清除时间）
                </button>
              ) : null}

              {/*
                子任务：只给顶层任务显示。
                子任务自己不能再挂子任务 —— 父子两层已经把"一门技术 → 几个步骤"
                表达清楚了，再深会让缩进、勾选联动、拖拽排序全部失控。
              */}
              {onAddSubtask && !task.parentId ? (
                <SubtaskSection
                  subtasks={subtasks}
                  onAdd={onAddSubtask}
                  onBreakdown={onBreakdown}
                  onToggle={onToggleSubtask}
                />
              ) : null}
            </div>

            {/* 开始专注：移动端的唯一入口（桌面端任务行 hover 也有一个 ▷） */}
            {onStartFocus ? (
              <div className="flex items-center gap-3 border-t border-line px-5 py-3">
                <button
                  type="button"
                  data-testid="drawer-start-focus"
                  onClick={onStartFocus}
                  className="btn btn-outlined min-w-0 flex-1"
                >
                  <Icon name="play" size={15} />
                  {TEXT.startFocus}
                </button>
                {focusSummary && focusSummary.count > 0 ? (
                  <span className="tnum shrink-0 text-label text-ink-2">
                    {TEXT.focusSummaryPrefix} {focusSummary.count} {TEXT.focusSummaryUnit} ·{' '}
                    {formatFocusDuration(focusSummary.ms)}
                  </span>
                ) : null}
              </div>
            ) : null}

            <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
              <button type="button" onClick={onDelete} className="btn btn-danger">
                <Icon name="trash" size={15} />
                删除任务
              </button>
              <button type="button" onClick={onToggleDone} className="btn btn-primary">
                {task.done ? '取消完成' : '标记完成'}
              </button>
            </div>
          </>
        ) : null}
      </aside>
    </>
  );
}

/**
 * 子任务区块。
 *
 * 输入框是**受控但草稿式**的：提交后立刻清空、但保持焦点，
 * 这样连着敲三条步骤不用每次重新点输入框（拆步骤本来就是连续动作）。
 */
function SubtaskSection({
  subtasks,
  onAdd,
  onBreakdown,
  onToggle,
}: {
  subtasks: Task[];
  onAdd: (title: string) => void;
  onBreakdown?: () => BreakdownResult | null;
  onToggle?: (id: string) => void;
}) {
  const [draft, setDraft] = useState('');
  /** 上一次拆解的回话（"怎么拆的"）。不自动消失：那是给用户核对的依据 */
  const [breakdownNote, setBreakdownNote] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const done = subtasks.filter((item) => item.done).length;

  const submit = (): void => {
    const title = draft.trim();
    if (!title) return;
    onAdd(title);
    setDraft('');
    inputRef.current?.focus();
  };

  const runBreakdown = (): void => {
    const result = onBreakdown?.() ?? null;
    if (!result) return;
    setBreakdownNote(
      result.added > 0 ? `${result.reason}，加了 ${result.added} 条` : result.reason,
    );
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="text-label font-semibold tracking-[0.06em] text-ink-2">子任务</span>
        {subtasks.length > 0 ? (
          <span className="tnum text-label text-ink-3">
            {done}/{subtasks.length}
          </span>
        ) : null}
      </div>

      {/*
        「智能拆解」：把一条大任务按规则拆成几步。
        ⚠️ 这是**本地规则**，不是大模型 —— 本应用没有服务端。按钮下面那行
        「怎么拆的」就是为了这点：拆错了用户能看出依据，也知道该删哪几条。
        已经有同样标题的步骤会被跳过（所以连点两次不会出两份）。
      */}
      {onBreakdown ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="subtask-breakdown"
            onClick={runBreakdown}
            className="btn btn-outlined h-9 shrink-0 px-3 text-label"
          >
            <Icon name="sparkle" size={13} />
            智能拆解
          </button>
          <span className="min-w-0 flex-1 text-label text-ink-3">
            {breakdownNote ?? '按标题里的分点 / 任务类型拆成几步，拆完还能改'}
          </span>
        </div>
      ) : null}

      {subtasks.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {subtasks.map((item) => (
            <li key={item.id} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onToggle?.(item.id)}
                aria-pressed={item.done}
                aria-label={`${item.done ? '取消完成' : '完成'} ${item.title}`}
                /*
                  视觉上是 32px 的圆圈（子任务行高度有限，放不下 44 的实心块），
                  但**热区要够手指点**：用 `after` 伪元素向四周各撑 4px，
                  得到 40×40 的可点区（正好填满行间 4px 的 gap，不与相邻行抢）。
                  只放大热区、不改外观 —— 这是密集列表里扩热区的标准做法。
                */
                className={`relative grid h-8 w-8 shrink-0 place-items-center rounded-full border
                  transition-colors duration-short ease-standard
                  after:absolute after:-inset-1 after:content-[''] ${
                    item.done
                      ? 'border-accent bg-accent text-accent-on'
                      : 'border-line bg-surface text-transparent hover:border-ink-3'
                  }`}
              >
                <Icon name="check" size={13} />
              </button>
              <span
                className={`min-w-0 flex-1 truncate text-body-sm ${
                  item.done ? 'text-ink-3 line-through' : 'text-ink'
                }`}
              >
                {item.title}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <span className="text-label text-ink-3">把它拆成几个小步骤，勾起来更有进度感。</span>
      )}

      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="text"
          value={draft}
          maxLength={TITLE_MAX}
          placeholder="加一个子任务，回车确认"
          aria-label="子任务标题"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submit();
            }
          }}
          className="h-11 min-w-0 flex-1 field bg-surface-sunk px-3 text-body-sm
 text-ink"
 />
 <button
 type="button"
 onClick={submit}
 disabled={draft.trim().length === 0}
 className="btn btn-outlined shrink-0"
        >
          <Icon name="plus" size={14} />
          添加
        </button>
      </div>
    </div>
  );
}
