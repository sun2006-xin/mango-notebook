/* ============================================================================
   计时工具集（纯函数层）

   零 React / 零 localStorage 依赖，全部可单测。
   番茄钟 / 秒表 / 自定义时长提醒三套计时共享同一份"时间派生"逻辑，
   这样 UI 层只管画，时间永远由时间戳重算（不累减，见 useFocusTimer 纪律）。

   这里只负责"给定一份 RunningTimer + 当前时刻 → 算出 elapsed / remaining /
   ring progress"，不负责读存储、不负责状态机。状态机在各自的 hook 里。
   ========================================================================= */

export type TimerMode = 'pomodoro' | 'stopwatch' | 'reminder';

/** 设备本地持久化的"正在跑的计时"；落独立的 key，不进主 payload */
export interface RunningTimer {
  mode: TimerMode;
  /** 本次计时唯一 id（也用作将来记录的 session id 兜底） */
  id: string;
  /** 本次计时的起点（ISO）；秒表暂停后会被重置为"继续"那一刻 */
  startedAt: string;
  /** 关联任务；秒表 / 提醒恒为 null（自由专注 / 不计入专注统计） */
  taskId: string | null;
  /** 番茄钟阶段：专注 / 休息（秒表 / 提醒恒为 'focus'，仅占位） */
  phase: 'focus' | 'break';
  /** 秒表已累计的毫秒（暂停时落盘，继续时不再重算这一段） */
  accumulatedMs: number;
  /** 是否在跑；false 表示暂停 / 已停但保留累计值（可恢复 / 记录） */
  running: boolean;
  /** 提醒模式的目标总时长（毫秒）；其它模式为 0 */
  durationMs: number;
}

/** 计时偏好（设备本地持久化，独立于专注主 payload） */
export interface RunningTimerPrefs {
  mode: TimerMode;
  /** 提醒模式的一排预设胶囊（分钟） */
  reminderPresets: number[];
}

/** 提醒预设默认值（分钟） */
export const DEFAULT_REMINDER_PRESETS: readonly number[] = [5, 15, 25, 45, 60];

/** 最短记录时长：低于此值视为误触，不计入专注统计 */
export const MIN_RECORD_MS = 60_000;

/**
 * 页面是否可见（番茄自动续接的防假数据闸门）。
 *
 * 为什么必须有：自动续接在"人走了"的时候最危险 —— 一段接一段地跑，
 * 每一段都会如实写进专注记录。切标签页 / 锁屏会让 `visibilityState` 变成
 * `hidden`，这是**唯一可靠**的"人不在"信号，所以拿它当闸门。
 *
 * 非浏览器环境（单测 / 服务端渲染）没有 document，按"可见"处理 ——
 * 宁可让用例能跑，也不要在 undefined 上炸。
 */
export function isDocumentVisible(): boolean {
  const doc = (globalThis as { document?: { visibilityState?: string } }).document;
  if (!doc || typeof doc.visibilityState !== 'string') return true;
  return doc.visibilityState === 'visible';
}

/** 生成唯一 id：优先 crypto.randomUUID，降级为随机串（沿用 useFocusTimer 现有逻辑） */
export function newTimerId(): string {
  const maybeCrypto = globalThis.crypto as Crypto | undefined;
  if (maybeCrypto && typeof maybeCrypto.randomUUID === 'function') {
    return maybeCrypto.randomUUID();
  }
  return `t_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 该计时当前的"总时长"（毫秒）：番茄钟按 phase 取 focus/break，提醒用 durationMs */
function timerTotalMs(t: RunningTimer, focusMs: number, breakMs: number): number {
  if (t.mode === 'reminder') return t.durationMs;
  if (t.mode === 'pomodoro') return t.phase === 'break' ? breakMs : focusMs;
  return focusMs;
}

/**
 * 已走过的毫秒。
 * - 秒表：`accumulatedMs + (running ? now - startedAt : 0)`（暂停段也计入）
 * - 番茄钟 / 提醒：`now - startedAt`，夹到 ≥0（绝不为负）
 */
export function timerElapsedMs(t: RunningTimer, now: number, _focusMs: number, _breakMs: number): number {
  if (t.mode === 'stopwatch') {
    const live = t.running ? now - Date.parse(t.startedAt) : 0;
    return t.accumulatedMs + (Number.isFinite(live) ? live : 0);
  }
  const passed = now - Date.parse(t.startedAt);
  return Number.isFinite(passed) ? Math.max(0, passed) : 0;
}

/**
 * 剩余毫秒（夹紧到 ≥0）；秒表无"剩余"概念 → 返回 null。
 */
export function timerRemainingMs(t: RunningTimer, now: number, focusMs: number, breakMs: number): number | null {
  if (t.mode === 'stopwatch') return null;
  const total = timerTotalMs(t, focusMs, breakMs);
  const elapsed = timerElapsedMs(t, now, focusMs, breakMs);
  return Math.max(0, total - elapsed);
}

/**
 * 环形进度 0..1。
 * - 番茄钟：`elapsed / total`（满圈 = 本段结束）
 * - 秒表：已走过时间在"当前一分钟"内的占比（秒针式，`(elapsedMs % 60000) / 60000`）
 * - 提醒：`1 - remaining / duration`（满圈 = 到点）
 */
export function timerRingProgress(t: RunningTimer, now: number, focusMs: number, breakMs: number): number {
  if (t.mode === 'stopwatch') {
    const elapsed = timerElapsedMs(t, now, focusMs, breakMs);
    const mod = elapsed % 60_000;
    return mod / 60_000;
  }
  if (t.mode === 'reminder') {
    const total = timerTotalMs(t, focusMs, breakMs);
    const remaining = timerRemainingMs(t, now, focusMs, breakMs) ?? 0;
    if (total <= 0) return 0;
    return Math.min(1, Math.max(0, 1 - remaining / total));
  }
  // pomodoro
  const total = timerTotalMs(t, focusMs, breakMs);
  const elapsed = timerElapsedMs(t, now, focusMs, breakMs);
  if (total <= 0) return 0;
  return Math.min(1, Math.max(0, elapsed / total));
}

/** 「这一段结束后要不要自动开下一段」的三个输入 */
export interface AutoContinueInput {
  /** 设置里的开关（`settings.autoContinue`） */
  enabled: boolean;
  /** 这段是**时间到了自然结束**，还是用户手点的 */
  auto: boolean;
  /** 页面是否可见 */
  visible: boolean;
}

/**
 * 自动续接的**唯一判据**。
 *
 * 三个条件缺一不可，每一条都有一个具体的坏结局：
 * - 没开开关还续 → 替用户做决定，最招人烦的那种"贴心"；
 * - 手点「结束」还续 → 用户想停，结果又开了一段，他要按三次才能真的停下来；
 * - 页面不可见还续 → 切走标签页 / 锁屏时一段接一段地跑，
 *   记录里堆满"人不在场"的专注时长，**统计直接废掉**。
 *
 * 抽成纯函数就是为了让这三条能被用例逐条钉住 —— 放在 hook 里的内联判断
 * 只能靠人眼看，而这三条恰恰都是"漏一条也不会报错"的那种错误。
 */
export function shouldAutoContinue(input: AutoContinueInput): boolean {
  return Boolean(input.enabled) && Boolean(input.auto) && Boolean(input.visible);
}
