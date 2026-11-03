import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { reducer } from '../../store/reducer';
import { createEmptyState } from '../../store/reducer';
import type { FocusSession } from '../../types';

/* ============================================================================
   Q2 第 4 点：FocusView 仪表盘条件渲染 + 三模式切换 + 原 testid 保留

   本环境无法渲染 React，采用「源码级契约扫描 + 真实 reducer 行为」两路：
   - 仪表盘仅在 mode !== 'reminder' 渲染，且三个指标 / 35 天热力图 / 今日明细
     的 testid 都落在该条件块内；
   - Segmented 三模式（番茄钟 / 秒表 / 提醒）接通；
   - 原 data-testid（focus-clock/start/stop/cancel/today/week/streak/heatmap）全部保留；
   - 切模式若另一模式在跑先取消（toast『已停止上一个计时』）。
   另用真实 reducer 证明：FOCUS_LOG 记下来的 session 会进入 focusSessions
   （即仪表盘统计的数据源确实被写入），与"秒表/番茄钟记录到专注统计"闭环。
   ========================================================================= */

describe('P0 源码级：FocusView 仪表盘条件渲染 + 模式切换 + testid', () => {
  function read(): string {
    return readFileSync(new URL('../FocusView.tsx', import.meta.url), 'utf8');
  }

  /**
   * v0.29.6 拆分后，计时器面板（含 `focus-clock / focus-start / focus-stop /
   * focus-cancel` 四个 testid）搬到了 `components/focus/TimerPanels.tsx`。
   * 断言「这些 testid 必须还在」不变，只是要找两个文件。
   */
  function readAll(): string {
    return (
      read() +
      readFileSync(new URL('../../components/focus/TimerPanels.tsx', import.meta.url), 'utf8') +
      readFileSync(new URL('../../components/focus/FocusStats.tsx', import.meta.url), 'utf8')
    );
  }

  it('统计仪表盘仅在 mode !== "reminder" 时渲染', () => {
    const src = read();
    expect(src).toContain("mode !== 'reminder'");
  });

  it('三指标 / 热力图 / 今日明细的 testid 都落在"非提醒"条件块内（即提醒模式不展示）', () => {
    const src = read();
    const gate = src.indexOf("mode !== 'reminder'");
    expect(gate).toBeGreaterThan(-1);
    // ⚠️ 三指标是以 `testId="focus-today"` 形式传给 StatCard 的（真正渲染时在
    // StatCard 内部才变成 data-testid={testId}），只有热力图是字面 data-testid。
    // 因此按"id 字符串"定位才能覆盖两种写法；直接找 data-testid="..." 会漏掉三指标。
    for (const id of ['focus-today', 'focus-week', 'focus-streak', 'focus-heatmap']) {
      const idx = src.indexOf(id);
      expect(idx).toBeGreaterThan(-1);
      expect(idx).toBeGreaterThan(gate); // 在闸门之后 → 受 mode!=='reminder' 控制
    }
  });

  it('Segmented 三模式接通：番茄钟 / 秒表 / 提醒', () => {
    const src = read();
    expect(src).toContain("value: 'pomodoro', label: '番茄钟'");
    expect(src).toContain("value: 'stopwatch', label: '秒表'");
    expect(src).toContain("value: 'reminder', label: '提醒'");
  });

  it('原 data-testid 全部保留', () => {
    const src = readAll();
    for (const id of ['focus-clock', 'focus-start', 'focus-stop', 'focus-cancel']) {
      expect(src).toContain(`data-testid="${id}"`);
    }
  });

  /**
   * 切模式若另一模式还在设备本地留下运行态，先取消它（toast『已停止上一个计时』）。
   *
   * 清理口径是**模式不一致**（P1-1 修复）：不再附加"只有在跑才清"的条件 ——
   * 暂停中的秒表（running 为假）也必须清，否则切到番茄钟后会被
   * useFocusTimer 当成自己的 focus 段接走，倒计时与专注记录全错。
   */
  it('切模式先清理别人的运行态：saveRunningTimer(null) + toast『已停止上一个计时』', () => {
    const src = read();
    expect(src).toContain('saveRunningTimer(null)');
    expect(src).toContain('已停止上一个计时');
    // 取消判定：只要有运行态且模式不同
    expect(src).toContain('current.mode !== next');
    // 不再按 running 过滤 —— 暂停态也要清（扫描的是整个文件，写回到这里也会立刻变红）
    expect(src).not.toContain('current.running');
  });
});

describe('真实 reducer：专注统计写入闭环', () => {
  it('FOCUS_LOG 把 session 写进 focusSessions（仪表盘的数据源）', () => {
    const session: FocusSession = {
      id: 'f1',
      taskId: null,
      date: '2026-10-24',
      startedAt: '2026-10-24T09:00:00.000Z',
      endedAt: '2026-10-24T09:25:00.000Z',
      durationMs: 25 * 60_000,
    };
    const next = reducer(createEmptyState(), { type: 'FOCUS_LOG', session });
    expect(next.focusSessions).toHaveLength(1);
    expect(next.focusSessions[0]?.durationMs).toBe(25 * 60_000);
  });

  it('同 id 重复 FOCUS_LOG 幂等（防网络重放造出重复时长）', () => {
    const session: FocusSession = {
      id: 'f1',
      taskId: null,
      date: '2026-10-24',
      startedAt: '2026-10-24T09:00:00.000Z',
      endedAt: '2026-10-24T09:25:00.000Z',
      durationMs: 25 * 60_000,
    };
    const once = reducer(createEmptyState(), { type: 'FOCUS_LOG', session });
    const twice = reducer(once, { type: 'FOCUS_LOG', session });
    expect(twice).toBe(once); // 同一引用，未触发新写入
    expect(twice.focusSessions).toHaveLength(1);
  });
});
