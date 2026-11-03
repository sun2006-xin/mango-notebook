// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FOCUS_RUNNING_KEY } from '../../constants';
import { createDefaultSettings } from '../../constants';
import type { StopwatchApi } from '../useStopwatch';

/* ============================================================================
   秒表"记录这一段"的行为（v0.29.8）
   ----------------------------------------------------------------------------
   这条原来全是源码扫描：断言 `elapsed >= MIN_RECORD_MS`、`taskId: null`、
   `dispatch({ type: 'FOCUS_LOG' })` 这些字符串。它守的是**业务规则**，而规则
   埋在按钮回调里只能靠字面量盯 —— 换个写法就红，行为其实没变。

   现在真跑：假定时器推进时间 → 调 record() → 看 dispatch 收到什么。
   覆盖三条最容易错的：不足 1 分钟不许记录 / 记录必须是自由专注（taskId=null）/
   记录后要清运行态并回 idle。
   ========================================================================= */

const dispatch = vi.fn();
const show = vi.fn();

vi.mock('../../store/StoreContext', () => ({
  useAppState: () => ({ settings: createDefaultSettings('2026-11-02') }),
  useAppDispatch: () => dispatch,
}));
vi.mock('../useToast', () => ({ useToast: () => ({ show }) }));

import { useStopwatch } from '../useStopwatch';

let api: StopwatchApi;
let container: HTMLDivElement;
let root: Root | null = null;

function Probe() {
  api = useStopwatch();
  return null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  localStorage.clear();
  dispatch.mockReset();
  show.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<Probe />));
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  container.remove();
  vi.useRealTimers();
});

const focusLogs = () => dispatch.mock.calls.filter(([action]) => action?.type === 'FOCUS_LOG');

describe('useStopwatch · 记录', () => {
  it('累计 65 秒 → 派发一次 FOCUS_LOG，且是自由专注（taskId=null）', () => {
    act(() => api.start());
    act(() => {
      vi.advanceTimersByTime(65_000);
    });
    act(() => api.record());

    const logs = focusLogs();
    expect(logs).toHaveLength(1);
    const session = logs[0][0].session;
    expect(session.taskId).toBeNull();
    // 时长按"开始到现在"算，不采信外部传入
    expect(session.durationMs).toBeGreaterThanOrEqual(60_000);
  });

  it('累计 50 秒 → 不记录，只提示"不足 1 分钟"', () => {
    act(() => api.start());
    act(() => {
      vi.advanceTimersByTime(50_000);
    });
    act(() => api.record());

    expect(focusLogs()).toHaveLength(0);
    expect(show).toHaveBeenCalledTimes(1);
    expect(String(show.mock.calls[0][0])).toContain('不足');
  });

  it('不足 1 分钟不记录时，运行态**要保留**（不能把已累计的几十秒静默丢掉）', () => {
    act(() => api.start());
    act(() => {
      vi.advanceTimersByTime(50_000);
    });
    act(() => api.record());

    expect(localStorage.getItem(FOCUS_RUNNING_KEY)).not.toBeNull();
    expect(api.phase).not.toBe('idle');
  });

  it('暂停期间不累计：暂停 10 秒再继续，记录时长不含这 10 秒', () => {
    act(() => api.start());
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    act(() => api.pause());
    // 暂停期间"流走"的 10 秒不该算进专注
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    act(() => api.resume());
    act(() => {
      vi.advanceTimersByTime(35_000);
    });
    act(() => api.record());

    const logs = focusLogs();
    expect(logs).toHaveLength(1);
    const ms = logs[0][0].session.durationMs as number;
    // 30 + 35 = 65 秒；允许 1 秒的定时器取整误差，但绝不能是 75 秒
    expect(ms).toBeGreaterThanOrEqual(64_000);
    expect(ms).toBeLessThan(70_000);
  });

  it('记录成功后：运行态清空、回 idle（否则下次进来还在跑）', () => {
    act(() => api.start());
    act(() => {
      vi.advanceTimersByTime(65_000);
    });
    act(() => api.record());

    expect(localStorage.getItem(FOCUS_RUNNING_KEY)).toBeNull();
    expect(api.phase).toBe('idle');
    expect(api.elapsedMs).toBe(0);
  });
});
