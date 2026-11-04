import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { ESTIMATE_MINUTES_MAX, TEXT, TITLE_MAX } from '../../constants';
import { formatDateTitle, formatRelativeDay } from '../../lib/date';
import { parseQuickAdd } from '../../lib/quickParse';
import type { DateKey, Task } from '../../types';
import { useBreakpoint } from '../../hooks/useBreakpoint';
import { Icon } from '../common/Icon';

export interface QuickAddProps {
  /** 目标日期（在当前选中日创建） */
  date: DateKey;
  /**
   * 应用认为的"今天"（已按 `dayStartHour` 日界换算）。
   *
   * ⚠️ 组件内**不许自己调 todayKey()**：日界设成 4 点时，凌晨 2 点的"今天"
   * 是前一天，组件自己算会得出自然日 —— 于是 placeholder 显示
   * "添加到 昨天…"，和整站的日期口径打架。视图不读时钟是本项目纪律。
   */
  today: DateKey;
  /**
   * 提交回调：标题已 trim 且非空。
   * 第二个参数是「预计用时（分钟）」，**留空 / 非法传 0**（0 = 未估时）。
   */
  /**
   * 提交回调：标题已 trim 且非空，第二个参数是估时（留空/非法传 0）。
   * 第三个参数是自然语言解析出来的其它字段（日期/时间/优先级/重复/分类）。
   */
  onAdd: (title: string, estimatedMinutes?: number, patch?: Partial<Task>) => void;
  /** 「新任务」按钮把它滚进视野（M1 行为） */
  onExpand?: () => void;
  /** 外部需要聚焦输入框时使用（如空状态自动聚焦、标题栏「新任务」） */
  inputRef?: RefObject<HTMLInputElement | null>;
}

/**
 * 数字输入框里的草稿 → 分钟数。
 *
 * 三种输入都要能安全落地：
 * - 空串（用户没填）→ 0（未估时，这是最常见的状态）；
 * - 手打 `1e9` / `12abc` → Number() 得到 1e9 / NaN，前者要夹紧、后者归 0；
 * - 负数（`type=number` 允许手打减号）→ 0。
 * 真正的夹紧只认 lib/task 的 clampEstimateMinutes（createTask 里会再走一次），
 * 这里只是把"输入框字符串"翻译成一个数字，不做两套规则。
 */
function parseMinutes(raw: string): number {
  const text = raw.trim();
  if (!text) return 0;
  const value = Number(text);
  if (!Number.isFinite(value)) return 0;
  return Math.min(ESTIMATE_MINUTES_MAX, Math.max(0, Math.trunc(value)));
}

/**
 * 常驻单行输入（P0-1）：
 * Enter 创建 → 清空 → 保持焦点；空值不发请求，输入框抖动 + 提示；
 * placeholder 随选中日期变化（非今天时写明「添加到 X」）。
 *
 * v1.0 起多一格「分钟」：估时是**今日时间预算**的数据源，
 * 而"加任务"正是用户脑子里有数字的那一刻 —— 让他之后再去抽屉里补，
 * 十有八九就永远不会补了。留空即 0（未估时）。
 */
export function QuickAdd({ date, today, onAdd, onExpand, inputRef }: QuickAddProps) {
  const [draft, setDraft] = useState('');
  const [minutes, setMinutes] = useState('');
  const [shaking, setShaking] = useState(false);
  const localRef = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? localRef;
  const shakeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (shakeTimer.current) clearTimeout(shakeTimer.current);
    },
    [],
  );

  const shake = useCallback(() => {
    // 先落一帧 false 再置 true，才能重播同一段 animation。
    // 用 setTimeout 而不是 rAF：rAF 在没有渲染帧的环境（如 headless dump-dom）不会回调，
    // 会让"空值抖动"这条反馈静默失效。
    setShaking(false);
    if (shakeTimer.current) clearTimeout(shakeTimer.current);
    shakeTimer.current = setTimeout(() => {
      setShaking(true);
      shakeTimer.current = setTimeout(() => setShaking(false), 420);
    }, 16);
  }, []);

  const submit = useCallback(() => {
    if (!draft.trim()) {
      shake();
      ref.current?.focus();
      return;
    }
    /**
     * 自然语言速记：`明天9点 高数第3章 p1 30分钟 #学习`
     * 解析出来的字段走 onAdd 的第三个参数；解析不出来的原样当标题（绝不吞字）。
     * 手填的"预计用时"优先于文本里写的（用户显式输入更可信）。
     */
    const parsed = parseQuickAdd(draft, today);
    const typedMinutes = parseMinutes(minutes);
    const patch: Partial<Task> = {};
    if (parsed.date) patch.date = parsed.date;
    if (parsed.time) patch.time = parsed.time;
    if (parsed.priority) patch.priority = parsed.priority;
    if (parsed.repeat) patch.repeat = parsed.repeat;
    if (parsed.category) patch.category = parsed.category;
    onAdd(parsed.title, typedMinutes || parsed.estimatedMinutes, patch);
    setDraft('');
    // 估时清空：下一条是另一个任务，沿用上一条的分钟数几乎一定是错的
    setMinutes('');
    ref.current?.focus();
    onExpand?.();
  }, [draft, minutes, onAdd, onExpand, ref, shake]);

  // ≤420 用短文案；≤360 再短一档（同时按钮被隐藏，回车仍是唯一入口）
  const { isNarrow420, isNarrow360 } = useBreakpoint();
  const isToday = date === today;
  const placeholder = isNarrow360
    ? '添加任务…'
    : isNarrow420
      ? '添加任务，回车保存'
      : isToday
        ? '添加今天的任务，回车保存'
        : `添加到 ${formatRelativeDay(date, today)}（${formatDateTitle(date)}）`;

  return (
    <form
      className={`flex items-center gap-2 rounded-md border bg-surface pl-4 pr-2 shadow-1 transition-colors
        duration-short ease-standard focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/15
        ${shaking ? 'animate-shake border-warn' : 'border-line'}`}
      autoComplete="off"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Icon name="plus" className="text-ink-2" />
      <input
        ref={ref}
        type="text"
        data-testid="quickadd-input"
        value={draft}
        maxLength={TITLE_MAX}
        placeholder={placeholder}
        aria-label="添加任务"
        onChange={(event) => setDraft(event.target.value)}
        className="h-11 min-w-0 flex-1 bg-transparent text-body text-ink outline-none"
      />
      {/* 预计用时：留空 = 未估时（0）。窄屏缩到 w-14，但仍保留 —— 
          它是今日预算的唯一数据来源，藏起来预算就永远是空的。 */}
      <input
        type="number"
        data-testid="quickadd-estimate"
        value={minutes}
        min={0}
        max={ESTIMATE_MINUTES_MAX}
        step={5}
        inputMode="numeric"
        placeholder={TEXT.estimatePlaceholder}
        aria-label={TEXT.estimateLabel}
        title={TEXT.estimateLabel}
        onChange={(event) => setMinutes(event.target.value)}
        className="field tnum h-9 w-14 shrink-0 rounded-sm bg-surface-sunk px-1.5 text-right
          text-body-sm text-ink placeholder:text-left max-xs:w-12"
      />
      {/*
        ≤360 隐藏「添加」按钮：回车提交仍然可用，按钮是冗余入口。
        高度用 h-9 而不是 .btn 的 h-11 —— 44px 的实心按钮会顶满整条输入框，
        看起来像一块塞满的方块（用户反馈"按钮太大排布不美观"）。
        36px + 上下留白，让它读起来是"输入框里的一个动作"而不是独立面板。
      */}
      <button type="submit" className="btn btn-primary h-9 shrink-0 px-3 max-xxs:hidden">
        添加
      </button>
    </form>
  );
}
