import { useEffect } from 'react';
import { TOAST_TIMEOUT } from '../constants';
import { loadRunningTimer, peekRunningTimerRaw, saveRunningTimer } from '../lib/storage';
import { playBeep } from '../lib/sound';
import { showNotification } from './useReminders';
import { useToast } from './useToast';

/* ============================================================================
   提醒到点 watcher（App 级，常驻）

   为什么放在 App 而不是某个视图 / useReminder hook 里：
   用户切到"今日 / 周"等其它视图后，ReminderPanel 已经卸载，hook 的 tick 也停了，
   但提醒必须到点仍响。所以用一个与视图无关、始终挂载的 watcher，
   每 ~250ms 读一次设备本地的 RunningTimer：
   - 若 mode==='reminder' 且「现在 − 开始 ≥ 目标时长」且状态还在 → 弹系统通知 +
     Toast + 响铃，然后清空（saveRunningTimer(null) 保证只响一次）。
   ========================================================================= */

/**
 * 轮询间隔（毫秒）。
 *
 * 250ms 是没有理由的：提醒的精度需求是"分钟级"，而 250ms 意味着**每秒 4 次**
 * 同步存储读取（localStorage 在安卓 WebView 上可能走 IPC）。改成 1s 之后
 * 最坏晚 1 秒响，感知不到，开销降到 1/4。
 */
const WATCH_MS = 1000;

export function useReminderWatcher(): void {
  const toast = useToast();

  useEffect(() => {
    /** 上一次看到的原始字符串：内容没变就不解析（绝大多数时候这个键是空的） */
    let lastRaw: string | null = null;

    const timer = setInterval(() => {
      /**
       * 先做一次**不解析**的轻量探测：没有任何计时器时（用户一天里的大多数时间）
       * `peek` 返回 null 或与上次相同，直接跳过 —— 省掉每秒一次的 JSON.parse。
       */
      const raw = peekRunningTimerRaw();
      if (raw === lastRaw) {
        // 内容没变：只在真的存在提醒计时器时才需要继续往下算（因为时间在走）
        if (!raw) return;
      }
      lastRaw = raw;
      let run = loadRunningTimer();
      // 状态已不存在（被取消 / 已响过）→ 不处理
      if (!run || run.mode !== 'reminder' || !run.running) return;

      const elapsed = Date.now() - Date.parse(run.startedAt);
      if (!Number.isFinite(elapsed) || elapsed < run.durationMs) return;

      const minutes = Math.round(run.durationMs / 60_000);
      // 先清，保证只响一次（哪怕下面的通知 / 响铃抛异常，下次也不会重复）
      saveRunningTimer(null);
      try {
        showNotification('计时结束', `你设置的 ${minutes} 分钟到了`);
      } catch {
        /* 通知失败不影响其余提示 */
      }
      toast.show('时间到', null, TOAST_TIMEOUT.info);
      playBeep();
      // run 置空，避免本次轮询周期内重复处理（虽然已 saveRunningTimer(null)）
      run = null;
    }, WATCH_MS);

    return () => clearInterval(timer);
  }, [toast]);
}
