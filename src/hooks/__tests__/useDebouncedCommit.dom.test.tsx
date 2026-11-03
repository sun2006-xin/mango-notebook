// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDebouncedCommit, type DebouncedCommitApi } from '../useDebouncedCommit';

/* ============================================================================
   防抖提交：契约是"**任何一次提交都会送达**"（v0.29.9）
   ----------------------------------------------------------------------------
   把"每键 dispatch"改成防抖，收益是打字不再全树重渲；代价是**可能丢字**。
   所以这个 hook 的测试重点不是"延迟多久"，而是四条送达保证：

     ① 静默期到了 → 提交一次（且只提交最新值，中间的不重复提交）；
     ② 静默期内继续输入 → 只提交最后一次；
     ③ 卸载 → 待提交的值照样送出去（切记事 / 关抽屉）；
     ④ pagehide / 切后台 → 同样送出（安卓杀进程前必走这条）。

   还有一条容易被忽略的：flush 之后计时器必须清掉，否则会**再提交一次旧值**，
   把刚写进去的新内容盖回去。
   ========================================================================= */

let api: DebouncedCommitApi<string>;
let container: HTMLDivElement;
let root: Root | null = null;

function Probe({ commit, delayMs }: { commit: (v: string) => void; delayMs?: number }) {
  api = useDebouncedCommit({ commit, delayMs });
  return null;
}

const mount = (commit: (v: string) => void, delayMs?: number) =>
  act(() => root?.render(<Probe commit={commit} delayMs={delayMs} />));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
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

describe('useDebouncedCommit', () => {
  it('静默期到 → 提交最新值一次', () => {
    const commit = vi.fn();
    mount(commit);

    act(() => api.schedule('你'));
    act(() => api.schedule('你好'));
    act(() => {
      vi.advanceTimersByTime(349);
    });
    expect(commit).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith('你好');
  });

  it('连续输入只会提交最后一次（不是逐个补交）', () => {
    const commit = vi.fn();
    mount(commit);

    for (const text of ['a', 'ab', 'abc', 'abcd']) {
      act(() => api.schedule(text));
      act(() => {
        vi.advanceTimersByTime(100);
      });
    }
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith('abcd');
  });

  it('flush 立刻提交，并且不会在之后重复提交（计时器被清掉）', () => {
    const commit = vi.fn();
    mount(commit);

    act(() => api.schedule('写了一半'));
    act(() => api.flush());
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith('写了一半');

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    // 如果计时器没清，这里会再提交一次"写了一半"，把之后的新内容盖回去
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('**卸载时把待提交的值送出去**（切记事 / 关抽屉不丢字）', () => {
    const commit = vi.fn();
    mount(commit);

    act(() => api.schedule('还没等到静默期'));
    act(() => root?.unmount());
    root = null;

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith('还没等到静默期');
  });

  it('pagehide（切后台 / 按返回键）也会送出', () => {
    const commit = vi.fn();
    mount(commit);

    act(() => api.schedule('切后台前的最后一句'));
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });

    expect(commit).toHaveBeenCalledWith('切后台前的最后一句');
  });

  it('没有待提交值时 flush / 卸载都不产生空提交', () => {
    const commit = vi.fn();
    mount(commit);
    act(() => api.flush());
    act(() => root?.unmount());
    root = null;
    expect(commit).not.toHaveBeenCalled();
  });

  it('isDirty 正确反映"还有没送出去的"', () => {
    const commit = vi.fn();
    mount(commit);
    expect(api.isDirty()).toBe(false);
    act(() => api.schedule('x'));
    expect(api.isDirty()).toBe(true);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(api.isDirty()).toBe(false);
  });

  it('cancel 丢弃待提交值（清空 / 删除前用，不能把草稿写回去）', () => {
    const commit = vi.fn();
    mount(commit);

    act(() => api.schedule('不想留了'));
    act(() => api.cancel());
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(commit).not.toHaveBeenCalled();
    expect(api.isDirty()).toBe(false);
  });

  it('延迟可配（默认 350ms）', () => {
    const commit = vi.fn();
    mount(commit, 50);
    act(() => api.schedule('快'));
    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(commit).toHaveBeenCalledWith('快');
  });
});
