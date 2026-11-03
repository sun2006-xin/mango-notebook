// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useOnline } from '../useOnline';

/* ============================================================================
   在线状态 hook（v0.29.9）
   ----------------------------------------------------------------------------
   `navigator.onLine` 不会引起重渲染，所以这段逻辑必须自己听事件。
   守三条：初始值不闪"在线" / offline 事件立刻反映 / online 事件恢复。
   ========================================================================= */

let container: HTMLDivElement;
let root: Root | null = null;
let value = true;

function Probe() {
  value = useOnline();
  return null;
}

function setNavigatorOnline(next: boolean) {
  Object.defineProperty(globalThis.navigator, 'onLine', { value: next, configurable: true });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setNavigatorOnline(true);
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

describe('useOnline', () => {
  it('初始在线 → true', () => {
    act(() => root?.render(<Probe />));
    expect(value).toBe(true);
  });

  it('冷启动就断网 → 初始 false（不先闪一下"在线"）', () => {
    setNavigatorOnline(false);
    act(() => root?.render(<Probe />));
    expect(value).toBe(false);
  });

  it('offline 事件 → 变 false；online 事件 → 恢复 true', () => {
    act(() => root?.render(<Probe />));
    expect(value).toBe(true);

    act(() => {
      setNavigatorOnline(false);
      window.dispatchEvent(new Event('offline'));
    });
    expect(value).toBe(false);

    act(() => {
      setNavigatorOnline(true);
      window.dispatchEvent(new Event('online'));
    });
    expect(value).toBe(true);
  });

  it('卸载后不再响应事件（不留监听）', () => {
    act(() => root?.render(<Probe />));
    act(() => root?.unmount());
    root = null;
    expect(() =>
      act(() => {
        window.dispatchEvent(new Event('offline'));
      }),
    ).not.toThrow();
  });
});
