// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultSettings } from '../../constants';

/* ============================================================================
   桌面端自动备份：**失败不能白费一天**（v0.29.6）
   ----------------------------------------------------------------------------
   原实现：
     lastBackupDay = day;                     // ← 先占名额
     void writeDesktopBackup(...)             // ← 结果直接丢掉

   后果（磁盘满 / 无写权限 / 杀软拦截时）：
     ① 备份没写成，用户完全不知道；
     ② 一小时后重试的守卫已经失效（名额被占了），一天等于彻底没备份。

   而"备份"恰恰是在出事那天最需要可靠的。现在的契约：
     · 成功才占用当天名额；
     · 失败 → 不占名额（整点会重试）+ 当天提示一次（不反复烦人）；
     · 写盘期间不并发（effect 会因为数据变化频繁重跑）。
   ========================================================================= */

const writeDesktopBackup = vi.fn<(json: string, name: string) => Promise<boolean>>();

vi.mock('../../lib/desktopBackup', () => ({
  hasDesktopBackup: () => true,
  writeDesktopBackup: (json: string, name: string) => writeDesktopBackup(json, name),
}));

vi.mock('../../store/StoreContext', () => ({
  useAppState: () => ({
    tasks: [],
    settings: createDefaultSettings('2026-11-02'),
    diary: [],
    tombstones: [],
    focusSessions: [],
    notes: [],
  }),
}));

const show = vi.fn();
vi.mock('../useToast', () => ({ useToast: () => ({ show }) }));

import { useAutoBackup, __getAutoBackupState, __resetAutoBackupGuard } from '../useAutoBackup';

let container: HTMLDivElement;
let root: Root | null = null;

function Probe({ today }: { today: string }) {
  useAutoBackup(today);
  return null;
}

function mount(today = '2026-11-02') {
  act(() => {
    root?.render(<Probe today={today} />);
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  __resetAutoBackupGuard();
  writeDesktopBackup.mockReset();
  show.mockReset();
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
});

describe('useAutoBackup', () => {
  it('写成功 → 占用当天名额，且提示不打扰', async () => {
    writeDesktopBackup.mockResolvedValue(true);
    mount();
    await act(async () => {
      await Promise.resolve();
    });

    expect(writeDesktopBackup).toHaveBeenCalledTimes(1);
    expect(writeDesktopBackup.mock.calls[0][1]).toBe('2026-11-02.json');
    expect(__getAutoBackupState().lastBackupDay).toBe('2026-11-02');
    expect(show).not.toHaveBeenCalled();
  });

  it('写失败 → **不占名额**（否则一小时后也不会重试），并当天提示一次', async () => {
    writeDesktopBackup.mockResolvedValue(false);
    mount();
    await act(async () => {
      await Promise.resolve();
    });

    expect(__getAutoBackupState().lastBackupDay).toBeNull();
    expect(__getAutoBackupState().failureNotifiedDay).toBe('2026-11-02');
    expect(show).toHaveBeenCalledTimes(1);
    expect(String(show.mock.calls[0][0])).toContain('自动备份');
  });

  it('失败后再次触发（模拟整点重试）→ 会真的再写一次', async () => {
    writeDesktopBackup.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(writeDesktopBackup).toHaveBeenCalledTimes(1);

    // 重挂载 = effect 重跑（真实场景是 setInterval 到点后再次调用）
    act(() => root?.unmount());
    root = createRoot(container);
    mount();
    await act(async () => {
      await Promise.resolve();
    });

    expect(writeDesktopBackup).toHaveBeenCalledTimes(2);
    expect(__getAutoBackupState().lastBackupDay).toBe('2026-11-02');
  });

  it('同一天已经成功备份 → 重挂载不再重复写（不给 SSD 找事做）', async () => {
    writeDesktopBackup.mockResolvedValue(true);
    mount();
    await act(async () => {
      await Promise.resolve();
    });

    act(() => root?.unmount());
    root = createRoot(container);
    mount();
    await act(async () => {
      await Promise.resolve();
    });

    expect(writeDesktopBackup).toHaveBeenCalledTimes(1);
  });

  it('写盘期间的重复触发会被挡掉（effect 会因数据变化频繁重跑）', async () => {
    let resolveWrite: (ok: boolean) => void = () => undefined;
    writeDesktopBackup.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveWrite = resolve;
        }),
    );

    mount();
    expect(writeDesktopBackup).toHaveBeenCalledTimes(1);

    // 第一次还没落地时再触发一次
    act(() => {
      root?.render(<Probe today="2026-11-02" />);
    });
    expect(writeDesktopBackup).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveWrite(true);
      await Promise.resolve();
    });
    expect(__getAutoBackupState().inFlight).toBe(false);
  });
});
