// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FOCUS_RUNNING_KEY } from '../../constants';
import { saveRunningTimer } from '../../lib/storage';

/* ============================================================================
   提醒到点 watcher：**行为**测试（v0.29.8）
   ----------------------------------------------------------------------------
   这条契约原来只有源码扫描：断言"先 saveRunningTimer(null) 再响铃"这类顺序。
   但真正要保证的是行为 —— **到点响一次，且只响一次**（不响的话提醒没用；
   响两次的话用户会以为设了两个提醒）。

   环境约束解决了：项目现在可以在单文件开 jsdom（首行 `@vitest-environment jsdom`），
   用真实 localStorage + 假定时器就能把整条链路跑通（以前这里写着"无法挂载组件"，
   那是旧结论）。
   ========================================================================= */

const show = vi.fn();
const playBeep = vi.fn();
const showNotification = vi.fn();

vi.mock('../useToast', () => ({ useToast: () => ({ show }) }));
vi.mock('../../lib/sound', () => ({ playBeep: () => playBeep() }));
vi.mock('../useReminders', () => ({
  showNotification: (title: string, body: string) => showNotification(title, body),
}));

import { useReminderWatcher } from '../useReminderWatcher';

let container: HTMLDivElement;
let root: Root | null = null;

function Probe() {
  useReminderWatcher();
  return null;
}

function mount() {
  act(() => {
    root?.render(<Probe />);
  });
}

/**
 * 写一条提醒运行态。
 *
 * ⚠️ `id` 是**必填**：`loadRunningTimer` 是逐字段重建的，缺 id 直接判为脏数据返回 null
 * （第一次写这组用例时我就漏了它，表现是"到点了却不响"——查了半天才发现是测试数据
 * 不全，不是实现有问题。读写两侧的字段清单要对齐）。
 */
function seedReminder(over: { startedAgoMs: number; durationMs: number }) {
  saveRunningTimer({
    mode: 'reminder',
    id: 'run-1',
    taskId: null,
    phase: 'focus',
    accumulatedMs: 0,
    running: true,
    startedAt: new Date(Date.now() - over.startedAgoMs).toISOString(),
    durationMs: over.durationMs,
  });
}

/** 已经到点：10 秒前开始，目标 1 秒 */
const seedDueReminder = () => seedReminder({ startedAgoMs: 10_000, durationMs: 1_000 });
/** 还没到点：0.2 秒前开始，目标 60 秒 */
const seedNotDueReminder = () => seedReminder({ startedAgoMs: 200, durationMs: 60_000 });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  localStorage.clear();
  show.mockReset();
  playBeep.mockReset();
  showNotification.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  container.remove();
  vi.useRealTimers();
});

describe('useReminderWatcher（到点响铃）', () => {
  it('到点 → 通知 + Toast + 响铃各一次，并清空运行态', () => {
    seedDueReminder();
    mount();

    act(() => {
      vi.advanceTimersByTime(1100);
    });

    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(playBeep).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledTimes(1);
    // 清空运行态是"只响一次"的落地点
    expect(localStorage.getItem(FOCUS_RUNNING_KEY)).toBeNull();
  });

  it('响过之后不再重复响（推进 10 秒，仍然只有一次）', () => {
    seedDueReminder();
    mount();

    act(() => {
      vi.advanceTimersByTime(1100);
    });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(playBeep).toHaveBeenCalledTimes(1);
  });

  it('还没到点 → 不响（但也不清空，等到点再响）', () => {
    seedNotDueReminder();
    mount();

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(showNotification).not.toHaveBeenCalled();
    expect(localStorage.getItem(FOCUS_RUNNING_KEY)).not.toBeNull();
  });

  it('番茄钟运行态不会被当成提醒（mode 判定）', () => {
    saveRunningTimer({
      mode: 'pomodoro',
      id: 'run-2',
      taskId: null,
      phase: 'focus',
      accumulatedMs: 0,
      running: true,
      startedAt: new Date(Date.now() - 10_000).toISOString(),
      durationMs: 1_000,
    });
    mount();

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(showNotification).not.toHaveBeenCalled();
    expect(playBeep).not.toHaveBeenCalled();
  });

  it('已停止 / 没有运行态 → 什么都不做（不抛）', () => {
    mount();
    expect(() =>
      act(() => {
        vi.advanceTimersByTime(3000);
      }),
    ).not.toThrow();
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('卸载后不再轮询（切走视图不该继续占定时器）', () => {
    seedDueReminder();
    mount();
    act(() => root?.unmount());
    root = null;

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(showNotification).not.toHaveBeenCalled();
  });
});
