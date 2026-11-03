import { describe, expect, it } from 'vitest';
import {
  MIN_RECORD_MS,
  timerElapsedMs,
  timerRemainingMs,
  timerRingProgress,
  type RunningTimer,
  type TimerMode,
} from '../timer';

/* ============================================================================
   计时纯函数：边界补强（Q2 第 1 点要求"检查边界，不足请补"）

   重点覆盖：
   - remaining 永远夹到 ≥0（超时后不为负）
   - ring progress 永远落在 [0,1]（超长 / 负时长都不溢出）
   - 秒表 ring 在"整分钟"边界归零（秒针式）
   - elapsed 在 startedAt 晚于 now 时被夹到 0（负值不暴露）
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

describe('remaining 永不越界', () => {
  it('番茄钟超时后 remaining 夹 0（不为负）', () => {
    const t = makeTimer({ mode: 'pomodoro', startedAt: new Date(NOW - 99_000).toISOString() });
    expect(timerRemainingMs(t, NOW, 60_000, 5_000)).toBe(0);
  });

  it('提醒超时后 remaining 夹 0（不为负）', () => {
    const t = makeTimer({
      mode: 'reminder',
      durationMs: 5_000,
      startedAt: new Date(NOW - 30_000).toISOString(),
    });
    expect(timerRemainingMs(t, NOW, 0, 0)).toBe(0);
  });

  it('番茄钟 startedAt 晚于 now（时钟回拨）→ elapsed 夹 0，remaining = 满档', () => {
    const future = new Date(NOW + 10_000).toISOString();
    const t = makeTimer({ mode: 'pomodoro', startedAt: future });
    expect(timerElapsedMs(t, NOW, 60_000, 5_000)).toBe(0);
    expect(timerRemainingMs(t, NOW, 60_000, 5_000)).toBe(60_000);
  });
});

describe('ring progress 永远落在 [0,1]', () => {
  it('番茄钟：超长 elapsed 溢出门被夹到 1', () => {
    const t = makeTimer({ mode: 'pomodoro', startedAt: new Date(NOW - 999_000).toISOString() });
    const p = timerRingProgress(t, NOW, 60_000, 5_000);
    expect(p).toBe(1);
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThanOrEqual(1);
  });

  it('番茄钟：负 elapsed 场景（startedAt 在未来）→ 夹到 0', () => {
    const t = makeTimer({ mode: 'pomodoro', startedAt: new Date(NOW + 5_000).toISOString() });
    const p = timerRingProgress(t, NOW, 60_000, 5_000);
    expect(p).toBe(0);
  });

  it('提醒：durationMs <= 0 → 直接 0（不除零、不 NaN）', () => {
    const t = makeTimer({
      mode: 'reminder',
      durationMs: 0,
      startedAt: new Date(NOW - 1_000).toISOString(),
    });
    const p = timerRingProgress(t, NOW, 0, 0);
    expect(p).toBe(0);
  });

  it('提醒：超长到点后 ring 满圈且仍 ≤1', () => {
    const t = makeTimer({
      mode: 'reminder',
      durationMs: 5_000,
      startedAt: new Date(NOW - 60_000).toISOString(),
    });
    const p = timerRingProgress(t, NOW, 0, 0);
    expect(p).toBe(1);
    expect(p).toBeLessThanOrEqual(1);
  });

  it('秒表 ring：恰好走过整分钟时归零（秒针式扫圈）', () => {
    const t = makeTimer({
      mode: 'stopwatch',
      accumulatedMs: 0,
      startedAt: new Date(NOW - 60_000).toISOString(),
      running: true,
    });
    // 走过 60_000ms → mod 60_000 = 0 → 进度回零
    expect(timerRingProgress(t, NOW, 0, 0)).toBeCloseTo(0, 5);
  });

  it('秒表 ring：走过 1m30s → 落在第 2 分钟的第 30s → 0.5', () => {
    const t = makeTimer({
      mode: 'stopwatch',
      accumulatedMs: 0,
      startedAt: new Date(NOW - 90_000).toISOString(),
      running: true,
    });
    expect(timerRingProgress(t, NOW, 0, 0)).toBeCloseTo(0.5, 5);
  });

  it('各种模式/时长的 ring 批量不越界', () => {
    // focus / brk 是可选：下面用 `c.focus ?? 0` 取值，reminder / stopwatch 用例不传
    const cases: Array<Partial<RunningTimer> & { mode: TimerMode; focus?: number; brk?: number }> = [
      { mode: 'pomodoro', startedAt: new Date(NOW - 1).toISOString(), focus: 1000, brk: 1000 },
      { mode: 'pomodoro', startedAt: new Date(NOW - 5_000_000).toISOString(), focus: 1000, brk: 1000 },
      { mode: 'reminder', durationMs: 1000, startedAt: new Date(NOW - 500).toISOString() },
      { mode: 'stopwatch', startedAt: new Date(NOW - 123_456).toISOString(), running: true },
    ];
    for (const c of cases) {
      const p = timerRingProgress(makeTimer(c), NOW, c.focus ?? 0, c.brk ?? 0);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });
});

describe('秒表 accumulatedMs 续算（Q2 第 1 点）', () => {
  it('暂停态累计值被原样保留，不随 wall-clock 漂移', () => {
    const paused = makeTimer({
      mode: 'stopwatch',
      accumulatedMs: 120_000,
      startedAt: new Date(NOW - 9_999_000).toISOString(),
      running: false,
    });
    // 暂停：live 段不计入，只算 accumulated
    expect(timerElapsedMs(paused, NOW, 0, 0)).toBe(120_000);
  });

  it('恢复后累计值 + 恢复后经过的时间', () => {
    const resumed = makeTimer({
      mode: 'stopwatch',
      accumulatedMs: 120_000,
      startedAt: new Date(NOW - 8_000).toISOString(),
      running: true,
    });
    expect(timerElapsedMs(resumed, NOW, 0, 0)).toBe(128_000);
  });
});

describe('MIN_RECORD_MS 阈值（秒表记录的门槛）', () => {
  it('= 60000（满 1 分钟才计入统计）', () => {
    expect(MIN_RECORD_MS).toBe(60_000);
  });

  it('≥60s 的累计应被判定为"可记录"', () => {
    const run: RunningTimer = makeTimer({
      mode: 'stopwatch',
      accumulatedMs: 65_000,
      startedAt: new Date(NOW).toISOString(),
      running: false,
    });
    expect(timerElapsedMs(run, NOW, 0, 0)).toBeGreaterThanOrEqual(MIN_RECORD_MS);
  });

  it('<60s 的累计应被判定为"不记录"', () => {
    const run: RunningTimer = makeTimer({
      mode: 'stopwatch',
      accumulatedMs: 50_000,
      startedAt: new Date(NOW).toISOString(),
      running: false,
    });
    expect(timerElapsedMs(run, NOW, 0, 0)).toBeLessThan(MIN_RECORD_MS);
  });
});
