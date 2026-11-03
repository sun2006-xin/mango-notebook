import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTimerOwnership } from './useTimerOwnership';
import { TOAST_TIMEOUT } from '../constants';
import { nowIso } from '../lib/date';
import { focusEndAt, formatFocusDuration, resolveSessionDate } from '../lib/focus';
import { MIN_RECORD_MS, newTimerId, timerElapsedMs, type RunningTimer } from '../lib/timer';
import { loadRunningTimer, saveRunningTimer } from '../lib/storage';
import { useAppDispatch, useAppState } from '../store/StoreContext';
import type { FocusSession } from '../types';
import { useToast } from './useToast';

/* ============================================================================
   秒表（自由专注）

   与番茄钟同纪律：
   1. 已走过时间由时间戳算（暂停段靠 accumulatedMs 续算），不累减；
   2. 进行中状态落独立 key（FOCUS_RUNNING_KEY，mode='stopwatch'），刷新可恢复；
   3. 不足 1 分钟不计入专注统计。

   状态机四态：idle（没开始）/ running（跑）/ paused（暂停，保留累计值）/ stopped（已停，
   保留累计值供"记录"）。面板里"停止"即 paused ——— 之后可继续或重置；
   记录按钮只在累计 ≥ 1 分钟时出现，记录走现有 FOCUS_LOG 写 focusSessions。
   ========================================================================= */

/** tick 间隔：250ms，足够让秒数看着在走 */
const TICK_MS = 250;

export type StopwatchPhase = 'idle' | 'running' | 'paused';

export interface StopwatchApi {
  phase: StopwatchPhase;
  /** 已走过毫秒（向上取整前的真实值，UI 再决定怎么显示） */
  elapsedMs: number;
  /** 0–1，环按"当前一分钟"扫圈（秒针式） */
  progress: number;
  start: () => void;
  pause: () => void;
  resume: () => void;
  reset: () => void;
  /**
   * 记录这段到专注统计（≥1 分钟才写；写完自动回 idle、清设备本地）。
   * 不足 1 分钟：只提示「未记录」，保留 paused 状态与累计值，由用户显式重置。
   */
  record: () => void;
}

export function useStopwatch(): StopwatchApi {
  const { settings } = useAppState();
  const dispatch = useAppDispatch();
  const toast = useToast();

  /** boot：仅当设备本地有 mode==='stopwatch' 的恢复（累计值与 running 都取回） */
  const [boot] = useState<RunningTimer | null>(() => {
    const r = loadRunningTimer();
    return r && r.mode === 'stopwatch' ? r : null;
  });
  const [phase, setPhase] = useState<StopwatchPhase>(boot ? (boot.running ? 'running' : 'paused') : 'idle');
  const [elapsedMs, setElapsedMs] = useState<number>(() => (boot ? timerElapsedMs(boot, Date.now(), 0, 0) : 0));
  const runRef = useRef<RunningTimer | null>(boot);

  // 恢复出来的占位也要写回 runRef，否则第一次 tick 找不到起点
  if (boot && runRef.current === null) runRef.current = boot;

  // 跑时每 250ms 用时间戳重算（绝不做减法累加）
  useEffect(() => {
    if (phase !== 'running') return undefined;
    const tick = (): void => {
      const run = runRef.current;
      if (!run) return;
      setElapsedMs(timerElapsedMs(run, Date.now(), 0, 0));
    };
    tick();
    const id = setInterval(tick, TICK_MS);
    return () => clearInterval(id);
  }, [phase]);

  const start = useCallback(() => {
    const next: RunningTimer = {
      mode: 'stopwatch',
      id: newTimerId(),
      startedAt: nowIso(),
      taskId: null,
      phase: 'focus',
      accumulatedMs: 0,
      running: true,
      durationMs: 0,
    };
    runRef.current = next;
    saveRunningTimer(next);
    setPhase('running');
    setElapsedMs(0);
  }, []);

  const pause = useCallback(() => {
    const run = runRef.current;
    if (!run || !run.running) return;
    const now = Date.now();
    const acc = run.accumulatedMs + (now - Date.parse(run.startedAt));
    const next: RunningTimer = { ...run, accumulatedMs: acc, running: false };
    runRef.current = next;
    saveRunningTimer(next);
    setPhase('paused');
    setElapsedMs(acc);
  }, []);

  const resume = useCallback(() => {
    const run = runRef.current;
    if (!run || run.running) return;
    const next: RunningTimer = { ...run, startedAt: nowIso(), running: true };
    runRef.current = next;
    saveRunningTimer(next);
    setPhase('running');
    setElapsedMs(run.accumulatedMs);
  }, []);

  /** 回到 idle 并清设备本地；累计值丢弃 */
  const reset = useCallback(() => {
    runRef.current = null;
    saveRunningTimer(null);
    setPhase('idle');
    setElapsedMs(0);
  }, []);

  /**
   * 记录这段到专注统计（自由专注，taskId=null）。
   * 仅当累计 ≥ 1 分钟才写；复用现有 FOCUS_LOG 写 focusSessions（不新造写入路径）。
   * 写完自动回 idle、清设备本地。
   */
  const record = useCallback(() => {
    const run = runRef.current;
    if (!run) return;
    const elapsed = timerElapsedMs(run, Date.now(), 0, 0);
    if (elapsed >= MIN_RECORD_MS) {
      const session: FocusSession = {
        id: newTimerId(),
        taskId: null,
        // 归属日按日界换算：熬夜到凌晨 1 点仍算前一天
        date: resolveSessionDate(run.startedAt, settings.dayStartHour),
        startedAt: run.startedAt,
        /*
          ⚠️ `endedAt` 必须是 **startedAt + elapsed**，不能取 `new Date()`。

          统计口径（`lib/focus.ts::sessionMs`）只认 `endedAt - startedAt`，
          明写"不信 durationMs"。秒表是**可暂停**的：10:00 开始 → 10:10 暂停
          → 13:00 继续 → 13:05 记录，elapsed = 15 分钟，但"现在"是 13:05 ——
          写成 `new Date()` 的话这条记录会被算成 **3 小时 5 分钟**，
          今日/本周专注、热力图、连续打卡全部虚增。

          番茄钟那侧早就修过（`useFocusTimer` 用 `focusEndAt`），
          这里是同一条口径漏掉的最后一个写入点。
        */
        endedAt: focusEndAt(run.startedAt, elapsed),
        durationMs: elapsed,
      };
      dispatch({ type: 'FOCUS_LOG', session });
      toast.show(`专注 ${formatFocusDuration(elapsed)}，已记录`, null, TOAST_TIMEOUT.info);
    } else {
      /**
       * 不足 1 分钟：**不清运行态、不回 idle**。
       * 以前这里照样清空回 idle，等于把用户已经累计的几十秒**静默丢弃** ——
       * 面板归零，刚才那段时间哪里都没留下。
       * 现在明说一句没记录，状态保持 paused，由用户决定「继续」还是「重置」。
       */
      toast.show('不足 1 分钟，未记录', null, TOAST_TIMEOUT.info, 'warn');
      return;
    }
    runRef.current = null;
    saveRunningTimer(null);
    setPhase('idle');
    setElapsedMs(0);
  }, [dispatch, settings.dayStartHour, toast]);

  /** 跨标签页让位：只清内存、不写盘、不记录（与番茄钟同款，见 useTimerOwnership） */
  const yieldToOtherTab = useCallback(
    (reason: 'taken-over' | 'cleared') => {
      runRef.current = null;
      setPhase('idle');
      setElapsedMs(0);
      toast.show(
        reason === 'taken-over'
          ? '另一个标签页开始了新的计时，这一段已停止'
          : '另一个标签页停止了计时',
        null,
        TOAST_TIMEOUT.info,
        'warn',
      );
    },
    [toast],
  );

  useTimerOwnership({
    active: phase !== 'idle',
    runId: runRef.current?.id ?? null,
    onYield: yieldToOtherTab,
  });

  const progress = phase === 'idle' ? 0 : (elapsedMs % 60_000) / 60_000;

  return useMemo(
    () => ({ phase, elapsedMs, progress, start, pause, resume, reset, record }),
    [phase, elapsedMs, progress, start, pause, resume, reset, record],
  );
}
