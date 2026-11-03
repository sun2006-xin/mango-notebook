import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { nowIso } from '../lib/date';
import { newTimerId, timerRemainingMs, type RunningTimer } from '../lib/timer';
import { loadRunningTimer, saveRunningTimer } from '../lib/storage';

/* ============================================================================
   自定义时长提醒

   纪律同番茄钟：剩余时间由时间戳算；进行中状态落独立 key（mode='reminder'），
   刷新可恢复。提醒"到点响铃"不在本 hook 里触发 —— 交给 App 级的
   useReminderWatcher（始终运行，切到别的视图也能响），这里只管"开始 / 取消"
   与"还剩多少"。
   ========================================================================= */

/** tick 间隔：250ms，足够让剩余秒数看着在走 */
const TICK_MS = 250;

export type ReminderPhase = 'idle' | 'running';

export interface ReminderApi {
  phase: ReminderPhase;
  /** 剩余毫秒（夹紧到 ≥0） */
  remainingMs: number;
  /** 目标总时长（毫秒） */
  durationMs: number;
  start: (durationMs: number) => void;
  cancel: () => void;
}

export function useReminder(): ReminderApi {
  /** boot：仅当设备本地有 mode==='reminder' 的恢复 */
  const [boot] = useState<RunningTimer | null>(() => {
    const r = loadRunningTimer();
    return r && r.mode === 'reminder' ? r : null;
  });
  const [phase, setPhase] = useState<ReminderPhase>(boot && boot.running ? 'running' : 'idle');
  const [remainingMs, setRemainingMs] = useState<number>(
    () => (boot ? timerRemainingMs(boot, Date.now(), 0, 0) ?? 0 : 0),
  );
  const [durationMs, setDurationMs] = useState<number>(boot ? boot.durationMs : 0);
  const runRef = useRef<RunningTimer | null>(boot);

  if (boot && runRef.current === null) runRef.current = boot;

  useEffect(() => {
    if (phase !== 'running') return undefined;
    const tick = (): void => {
      /**
       * 每轮先回读一次设备本地状态。
       *
       * 提醒到点后，`useReminderWatcher`（App 级常驻）会 `saveRunningTimer(null)`
       * 把运行态清掉以保证只响一次；而本 hook **不监听外部清除** ——
       * 不回读的话 `runRef.current` 还指着旧对象、`phase` 仍是 'running'，
       * 面板永远停在"还剩 00:00 / 计时中"，只剩「取消提醒」一条路，
       * 用户必须手动点一下才能重新设提醒。
       * 回读到"没了 / 换成了别人的 id"就干净地回到 idle。
       */
      const live = loadRunningTimer();
      const mine = runRef.current;
      if (mine && (live === null || live.id !== mine.id)) {
        runRef.current = null;
        setPhase('idle');
        setRemainingMs(0);
        setDurationMs(0);
        return;
      }
      const run = runRef.current;
      if (!run) return;
      setRemainingMs(Math.max(0, timerRemainingMs(run, Date.now(), 0, 0) ?? 0));
    };
    tick();
    const id = setInterval(tick, TICK_MS);
    return () => clearInterval(id);
  }, [phase]);

  const start = useCallback((ms: number) => {
    const safe = Math.max(1, Math.trunc(ms));
    const next: RunningTimer = {
      mode: 'reminder',
      id: newTimerId(),
      startedAt: nowIso(),
      taskId: null,
      phase: 'focus',
      accumulatedMs: 0,
      running: true,
      durationMs: safe,
    };
    runRef.current = next;
    saveRunningTimer(next);
    setDurationMs(safe);
    setRemainingMs(safe);
    setPhase('running');
  }, []);

  const cancel = useCallback(() => {
    runRef.current = null;
    saveRunningTimer(null);
    setPhase('idle');
    setRemainingMs(0);
    setDurationMs(0);
  }, []);

  return useMemo(
    () => ({ phase, remainingMs, durationMs, start, cancel }),
    [phase, remainingMs, durationMs, start, cancel],
  );
}
