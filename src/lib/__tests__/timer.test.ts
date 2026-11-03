import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REMINDER_PRESETS,
  MIN_RECORD_MS,
  newTimerId,
  timerElapsedMs,
  timerRemainingMs,
  timerRingProgress,
  type RunningTimer,
  type TimerMode,
} from '../timer';

/* ============================================================================
   计时纯函数：三种模式的 elapsed / remaining / ring progress
   —— 全部按时间戳派生，不依赖 React / localStorage
   ========================================================================= */

function makeTimer(overrides: Partial<RunningTimer> & { mode: TimerMode }): RunningTimer {
  return {
    id: 't1',
    startedAt: new Date(Date.now() - 10_000).toISOString(),
    taskId: null,
    phase: 'focus',
    accumulatedMs: 0,
    running: true,
    durationMs: 0,
    ...overrides,
  };
}

const NOW = Date.now();

describe('常量与 id', () => {
  it('DEFAULT_REMINDER_PRESETS 是 [5,15,25,45,60]', () => {
    expect([...DEFAULT_REMINDER_PRESETS]).toEqual([5, 15, 25, 45, 60]);
  });

  it('MIN_RECORD_MS = 60000', () => {
    expect(MIN_RECORD_MS).toBe(60_000);
  });

  it('newTimerId 返回非空字符串（优先 uuid，降级随机串）', () => {
    const id = newTimerId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });
});

describe('番茄钟', () => {
  it('elapsed = now - startedAt（夹到 ≥0）', () => {
    const t = makeTimer({ mode: 'pomodoro', startedAt: new Date(NOW - 10_000).toISOString() });
    expect(timerElapsedMs(t, NOW, 60_000, 5_000)).toBe(10_000);
  });

  it('remaining = total - elapsed 夹到 ≥0', () => {
    const t = makeTimer({ mode: 'pomodoro', startedAt: new Date(NOW - 10_000).toISOString() });
    expect(timerRemainingMs(t, NOW, 60_000, 5_000)).toBe(50_000);
  });

  it('remaining 不会变负（超时后夹 0）', () => {
    const t = makeTimer({ mode: 'pomodoro', startedAt: new Date(NOW - 99_000).toISOString() });
    expect(timerRemainingMs(t, NOW, 60_000, 5_000)).toBe(0);
  });

  it('break 阶段用 breakMs 当 total', () => {
    const t = makeTimer({
      mode: 'pomodoro',
      phase: 'break',
      startedAt: new Date(NOW - 2_000).toISOString(),
    });
    expect(timerRemainingMs(t, NOW, 60_000, 5_000)).toBe(3_000);
    expect(timerElapsedMs(t, NOW, 60_000, 5_000)).toBe(2_000);
  });

  it('ring progress = elapsed / total，夹到 [0,1]', () => {
    const started = new Date(NOW - 15_000).toISOString();
    const t = makeTimer({ mode: 'pomodoro', startedAt: started });
    // 15s / 60s = 0.25
    expect(timerRingProgress(t, NOW, 60_000, 5_000)).toBeCloseTo(0.25, 5);
    // 边界：刚开始 0
    const zero = makeTimer({ mode: 'pomodoro', startedAt: new Date(NOW).toISOString() });
    expect(timerRingProgress(zero, NOW, 60_000, 5_000)).toBe(0);
    // 边界：超时满圈
    const over = makeTimer({ mode: 'pomodoro', startedAt: new Date(NOW - 99_000).toISOString() });
    expect(timerRingProgress(over, NOW, 60_000, 5_000)).toBe(1);
  });
});

describe('秒表', () => {
  it('elapsed = accumulatedMs + (running ? now - startedAt : 0)', () => {
    const t = makeTimer({
      mode: 'stopwatch',
      accumulatedMs: 60_000,
      startedAt: new Date(NOW - 5_000).toISOString(),
      running: true,
    });
    expect(timerElapsedMs(t, NOW, 0, 0)).toBe(65_000);
  });

  it('暂停后不累计 live 时间，只算 accumulatedMs', () => {
    const t = makeTimer({
      mode: 'stopwatch',
      accumulatedMs: 60_000,
      startedAt: new Date(NOW - 999_000).toISOString(),
      running: false,
    });
    expect(timerElapsedMs(t, NOW, 0, 0)).toBe(60_000);
  });

  it('remaining 恒为 null（秒表无"剩余"概念）', () => {
    const t = makeTimer({ mode: 'stopwatch', startedAt: new Date(NOW - 5_000).toISOString() });
    expect(timerRemainingMs(t, NOW, 0, 0)).toBeNull();
  });

  it('ring progress 是"当前一分钟"内的占比（秒针式）', () => {
    const t = makeTimer({
      mode: 'stopwatch',
      accumulatedMs: 0,
      startedAt: new Date(NOW - 20_000).toISOString(), // 走过了 20s
      running: true,
    });
    // 20s 落在第 1 分钟 → 20/60
    expect(timerRingProgress(t, NOW, 0, 0)).toBeCloseTo(20 / 60, 5);
    // 走过了 1m20s → 落在第 2 分钟的第 20s → 仍 20/60
    const t2 = makeTimer({
      mode: 'stopwatch',
      accumulatedMs: 0,
      startedAt: new Date(NOW - 80_000).toISOString(),
      running: true,
    });
    expect(timerRingProgress(t2, NOW, 0, 0)).toBeCloseTo(20 / 60, 5);
  });

  it('暂停累加后再继续：elapsed 续算', () => {
    // 暂停态：accumulatedMs=60s，startedAt 是更早的无效时刻
    const paused = makeTimer({
      mode: 'stopwatch',
      accumulatedMs: 60_000,
      startedAt: new Date(NOW - 1_000_000).toISOString(),
      running: false,
    });
    expect(timerElapsedMs(paused, NOW, 0, 0)).toBe(60_000);
    // 继续：startedAt 重置为"现在"，running=true
    const resumed = makeTimer({
      mode: 'stopwatch',
      accumulatedMs: 60_000,
      startedAt: new Date(NOW - 7_000).toISOString(),
      running: true,
    });
    expect(timerElapsedMs(resumed, NOW, 0, 0)).toBe(67_000);
  });
});

describe('提醒', () => {
  it('remaining = duration - elapsed 夹到 ≥0', () => {
    const t = makeTimer({
      mode: 'reminder',
      durationMs: 60_000,
      startedAt: new Date(NOW - 10_000).toISOString(),
    });
    expect(timerRemainingMs(t, NOW, 0, 0)).toBe(50_000);
    expect(timerElapsedMs(t, NOW, 0, 0)).toBe(10_000);
  });

  it('到点后 remaining=0', () => {
    const t = makeTimer({
      mode: 'reminder',
      durationMs: 60_000,
      startedAt: new Date(NOW - 61_000).toISOString(),
    });
    expect(timerRemainingMs(t, NOW, 0, 0)).toBe(0);
  });

  it('ring progress = 1 - remaining/duration，到点满圈', () => {
    const t = makeTimer({
      mode: 'reminder',
      durationMs: 60_000,
      startedAt: new Date(NOW - 15_000).toISOString(),
    });
    expect(timerRingProgress(t, NOW, 0, 0)).toBeCloseTo(15 / 60, 5);
    const done = makeTimer({
      mode: 'reminder',
      durationMs: 60_000,
      startedAt: new Date(NOW - 60_000).toISOString(),
    });
    expect(timerRingProgress(done, NOW, 0, 0)).toBe(1);
  });
});
