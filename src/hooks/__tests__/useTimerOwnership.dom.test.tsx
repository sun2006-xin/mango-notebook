// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FOCUS_RUNNING_KEY } from '../../constants';
import { useTimerOwnership } from '../useTimerOwnership';

/* ============================================================================
   跨标签页计时归属（v0.25）

   三套计时器共用磁盘上同一个 `FOCUS_RUNNING_KEY`。同一浏览器开两个标签页时，
   后开的那段会覆盖先开的 —— 两个标签页各自 tick 到点都会记一段，
   **同一时段凭空多出一条专注记录**，而用户只跑了一次。

   策略：后手说了算，先手让位（清内存、不写 FOCUS_LOG、提示一句）。
   让位方绝不回写磁盘，否则两边互相清对方 → 抖成 ping-pong。

   这些"绝不"必须钉死：
   - 自己写的 key 不触发自己的监听（storage 事件天然如此，但别用别的机制代替）；
   - 让位**不能**落盘（回写 = ping-pong）；
   - 不在计时时不该被别的标签页打扰。
   ========================================================================= */

interface Props {
  active: boolean;
  runId: string | null;
  onYield: (reason: 'taken-over' | 'cleared') => void;
}

function Probe({ active, runId, onYield }: Props): null {
  useTimerOwnership({ active, runId, onYield });
  return null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  localStorage.clear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
  vi.restoreAllMocks();
});

function mount(props: Props): void {
  act(() => {
    root.render(<Probe {...props} />);
  });
}

/** 模拟"另一个标签页"写入运行态（storage 事件只在别的文档写入时触发） */
function otherTabWrites(raw: string | null): void {
  const event = new StorageEvent('storage', {
    key: FOCUS_RUNNING_KEY,
    newValue: raw,
    oldValue: null,
    storageArea: localStorage,
  });
  act(() => {
    window.dispatchEvent(event);
  });
}

const running = (id: string): string =>
  JSON.stringify({ id, kind: 'focus', startedAt: new Date().toISOString() });

describe('后手说了算：先手的标签页让位', () => {
  it('别的标签页开了新的一段（id 不同）→ taken-over', () => {
    const onYield = vi.fn();
    mount({ active: true, runId: 'mine', onYield });

    otherTabWrites(running('theirs'));

    expect(onYield).toHaveBeenCalledTimes(1);
    expect(onYield).toHaveBeenCalledWith('taken-over');
  });

  it('别的标签页把运行态清掉了 → cleared', () => {
    const onYield = vi.fn();
    mount({ active: true, runId: 'mine', onYield });

    otherTabWrites(null);

    expect(onYield).toHaveBeenCalledWith('cleared');
  });

  it('自己续写同一个 id（心跳/持久化）→ 不让位', () => {
    const onYield = vi.fn();
    mount({ active: true, runId: 'mine', onYield });

    otherTabWrites(running('mine'));

    expect(onYield).not.toHaveBeenCalled();
  });

  it('不在计时（idle）→ 别人的动静与我无关', () => {
    const onYield = vi.fn();
    mount({ active: false, runId: null, onYield });

    otherTabWrites(running('theirs'));
    otherTabWrites(null);

    expect(onYield).not.toHaveBeenCalled();
  });

  it('别的 key（比如任务数据）→ 不是计时器的事，不打扰', () => {
    const onYield = vi.fn();
    mount({ active: true, runId: 'mine', onYield });

    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'dt:app:v1', newValue: '{}', storageArea: localStorage }),
      );
    });

    expect(onYield).not.toHaveBeenCalled();
  });
});

describe('让位的边界：不回写、不误伤、能卸载', () => {
  it('让位回调不碰 localStorage（回写 = 两个标签页互相清对方）', () => {
    const theirs = running('theirs'); // 固定住，别让毫秒差把这个断言搞成偶发红
    localStorage.setItem(FOCUS_RUNNING_KEY, theirs);
    const onYield = vi.fn();
    mount({ active: true, runId: 'mine', onYield });

    otherTabWrites(theirs);

    expect(onYield).toHaveBeenCalledTimes(1);
    // 磁盘上仍是对方那段，本标签页一个字节都没动
    expect(localStorage.getItem(FOCUS_RUNNING_KEY)).toBe(theirs);
  });

  it('磁盘上是脏数据（非法 JSON）→ 当成"被清掉"处理，不能抛异常', () => {
    const onYield = vi.fn();
    mount({ active: true, runId: 'mine', onYield });

    expect(() => otherTabWrites('{not json')).not.toThrow();
    expect(onYield).toHaveBeenCalledWith('cleared');
  });

  it('JSON 合法但没有 id → 同样当成清掉（不能当成"有人接管"）', () => {
    const onYield = vi.fn();
    mount({ active: true, runId: 'mine', onYield });

    otherTabWrites(JSON.stringify({ kind: 'focus' }));

    expect(onYield).toHaveBeenCalledWith('cleared');
  });

  it('runId 变了之后用新值判定：旧 id 来了也让位', () => {
    const onYield = vi.fn();
    mount({ active: true, runId: 'first', onYield });
    // 本标签页自己重开了一段
    act(() => {
      root.render(<Probe active runId="second" onYield={onYield} />);
    });

    otherTabWrites(running('first'));

    expect(onYield).toHaveBeenCalledWith('taken-over');
  });

  it('卸载后不再响应（监听器必须摘掉）', () => {
    const onYield = vi.fn();
    mount({ active: true, runId: 'mine', onYield });
    act(() => root.unmount());

    window.dispatchEvent(
      new StorageEvent('storage', {
        key: FOCUS_RUNNING_KEY,
        newValue: running('theirs'),
        storageArea: localStorage,
      }),
    );

    expect(onYield).not.toHaveBeenCalled();
  });
});
