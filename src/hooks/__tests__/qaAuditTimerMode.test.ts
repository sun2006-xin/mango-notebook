import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MIN_RECORD_MS, timerElapsedMs, timerRemainingMs, type RunningTimer } from '../../lib/timer';
import { loadRunningTimer, saveRunningTimer } from '../../lib/storage';
import { FOCUS_RUNNING_KEY } from '../../constants';

/* ============================================================================
   QA 审计（v0.7.0 新增计时工具集）：三套计时的"设备本地运行态"互相踩踏

   三套计时（番茄钟 / 秒表 / 提醒）共用同一个设备本地 key `FOCUS_RUNNING_KEY`，
   靠 `RunningTimer.mode` 区分。`useStopwatch` 与 `useReminder` 的 boot 都**先判 mode**
   再决定要不要接回：
     useStopwatch.ts:49-52   const r = loadRunningTimer(); return r && r.mode === 'stopwatch' ? r : null;
     useReminder.ts:32-35    const r = loadRunningTimer(); return r && r.mode === 'reminder'  ? r : null;
   只有 `useFocusTimer` **不判 mode**：
     useFocusTimer.ts:79     const [boot] = useState<RunningTimer | null>(() => loadRunningTimer());
   于是别人留下的运行态会被它当成番茄钟接走。

   能真正踩到的路径（FocusView 已确认，切模式只在"另一个模式正在跑"时才清理）：
     FocusView.tsx:359-367  onModeChange：
       const current = loadRunningTimer();
       if (current && current.mode !== next && current.running) { saveRunningTimer(null); ... }
                                                     ^^^^^^^^^^^^
       —— 只清 `running === true` 的。**暂停中的秒表 running === false，不会被清**。
   于是：秒表跑够 1 分钟后暂停（accumulatedMs 落盘、running=false）→ 切到「番茄钟」
   → `PomodoroPanelInner` 挂载 → `useFocusTimer` 把这条 stopwatch 当成番茄钟的 focus 段接走：
     - 面板直接显示"专注中"，倒计时 = focusMinutes −（秒表已经走过的真实时间）；
     - 用户点「结束并记录」→ `finish(true)` 用 `run.id`（秒表的 id）dispatch 一条
       FOCUS_LOG，**秒表的累计时长被记成一段番茄钟**；
     - `finish()` 里的 `saveRunningTimer(null)` 把暂停中的秒表连累计值一起抹掉。

   本环境不渲染 React，故采用「真实存储/纯函数 + 源码级契约」两路验证。

   ── 修复后（v0.7.1, P1-1）────────────────────────────────────────────
   A 组已翻转为**新契约**：useFocusTimer 的 boot 与 finish 都加了 mode 守卫、
   FocusView.onModeChange 的清理条件不再看 running，所以"暂停的秒表被番茄钟接走"
   这条**已经走不通**了（B 组保留的是它赖以成立的存储层事实）。
   ========================================================================= */

function makeStopwatch(over: Partial<RunningTimer>): RunningTimer {
  return {
    mode: 'stopwatch',
    id: 'sw_1',
    taskId: null,
    startedAt: new Date(Date.now() - 150_000).toISOString(), // 2.5 分钟前开始
    phase: 'focus',
    accumulatedMs: 90_000, // 暂停时已累计 1.5 分钟
    running: false, // ← 暂停中
    durationMs: 0,
    ...over,
  };
}

const SRC = {
  focus: readFileSync(new URL('../useFocusTimer.ts', import.meta.url), 'utf8'),
  stopwatch: readFileSync(new URL('../useStopwatch.ts', import.meta.url), 'utf8'),
  reminder: readFileSync(new URL('../useReminder.ts', import.meta.url), 'utf8'),
  focusView: readFileSync(new URL('../../views/FocusView.tsx', import.meta.url), 'utf8'),
};

/** 与 src/lib/__tests__/storage.test.ts 同款的极简内存 Storage（vitest 默认 node 环境） */
class MemoryStorage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  clear(): void {
    this.map.clear();
  }
}

let store: MemoryStorage;

beforeEach(() => {
  store = new MemoryStorage();
  vi.stubGlobal('localStorage', store);
});

afterEach(() => {
  store.removeItem(FOCUS_RUNNING_KEY);
  vi.unstubAllGlobals();
});

describe('A. 源码级契约：boot 必须按 mode 过滤', () => {
  it('A1 useStopwatch 的 boot 判了 mode（正面样本）', () => {
    expect(SRC.stopwatch).toMatch(/r\.mode === 'stopwatch'/);
  });

  it('A2 useReminder 的 boot 判了 mode（正面样本）', () => {
    expect(SRC.reminder).toMatch(/r\.mode === 'reminder'/);
  });

  /**
   * 修复后（P1-1）：boot 必须先判 mode 再决定要不要接回。
   * 秒表暂停态留在设备本地 key 上时，番茄钟若直接 load 过去，
   * 就会把"秒表已经走过的时间"当成"已经专注了多久"。
   */
  it('A3 useFocusTimer 的 boot 已按 mode 过滤（缺陷已修复）', () => {
    const boot = SRC.focus.match(/useState<RunningTimer \| null>\(\(\) => \{([\s\S]*?)\}\);/);
    expect(boot).not.toBeNull();
    expect(boot![1]).toContain('loadRunningTimer()');
    // 关键：只接回属于自己的那条（mode === 'pomodoro'）
    expect(boot![1]).toMatch(/mode/);
    expect(boot![1]).toContain("r.mode === 'pomodoro'");
  });

  it('A4 useFocusTimer 的 finish() 先判 mode 才清存储（不会抹掉别人的运行态）', () => {
    const finish = SRC.focus.slice(SRC.focus.indexOf('const finish = useCallback'), SRC.focus.indexOf('// tick：'));
    // 别人的运行态（秒表 / 提醒）一律不动：不记录、不清某一个更符合直觉的存储
    // ⚠️ 注释里也会提到 saveRunningTimer(null)，先剥注释再比位置，避免被注释误伤
    const code = finish
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/[^\n]*/g, '');
    expect(code).toMatch(/run\.mode !== 'pomodoro'/);
    expect(code).toContain('saveRunningTimer(null)');
    // 守卫必须写在清存储**之前**，否则仍然是"先抹掉再后悔"
    expect(code.indexOf("run.mode !== 'pomodoro'")).toBeLessThan(code.indexOf('saveRunningTimer(null)'));
  });

  /**
   * 修复后：清理条件只剩"模式不一致"。
   * 再看 `running` 的话，暂停中的秒表不会被清，切到番茄钟就被接走了 ——
   * 详见 useFocusTimer.boot / finish 的 mode 守卫。
   */
  it('A5 FocusView.onModeChange 按 mode 清理（暂停中的秒表一并清掉）', () => {
    const onChange = SRC.focusView.slice(
      SRC.focusView.indexOf('const onModeChange'),
      SRC.focusView.indexOf('const weekStart'),
    );
    // 清理口径：mode 不一致就清
    expect(onChange).toMatch(/current\.mode !== next/);
    // 不再看 running —— running===false（暂停中的秒表）必须在清理范围内
    expect(onChange).not.toMatch(/current\.running/);
    expect(onChange).not.toMatch(/running === false|!current\.running/);
  });
});

describe('B. 存储层事实：暂停的秒表原样落盘（番茄钟已不会再来接它）', () => {
  it('B1 loadRunningTimer 会把"暂停的秒表"原样返回（running=false）', () => {
    saveRunningTimer(makeStopwatch({}));
    const run = loadRunningTimer();

    expect(run).not.toBeNull();
    expect(run?.mode).toBe('stopwatch');
    expect(run?.running).toBe(false);
    expect(run?.accumulatedMs).toBe(90_000);
  });

  it('B2 同样的运行态被当成番茄钟 → 倒计时按 startedAt 直算，忽略 accumulatedMs', () => {
    const sw = makeStopwatch({});
    const now = Date.now();
    const focusMs = 25 * 60_000;

    // 秒表口径（正确）：累计值 + 本段
    const asStopwatch = timerElapsedMs(sw, now, focusMs, focusMs);
    // 番茄钟口径（useFocusTimer 的 tick 实际算法）：
    //   left = durationRef.current - (Date.now() - Date.parse(run.startedAt))
    const asPomodoro = now - Date.parse(sw.startedAt);

    // 暂停中的秒表已过 2.5 分钟，番茄钟却把它当成"专注已经走了 2.5 分钟"
    expect(asStopwatch).toBe(90_000); // 暂停不计时，只有累计的 1.5 分钟
    expect(asPomodoro).toBeGreaterThan(149_000); // 番茄钟按墙钟算了 2.5 分钟
    expect(asPomodoro).not.toBe(asStopwatch);
  });

  it('B3 此时剩余时间被算成 22:30 而不是 25:00（一进来就"专注了 2.5 分钟"）', () => {
    const sw = makeStopwatch({});
    const now = Date.now();
    const focusMs = 25 * 60_000;
    // useFocusTimer 的 remainingMs 初值：total - (now - startedAt)
    const remaining = Math.max(0, focusMs - (now - Date.parse(sw.startedAt)));
    expect(remaining).toBeLessThan(focusMs - 149_000 + 1);
    expect(remaining).toBeGreaterThan(0);
  });

  it('B4 若此时点「结束并记录」→ 会 dispatch 一条 FOCUS_LOG（秒表 id 被当成番茄钟记录）', () => {
    const sw = makeStopwatch({});
    const now = Date.now();
    // useFocusTimer.finish：elapsed = Math.min(total, now - startedAt)
    const elapsed = now - Date.parse(sw.startedAt);

    // 2.5 分钟 ≥ MIN_RECORD_MS(60s) → 满足记录门槛
    expect(elapsed).toBeGreaterThanOrEqual(MIN_RECORD_MS);
    // 记录的 id 直接沿用 run.id（秒表的 sw_1），durationMs 是按墙钟算的 2.5 分钟
    expect(sw.id).toBe('sw_1');
    expect(timerElapsedMs(sw, now, 0, 0)).toBe(90_000); // 真实秒表口径其实只有 1.5 分钟
  });

  it('B5 提醒模式同样会被 useFocusTimer 接走（durationMs 被当成 0，直接判"到点"）', () => {
    const reminder: RunningTimer = {
      mode: 'reminder',
      id: 'rm_1',
      taskId: null,
      startedAt: new Date(Date.now() - 30 * 60_000).toISOString(), // 30 分钟前起的 25 分钟提醒
      phase: 'focus',
      accumulatedMs: 0,
      running: true,
      durationMs: 25 * 60_000,
    };
    saveRunningTimer(reminder);

    const boot = loadRunningTimer();
    expect(boot?.mode).toBe('reminder');

    // 番茄钟口径：total = focusMs(25min)，走过 30 分钟 → left <= 0 → 立刻 finish(true)
    const focusMs = 25 * 60_000;
    const left = focusMs - (Date.now() - Date.parse(reminder.startedAt));
    expect(left).toBeLessThanOrEqual(0); // → 挂载瞬间就触发 finish
    // 而按提醒口径，它 5 分钟前就该响、且 watcher 早已清掉它了
    expect(timerRemainingMs(reminder, Date.now(), 0, 0)).toBe(0);
  });
});
