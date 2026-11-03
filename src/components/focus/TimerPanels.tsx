import { useEffect, useRef, useState } from 'react';
import { TOAST_TIMEOUT } from '../../constants';
import { Icon } from '../common/Icon';
import { useFocusTimer, type FocusTimerApi } from '../../hooks/useFocusTimer';
import { useStopwatch } from '../../hooks/useStopwatch';
import { useReminder } from '../../hooks/useReminder';
import { useToast } from '../../hooks/useToast';
import { requestNotificationPermission } from '../../hooks/useReminders';
import { useAppState } from '../../store/StoreContext';
import { DEFAULT_REMINDER_PRESETS, MIN_RECORD_MS } from '../../lib/timer';
import { loadFocusPrefs, saveFocusPrefs } from '../../lib/storage';
import { unlockAudio } from '../../lib/sound';
import { formatClock, Ring } from './FocusRing';

/* ============================================================================
   三个计时器面板（番茄 / 秒表 / 提醒）+ 番茄外壳
   ----------------------------------------------------------------------------
   从 `views/FocusView.tsx` 拆出来。判据很简单：这三个面板**只依赖计时器 hook 与
   本地偏好**，不读任务、不读统计 —— 而它们原来和"统计仪表盘"挤在同一个 746 行的
   文件里，改一个面板的排版要先滑过整个仪表盘。
   ========================================================================= */

export function PomodoroPanel({ timer, focusMinutes, breakMinutes }: { timer: FocusTimerApi; focusMinutes: number; breakMinutes: number }) {
  const isBreak = timer.phase === 'break';
  const running = timer.phase !== 'idle';

  return (
    <div className="mt-4 card p-5">
      <div className="flex flex-col items-center">
        <Ring progress={timer.progress} muted={isBreak}>
          <span
            data-testid="focus-clock"
            className="tnum font-num text-h1 font-bold leading-none tracking-[-0.02em]"
          >
            {running ? formatClock(timer.remainingMs) : `${focusMinutes}:00`}
          </span>
          <span className="mt-2 text-label font-semibold text-ink-2">
            {isBreak ? '休息一下' : running ? '专注中' : '准备好就开始'}
          </span>
        </Ring>

        <div className="mt-5 flex items-center gap-2">
          {!running ? (
            <button
              type="button"
              data-testid="focus-start"
              onClick={() => timer.start(null)}
              className="btn btn-primary min-w-28"
            >
              <Icon name="play" size={16} />
              开始专注
            </button>
          ) : (
            <>
              <button
                type="button"
                data-testid="focus-stop"
                onClick={timer.stop}
                className="btn btn-primary min-w-24"
              >
                <Icon name="pause" size={16} />
                {isBreak ? '跳过休息' : '结束并记录'}
              </button>
              <button
                type="button"
                data-testid="focus-cancel"
                onClick={timer.cancel}
                className="btn btn-outlined"
              >
                放弃
              </button>
            </>
          )}
        </div>

        <p className="mt-3 text-center text-label leading-relaxed text-ink-2">
          {focusMinutes} 分钟一段 · 结束后自动进入 {breakMinutes} 分钟休息
          <br />
          不足 1 分钟不计入统计
        </p>
      </div>
    </div>
  );
}

/* ============================================================================
   秒表面板：mm:ss 向上走，环按"当前一分钟"扫圈
   ========================================================================= */

export function StopwatchPanel() {
  const sw = useStopwatch();
  const running = sw.phase === 'running';
  const paused = sw.phase === 'paused';
  const canRecord = paused && sw.elapsedMs >= MIN_RECORD_MS;
  const minutes = Math.max(1, Math.round(sw.elapsedMs / 60_000));

  return (
    <div className="mt-4 card p-5">
      <div className="flex flex-col items-center">
        <Ring progress={sw.progress} muted={!running}>
          <span
            data-testid="stopwatch-clock"
            className="tnum font-num text-h1 font-bold leading-none tracking-[-0.02em]"
          >
            {formatClock(sw.elapsedMs)}
          </span>
          <span className="mt-2 text-label font-semibold text-ink-2">
            {running ? '计时中' : paused ? '已暂停' : '准备好就开始'}
          </span>
        </Ring>

        <div className="mt-5 flex items-center gap-2">
          {sw.phase === 'idle' ? (
            <button
              type="button"
              data-testid="stopwatch-start"
              onClick={sw.start}
              className="btn btn-primary min-w-28"
            >
              <Icon name="play" size={16} />
              开始计时
            </button>
          ) : null}
          {running ? (
            <>
              <button
                type="button"
                data-testid="stopwatch-pause"
                onClick={sw.pause}
                className="btn btn-primary min-w-24"
              >
                <Icon name="pause" size={16} />
                暂停
              </button>
              <button
                type="button"
                data-testid="stopwatch-reset"
                onClick={sw.reset}
                className="btn btn-outlined"
              >
                重置
              </button>
            </>
          ) : null}
          {paused ? (
            <>
              <button
                type="button"
                data-testid="stopwatch-resume"
                onClick={sw.resume}
                className="btn btn-primary min-w-24"
              >
                <Icon name="play" size={16} />
                继续
              </button>
              <button
                type="button"
                data-testid="stopwatch-reset"
                onClick={sw.reset}
                className="btn btn-outlined"
              >
                重置
              </button>
            </>
          ) : null}
        </div>

        {canRecord ? (
          <button
            type="button"
            data-testid="stopwatch-record"
            onClick={sw.record}
            className="btn btn-primary mt-3"
          >
            记录这段到专注统计（{minutes} 分钟）
          </button>
        ) : null}

        <p className="mt-3 text-center text-label leading-relaxed text-ink-2">
          自由专注 · 暂停不计时 · 满 1 分钟才能记录
        </p>
      </div>
    </div>
  );
}

/* ============================================================================
   提醒面板：一排预设胶囊 + 自定义分钟；计时中显示剩余与取消
   ========================================================================= */

export function ReminderPanel() {
  const reminder = useReminder();
  const [presets, setPresets] = useState<number[]>(() => {
    const loaded = loadFocusPrefs().reminderPresets;
    const base = loaded.length ? loaded : [...DEFAULT_REMINDER_PRESETS];
    const merged = [...base];
    for (const d of DEFAULT_REMINDER_PRESETS) {
      if (!merged.includes(d)) merged.push(d);
    }
    return merged.slice(0, 8);
  });
  const [custom, setCustom] = useState('');
  const running = reminder.phase === 'running';

  /** 开始一个 N 分钟的提醒（先要通知权限 + 解锁音频，再写计时） */
  const begin = (minutes: number): void => {
    const safe = Math.max(1, Math.trunc(minutes));
    const ms = safe * 60_000;
    // 先要通知权限，再解锁音频（音频需用户手势后才能播放）
    void requestNotificationPermission().then(() => unlockAudio());
    reminder.start(ms);
    // 自定义值追加进预设并持久化（封顶 8 个，避免列表无限增长）
    if (safe > 0 && !presets.includes(safe) && presets.length < 8) {
      const next = [...presets, safe].slice(0, 8);
      setPresets(next);
      saveFocusPrefs({ mode: 'reminder', reminderPresets: next });
    }
  };

  const onCustomSubmit = (): void => {
    const minutes = Number(custom);
    if (!custom.trim() || !Number.isFinite(minutes) || minutes <= 0) return;
    begin(minutes);
    setCustom('');
  };

  return (
    <div className="mt-4 card p-5">
      <div className="flex flex-col items-center">
        {running ? (
          <Ring progress={reminder.durationMs > 0 ? 1 - reminder.remainingMs / reminder.durationMs : 0}>
            <span
              data-testid="reminder-clock"
              className="tnum font-num text-h1 font-bold leading-none tracking-[-0.02em]"
            >
              {formatClock(reminder.remainingMs)}
            </span>
            <span className="mt-2 text-label font-semibold text-ink-2">还剩 {formatClock(reminder.remainingMs)}</span>
          </Ring>
        ) : (
          <>
            <div className="flex flex-wrap justify-center gap-2">
              {presets.map((m) => (
                <button
                  key={m}
                  type="button"
                  data-testid={`reminder-preset-${m}`}
                  onClick={() => begin(m)}
                  className="btn btn-outlined min-w-20"
                >
                  {m} 分钟
                </button>
              ))}
            </div>
            <div className="mt-3 flex items-center justify-center gap-2">
              <input
                type="number"
                min={1}
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onCustomSubmit();
                }}
                placeholder="自定义分钟"
                aria-label="自定义提醒分钟"
                className="h-10 w-32 field px-3 text-body-sm text-ink "
 />
 <button
 type="button"
 data-testid="reminder-custom"
 onClick={onCustomSubmit}
 className="btn btn-primary"
              >
                开始提醒
              </button>
            </div>
          </>
        )}

        {running ? (
          <button
            type="button"
            data-testid="reminder-cancel"
            onClick={reminder.cancel}
            className="btn btn-outlined mt-5"
          >
            取消提醒
          </button>
        ) : null}
      </div>

      <p className="mt-3 text-center text-label leading-relaxed text-ink-2">
        到点弹系统通知 + 响铃 · 不计入专注统计
      </p>
    </div>
  );
}

/**
 * 专注视图 —— 自习室式的一天。
 *
 * 顶部一个模式切换：番茄钟 / 秒表 / 提醒。计时区块按模式拆成三个面板；
 * 周围的"今天学了多久"证据（三指标 + 35 天热力图 + 本周时间去向 + 今日明细）
 * 只在「非提醒」模式下展示 —— 提醒不计入专注统计，不必给空数据。
 */

/**
 * 番茄钟面板壳：在此挂载 useFocusTimer，保证切回时从设备本地接回。
 *
 * **自动开局只在这里消费一次**（不能让 FocusView 也消费：两处各自调 start
 * 会凭空多开一段，专注时长翻倍、还多出一条伪造记录）。
 * `autoStartTaskId` 由「任务行 ▷ / 抽屉开始专注」带过来，两个前提：
 * ① 当前确实没有在跑（`timer.phase === 'idle'`）—— 已经在跑同一项时进来
 * 只应该"看到它继续跑"，绝不能重开；
 * ② 同一个 id 只消费一次（consumedRef），父级的 pending 清理是异步的，
 * 清完之前可能又渲染一帧。
 */
/** 严格模式：离开多久算中断。5 秒足够过滤「切一下标签页就回来」，也够严到能防刷手机 */
const STRICT_AWAY_MS = 5_000;
export function PomodoroPanelInner({
 focusMinutes,
 breakMinutes,
 autoStartTaskId = null,
 onAutoStartConsumed,
}: {
 focusMinutes: number;
 breakMinutes: number;
 autoStartTaskId?: string | null;
 onAutoStartConsumed?: () => void;
}) {
 const timer = useFocusTimer();
 const consumedRef = useRef<string | null>(null);
 const { settings } = useAppState();
 const toast = useToast();
 /**
 * 严格模式（F6）：专注期间**离开本页超过 5 秒**视为中断，这段不记录。
 *
 * 只监听 `visibilitychange`（切标签页 / 最小化 / 切到别的应用），
 * 不监听视图切换 —— 在应用内从"专注"点到"今日"看一眼清单是正常操作，
 * 把它算成中断只会让人不敢用。
 *
 * 番茄ToDo 的经验：真正有用的是这个开关，而不是常驻锁机
 * （锁机要权限、要后台常驻，代价大得多）。
 */
 const timerRef = useRef(timer);
 timerRef.current = timer;
 useEffect(() => {
 let hiddenAt: number | null = null;
 const onVisibility = () => {
 if (document.visibilityState === 'hidden') {
 hiddenAt = Date.now();
 return;
 }
 if (hiddenAt === null) return;
 const away = Date.now() - hiddenAt;
 hiddenAt = null;
 if (!settings.strictFocus) return;
 if (away < STRICT_AWAY_MS) return;
 if (timerRef.current.phase !== 'focus') return;
 timerRef.current.cancel();
 toast.show('严格模式：离开超过 5 秒，这段专注未计入', null, TOAST_TIMEOUT.info, 'warn');
 };
 document.addEventListener('visibilitychange', onVisibility);
 return () => document.removeEventListener('visibilitychange', onVisibility);
 }, [settings.strictFocus, toast]);
 useEffect(() => {
 if (!autoStartTaskId) return;
 if (consumedRef.current === autoStartTaskId) return;
 consumedRef.current = autoStartTaskId;
 if (timer.phase === 'idle') timer.start(autoStartTaskId);
 // 无论是否真的 start，这次意图都算消费完 —— 清掉 pending，避免留下"待开局"
 onAutoStartConsumed?.();
 }, [autoStartTaskId, onAutoStartConsumed, timer]);
 return <PomodoroPanel timer={timer} focusMinutes={focusMinutes} breakMinutes={breakMinutes} />;
}
