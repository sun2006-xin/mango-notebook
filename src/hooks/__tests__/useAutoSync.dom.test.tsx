// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* ============================================================================
   后台自动同步的触发点（含 ⑦ 的网络恢复行为）

   这里只测**调度**，不测同步本身（同步在 lib/__tests__/autoSync.test.ts）：
   什么时候跑、什么时候不许跑、网络恢复时有没有先解除停摆。
   后者是 ⑦ 修的那个坑 —— 网络回来了但自动同步还停摆着，用户得手动点。
   ========================================================================= */

const mocks = vi.hoisted(() => ({
  runAutoSync: vi.fn(async () => null),
  resumeAutoSync: vi.fn(),
}));

vi.mock('../../lib/cloud', () => ({ isCloudRuntimeAvailable: () => true }));
vi.mock('../../lib/cloudSync', () => ({
  AUTO_SYNC_BOOT_DELAY_MS: 2_500,
  AUTO_SYNC_INTERVAL_MS: 60_000,
  runAutoSync: mocks.runAutoSync,
  resumeAutoSync: mocks.resumeAutoSync,
}));

const { useAutoSync } = await import('../useAutoSync');

function Probe(): null {
  useAutoSync(() => null);
  return null;
}

let container: HTMLDivElement;
/** null = 已经卸载过（afterEach 不要重复 unmount，否则 React 会警告着玩） */
let root: Root | null = null;

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.runAutoSync.mockClear();
  mocks.resumeAutoSync.mockClear();
  setVisibility('visible');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) {
    const alive = root;
    root = null;
    act(() => alive.unmount());
  }
  container.remove();
  vi.useRealTimers();
  setVisibility('visible');
});

function mount(): void {
  const alive = root;
  if (!alive) return;
  act(() => alive.render(<Probe />));
}

describe('useAutoSync：什么时候跑', () => {
  it('挂载不当场跑，等 2.5s 让首屏先渲染完', () => {
    mount();
    expect(mocks.runAutoSync).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(2_499));
    expect(mocks.runAutoSync).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1));
    expect(mocks.runAutoSync).toHaveBeenCalledTimes(1);
  });

  it('之后每 60 秒一次（不动本机也能收到别的设备的改动）', () => {
    mount();
    act(() => void vi.advanceTimersByTime(2_500));
    expect(mocks.runAutoSync).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(60_000));
    expect(mocks.runAutoSync).toHaveBeenCalledTimes(2);
  });

  it('页面在后台时不轮询（省电，也避免被浏览器节流后堆积）', () => {
    setVisibility('hidden');
    mount();
    act(() => void vi.advanceTimersByTime(2_500 + 60_000 * 3));
    expect(mocks.runAutoSync).not.toHaveBeenCalled();
  });

  it('切回前台立刻补一次', () => {
    setVisibility('hidden');
    mount();
    act(() => void vi.advanceTimersByTime(2_500));
    expect(mocks.runAutoSync).not.toHaveBeenCalled();

    setVisibility('visible');
    act(() => void document.dispatchEvent(new Event('visibilitychange')));
    expect(mocks.runAutoSync).toHaveBeenCalledTimes(1);
  });
});

describe('useAutoSync：网络恢复（⑦）', () => {
  it('online 事件 → **先**解除停摆，再补一次同步', () => {
    mount();
    mocks.resumeAutoSync.mockClear();
    mocks.runAutoSync.mockClear();

    act(() => void window.dispatchEvent(new Event('online')));

    expect(mocks.resumeAutoSync).toHaveBeenCalledTimes(1);
    expect(mocks.runAutoSync).toHaveBeenCalledTimes(1);
    // 顺序是重点：先 resume 再跑，否则 runAutoSync 会因停摆直接返回 null，
    // 明明连得上却同步不了（⑦ 要修的正是这个）
    const resumeOrder = mocks.resumeAutoSync.mock.invocationCallOrder[0];
    const runOrder = mocks.runAutoSync.mock.invocationCallOrder[0];
    expect(resumeOrder).toBeLessThan(runOrder);
  });

  it('启动时也会解除停摆（上一会话的失败计数不该跨进程延续）', () => {
    mount();
    expect(mocks.resumeAutoSync).toHaveBeenCalled();
  });

  it('卸载后 online 不再触发（监听器必须摘干净）', () => {
    mount();
    const alive = root;
    root = null;
    if (alive) act(() => alive.unmount());
    mocks.runAutoSync.mockClear();
    act(() => void window.dispatchEvent(new Event('online')));
    expect(mocks.runAutoSync).not.toHaveBeenCalled();
  });
});
