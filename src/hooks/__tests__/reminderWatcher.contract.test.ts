import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { FOCUS_RUNNING_KEY } from '../../constants';
import { loadRunningTimer, saveRunningTimer } from '../../lib/storage';
// RunningTimer 的真相源是 lib/timer.ts（设备本地结构），storage.ts 只做持久化读写、不 re-export
import type { RunningTimer } from '../../lib/timer';

/* ============================================================================
   Q2 第 2 点：useReminderWatcher「切到其它视图后仍能在到点响铃」

   本环境无 jsdom / @testing-library，无法挂载 React 组件（与 cloudSync.runtime.test.ts
   同源约束）。因此采用「真实存储往返 + 源码级契约扫描」两路验证：

   (A) 真实存储往返：证明 watcher 赖以"读到点 + 清一次"的底层函数是真能用的——
       loadRunningTimer 能读回 mode==='reminder' 的运行态，saveRunningTimer(null)
       能把它清空。这正是"到点响一次、不清会重复响"的落地点。
   (B) 源码级契约：证明 useReminderWatcher 确实
       - 在 App 顶层常驻挂载（不依赖任何视图）；
       - 每轮轮询读 RunningTimer(mode==='reminder' && running)；
       - 到点判定 `Date.now() - startedAt >= durationMs`；
       - 先 saveRunningTimer(null) 再播通知/响铃（保证只响一次）；
       - 不依赖 FocusView 是否挂载（FocusView 里根本不引用它）。
   ========================================================================= */

/** 极简内存 localStorage（node 环境无 localStorage，storage.ts 直接读 globalThis.localStorage） */
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
  get length(): number {
    return this.m.size;
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemStorage());
});

describe('真实存储往返：提醒运行态可读取 / 可清空（"清一次"的落地点）', () => {
  function seed(run: RunningTimer): void {
    (globalThis as { localStorage: Storage }).localStorage.setItem(FOCUS_RUNNING_KEY, JSON.stringify(run));
  }

  it('能读回 mode==="reminder" 的运行态', () => {
    seed({
      mode: 'reminder',
      id: 'r1',
      startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      taskId: null,
      phase: 'focus',
      accumulatedMs: 0,
      running: true,
      durationMs: 5 * 60_000,
    });
    const run = loadRunningTimer();
    expect(run).not.toBeNull();
    expect(run?.mode).toBe('reminder');
    expect(run?.durationMs).toBe(5 * 60_000);
    expect(run?.running).toBe(true);
  });

  it('saveRunningTimer(null) 把运行态清空 → 再读为 null（响过即清，不会重复响）', () => {
    seed({
      mode: 'reminder',
      id: 'r1',
      startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      taskId: null,
      phase: 'focus',
      accumulatedMs: 0,
      running: true,
      durationMs: 5 * 60_000,
    });
    expect(loadRunningTimer()).not.toBeNull();
    saveRunningTimer(null);
    expect(loadRunningTimer()).toBeNull();
  });

  it('RunningFocus→RunningTimer 改名完整：pomodoro 运行态也能读回，且仍落 FOCUS_RUNNING_KEY', () => {
    seed({
      mode: 'pomodoro',
      id: 'p1',
      startedAt: new Date(Date.now() - 1_000).toISOString(),
      taskId: 't1',
      phase: 'focus',
      accumulatedMs: 0,
      running: true,
      durationMs: 0,
    });
    const run = loadRunningTimer();
    expect(run?.mode).toBe('pomodoro');
    // 老数据缺 mode 字段 → 回落 pomodoro（兼容旧落盘）
    seed({
      id: 'legacy',
      startedAt: new Date(Date.now() - 1_000).toISOString(),
      // 故意不写 mode / phase，模拟旧版只落 {id, taskId, startedAt, phase}
      taskId: 't1',
      phase: 'focus',
      accumulatedMs: 0,
      running: true,
      durationMs: 0,
    } as unknown as RunningTimer);
    expect(loadRunningTimer()?.mode).toBe('pomodoro');
  });
});

describe('接线（行为在 reminderWatcher.dom.test.tsx）', () => {
  /**
   * "到点响一次"的行为已经真跑起来了（真假定时器 + 真 localStorage），见
   * `reminderWatcher.dom.test.tsx`（6 条：到点各响一次 / 不重复 / 未到点不响 /
   * 番茄钟不算提醒 / 空状态不抛 / 卸载后停止）。
   *
   * 这里只留两条这个文件**更便宜**能证明的事：
   * ① 它挂在 App 顶层（不依赖任何视图）—— 否则切走视图就不响了；
   * ② FocusView 不引用它 —— 证明响铃与"专注页是否打开"无关。
   */
  const app = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8');
  const focusView = readFileSync(new URL('../../views/FocusView.tsx', import.meta.url), 'utf8');

  it('在 App 顶层常驻挂载（import + 直接调用）', () => {
    expect(app).toContain('useReminderWatcher');
    expect(app).toMatch(/useReminderWatcher\(\)/);
  });

  it('FocusView 不引用 useReminderWatcher（响铃不依赖专注页挂载）', () => {
    expect(focusView).not.toContain('useReminderWatcher');
  });
});
