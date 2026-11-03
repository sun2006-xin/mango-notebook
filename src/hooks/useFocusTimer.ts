import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTimerOwnership } from './useTimerOwnership';
import { TOAST_TIMEOUT } from '../constants';
import { nowIso } from '../lib/date';
import {
  focusEndAt,
  formatFocusDuration,
  isAbandonedFocus,
  resolveSessionDate,
} from '../lib/focus';
import { loadRunningTimer, saveRunningTimer } from '../lib/storage';
import { isDocumentVisible, shouldAutoContinue, type RunningTimer } from '../lib/timer';
import { useAppDispatch, useAppState } from '../store/StoreContext';
import type { FocusSession } from '../types';
import { useToast } from './useToast';

/* ============================================================================
   专注计时器（番茄钟 / 自习室）

   三条实现纪律：

   1. **剩余时间由时间戳算，不由 setInterval 累减**。
      浏览器在后台标签页会把 setInterval 压到 1 次/分钟甚至冻结，
      累减会「偷走」用户的专注时长。这里每次 tick 都拿 Date.now() 重算。

   2. **进行中的计时落独立的 key**（dt:app:v1.focus-running），不进主 payload。
      它天然是设备本地状态：手机在计时、电脑不该跟着跳倒计时。
      但刷新页面不能丢，所以单独持久化。

   3. **不足 1 分钟的专注不记录**。
      点错了立刻停掉，如果也写一条 8 秒的记录，热力图和统计会被噪点污染。
   ========================================================================= */

/** 最短记录时长：低于此值视为误触，丢弃 */
const MIN_RECORD_MS = 60_000;

/** tick 间隔。250ms 足够让秒数看起来在走，又不至于让 React 频繁重渲染 */
const TICK_MS = 250;

export type FocusPhase = 'idle' | 'focus' | 'break';

export interface FocusTimerApi {
  phase: FocusPhase;
  /** 计时中关联的任务；null = 自由专注 */
  taskId: string | null;
  /** 剩余毫秒（向上取整到秒，避免显示 00:00 却还没结束） */
  remainingMs: number;
  /** 本段总时长 */
  totalMs: number;
  /** 0–1，用于画环 */
  progress: number;
  /** 本段已过时长 */
  elapsedMs: number;
  start: (taskId?: string | null) => void;
  /** 结束当前段并记录（专注阶段）/ 跳过休息（休息阶段） */
  stop: () => void;
  /** 放弃当前段，不记录（误触） */
  cancel: () => void;
}

function createSessionId(): string {
  const maybeCrypto = globalThis.crypto as Crypto | undefined;
  if (maybeCrypto && typeof maybeCrypto.randomUUID === 'function') {
    return maybeCrypto.randomUUID();
  }
  return `f_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function useFocusTimer(): FocusTimerApi {
  const { settings, tasks } = useAppState();
  /**
   * 任务用 ref 取最新值：`finish` 是 useCallback，把 tasks 放进依赖会让
   * 每次任务变动都重建回调 —— 而它被三个按钮引用，重建没有意义。
   */
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const dispatch = useAppDispatch();
  const toast = useToast();

  const focusMs = Math.max(1, settings.focusMinutes) * 60_000;
  const breakMs = Math.max(0, settings.breakMinutes) * 60_000;

  /** 本段的起点与总长；null 表示当前没有在跑 */
  const runRef = useRef<RunningTimer | null>(null);
  const durationRef = useRef<number>(0);

  /**
   * 首次渲染就从 localStorage 接回上次没跑完的计时。
   * 用惰性初始化而不是 useEffect：否则会先闪一帧"idle"再跳成"计时中"。
   *
   * ⚠️ **必须按 mode 过滤**：三套计时共用同一个设备本地 key，
   * 不判 mode 就会把别人（秒表 / 提醒）留下的运行态当成番茄钟接走 ——
   * 倒计时按 wall clock 算成"已经专注了 x 分钟"，点「结束并记录」还会
   * 用秒表的 id 写一条伪造的 FOCUS_LOG，并把秒表的累计值连着抹掉。
   * 这一条与 useStopwatch / useReminder 的 boot 保持同款纪律。
   */
  const [boot] = useState<RunningTimer | null>(() => {
    const r = loadRunningTimer();
    return r && r.mode === 'pomodoro' ? r : null;
  });
  const [phase, setPhase] = useState<FocusPhase>(boot?.phase ?? 'idle');
  const [taskId, setTaskId] = useState<string | null>(boot?.taskId ?? null);
  const [remainingMs, setRemainingMs] = useState<number>(() => {
    if (!boot) return 0;
    const total = boot.phase === 'break' ? breakMs : focusMs;
    const passed = Date.now() - Date.parse(boot.startedAt);
    return Math.max(0, total - passed);
  });

  // 恢复出来的占位也要写回 runRef，否则第一次 tick 找不到起点
  if (boot && runRef.current === null) {
    runRef.current = boot;
    durationRef.current = boot.phase === 'break' ? breakMs : focusMs;
  }

  /**
   * 上一段专注挂的任务。
   *
   * 休息时 `taskId` 会被清成 null（休息不属于任何任务），但"休息完接着干哪件事"
   * 必须记住 —— 否则自动续接出来的下一段会是个没有归属的自由专注，
   * 用户回头看成"我明明一直在做高数，记录里却是空白"。
   */
  const lastTaskIdRef = useRef<string | null>(null);

  /**
   * 开一段专注。
   *
   * 抽成独立函数是因为它现在有**两个入口**：用户点「开始」，以及自动续接
   * （休息结束后自动开下一段）。复制一份的话，"记 id / 存运行态 / 设剩余时长"
   * 这三件事迟早在两条路径上走岔。
   */
  const beginFocus = useCallback(
    (id: string | null = null) => {
      const next: RunningTimer = {
        mode: 'pomodoro',
        id: createSessionId(),
        taskId: typeof id === 'string' && id ? id : null,
        startedAt: nowIso(),
        phase: 'focus',
        accumulatedMs: 0,
        running: true,
        durationMs: 0,
      };
      lastTaskIdRef.current = next.taskId;
      runRef.current = next;
      durationRef.current = focusMs;
      saveRunningTimer(next);
      setPhase('focus');
      setTaskId(next.taskId);
      setRemainingMs(focusMs);
    },
    [focusMs],
  );

  /**
   * 结束本段：专注 → 记一条 + 自动进休息；休息 → 回 idle。
   *
   * `auto` 表示"这段是**时间到了**自然结束的"，而不是用户手点的。
   * 自动续接只认自然结束 —— 用户点「结束」就是要停，这时候再开一段新计时
   * 是最惹人的一种"贴心"。
   */
  const finish = useCallback(
    (record: boolean, auto = false) => {
      const run = runRef.current;
      /**
       * 守卫：只收自己的运行态。
       * runRef 里若塞着别的模式（秒表暂停态、提醒），既不能用它的 id 记专注记录，
       * 更不能 `saveRunningTimer(null)` —— 那会把人家累计的时间静默抹掉。
       */
      if (!run || run.mode !== 'pomodoro') return;

      const total = durationRef.current;
      const startedMs = Date.parse(run.startedAt);
      const nowMs = Date.now();
      /** 真实流逝（可能远超计划：关页面很久才回来） */
      const wallMs = Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : 0;
      const elapsed = Math.min(total, wallMs);
      const abandoned = isAbandonedFocus(wallMs, total);

      runRef.current = null;
      saveRunningTimer(null);

      if (run && run.phase === 'focus' && record && elapsed >= MIN_RECORD_MS && !abandoned) {
        const session: FocusSession = {
          id: run.id,
          taskId: run.taskId,
          // 归属日按日界换算：熬夜到凌晨 1 点仍算前一天
          date: resolveSessionDate(run.startedAt, settings.dayStartHour),
          startedAt: run.startedAt,
          /**
           * ⚠️ `endedAt` 必须是 **startedAt + elapsed**，不能取 `new Date()`。
           *
           * 统计口径（`lib/focus.ts::sessionMs`）只认 `endedAt - startedAt`，
           * 明写"不信 durationMs"。原来这里写了现在的时间：关页面 8 小时后
           * 重新打开 → 记录里 startedAt 在 8 小时前、endedAt 是现在 →
           * 统计出 **8 小时**，而 Toast 却告诉用户"专注 25 分钟"。
           * 两边口径必须一致，否则今日/本周专注、热力图、连续打卡、周报全被污染。
           */
          endedAt: focusEndAt(run.startedAt, elapsed),
          durationMs: elapsed,
          /**
           * 科目冗余（F2）：从关联任务取分类名存下来。
           * 不冗余的话，任务一删，这段专注就从"科目维度"里消失了 ——
           * 而我在高数上花过多少小时，不该因为我删了一条待办就归零。
           */
          ...(() => {
            const task = run.taskId
              ? tasksRef.current.find((item) => item.id === run.taskId)
              : undefined;
            return task?.category ? { category: task.category } : {};
          })(),
        };
        dispatch({ type: 'FOCUS_LOG', session });
        toast.show(`专注 ${formatFocusDuration(elapsed)}，已记录`, null, TOAST_TIMEOUT.info);
      } else if (run.phase === 'focus' && record && abandoned) {
        toast.show('这段计时跨了太久（可能忘了结束），未记录', null, TOAST_TIMEOUT.info, 'warn');
      }

      /**
       * 自动续接（F16）的**唯一**闸门。
       *
       * 三个条件缺一不可：开了开关、这段是自然结束的、页面还可见。
       * 第三条是防假数据的底线：切走标签页 / 锁屏时不续接 ——
       * 否则一段接一段地跑，记录里会堆满"人不在场"的专注时长。
       */
      const autoStart = (message: string): boolean => {
        if (!shouldAutoContinue({ enabled: settings.autoContinue, auto, visible: isDocumentVisible() })) {
          return false;
        }
        beginFocus(lastTaskIdRef.current);
        toast.show(message, null, TOAST_TIMEOUT.info);
        return true;
      };

      /*
        专注结束后自动进休息；休息时长为 0 就直接回 idle（或续一段）。

        ⚠️ `record` 必须参与判定：**放弃了就不该进休息**。
        少了它，点「放弃」（= `finish(false, false)`）会照样开一段休息；
        而休息是 tick 自然结束的（`finish(true, true)`，auto=true），
        于是自动续接开关一开，放弃之后会**自己再开一段专注** ——
        和"点放弃就是要停"完全相反。严格模式中断走的也是 cancel()，
        同一条路径同样会白开一段。
      */
      if (run?.phase === 'focus' && record && breakMs > 0) {
        const next: RunningTimer = {
          mode: 'pomodoro',
          id: createSessionId(),
          taskId: null,
          startedAt: nowIso(),
          phase: 'break',
          accumulatedMs: 0,
          running: true,
          durationMs: 0,
        };
        runRef.current = next;
        durationRef.current = breakMs;
        saveRunningTimer(next);
        setPhase('break');
        setTaskId(null);
        setRemainingMs(breakMs);
        /**
         * 进休息时给一句提示。**这一句是必要的**：否则用户会以为
         * "休息也在自动跑，那我是不是被埋了" —— 说清楚"休息完会自动继续"，
         * 他才知道要不要去关掉开关。
         */
        if (
          shouldAutoContinue({ enabled: settings.autoContinue, auto, visible: isDocumentVisible() })
        ) {
          toast.show('休息开始，休息完会自动继续', null, TOAST_TIMEOUT.info);
        }
        return;
      }

      // 休息时长为 0：直接开始下一段（连续番茄），否则回 idle
      if (run?.phase === 'focus' && autoStart('已自动开始下一段')) return;

      // 休息结束：续下一段专注，或者回 idle
      if (run?.phase === 'break' && autoStart('休息结束，已自动开始下一段')) return;

      setPhase('idle');
      setTaskId(null);
      setRemainingMs(0);
      durationRef.current = 0;
    },
    [beginFocus, breakMs, dispatch, settings.autoContinue, settings.dayStartHour, toast],
  );

  // tick：每 250ms 用时间戳重算剩余，绝不做减法累加
  useEffect(() => {
    if (phase === 'idle') return undefined;

    const tick = (): void => {
      const run = runRef.current;
      if (!run) return;
      const left = durationRef.current - (Date.now() - Date.parse(run.startedAt));
      setRemainingMs(Math.max(0, left));
      if (left <= 0) finish(true, true);
    };

    tick(); // 立刻对齐一次，避免首帧显示满时长
    const timer = setInterval(tick, TICK_MS);
    return () => clearInterval(timer);
  }, [phase, finish]);

  /** 对外暴露的「开始」= 同一个 beginFocus（只有一条开计时的路径） */
  const start = beginFocus;

  /** 手动停止：专注阶段按"已过时长"记录（够 1 分钟才算），休息阶段直接跳过 */
  const stop = useCallback(() => {
    // 手点「结束」= 我要停，**不**自动开下一段
    finish(true, false);
  }, [finish]);

  /** 放弃：不记录。用于点错了 / 临时被打断又不想污染统计 */
  const cancel = useCallback(() => {
    finish(false, false);
  }, [finish]);

  /**
   * 跨标签页让位。
   *
   * 只清**内存**、一个字节都不写盘：让位方要是回写，两个标签页会互相清对方的
   * 运行态，抖成 ping-pong；而且这一段没跑完，绝不能写 FOCUS_LOG。
   */
  const yieldToOtherTab = useCallback(
    (reason: 'taken-over' | 'cleared') => {
      runRef.current = null;
      durationRef.current = 0;
      setPhase('idle');
      setTaskId(null);
      setRemainingMs(0);
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

  const totalMs = phase === 'break' ? breakMs : phase === 'focus' ? focusMs : 0;
  const elapsedMs = Math.max(0, totalMs - remainingMs);

  return useMemo(
    () => ({
      phase,
      taskId,
      remainingMs,
      totalMs,
      progress: totalMs === 0 ? 0 : Math.min(1, Math.max(0, elapsedMs / totalMs)),
      elapsedMs,
      start,
      stop,
      cancel,
    }),
    [phase, taskId, remainingMs, totalMs, elapsedMs, start, stop, cancel],
  );
}
