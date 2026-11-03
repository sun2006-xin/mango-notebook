// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDragSort } from '../useDragSort';
import type { DragSortApi } from '../useDragSort';
import { useSwipe } from '../useSwipe';
import type { DropTarget } from '../../lib/drag';

/* ============================================================================
   拖拽交互层（useDragSort）的 DOM 冒烟测试

   为什么单独开这个文件：本项目的其它测试都跑在 node 环境里（纯函数 + 源码契约），
   而拖拽是**唯一一段真正依赖 DOM 事件**的代码 ——
   "鼠标移动 6px 才算拖"、"手指按住 380ms 才算拖"、"松手后那次 click 要吞掉"
   这三条全是时序与事件细节，靠读代码判断对错非常不可靠。

   所以这里用 jsdom 渲染一个最小骨架，把真实的 pointer 事件打进去，
   验证的正是这三条时序规则。跑不了真机，但至少能证明状态机是对的。
   ========================================================================= */

/** jsdom 没有 PointerEvent / setPointerCapture，补最小实现 */
class FakePointerEvent extends MouseEvent {
  pointerId: number;
  pointerType: string;
  constructor(type: string, init: MouseEventInit & { pointerId?: number; pointerType?: string } = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? 'mouse';
  }
}

interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

function setRect(element: Element, rect: Rect): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ ...rect, width: rect.right - rect.left, height: rect.bottom - rect.top, x: rect.left, y: rect.top, toJSON: () => rect }),
  });
}

let container: HTMLDivElement;
let host: HTMLDivElement;
let root: Root;
let api: DragSortApi;
let commits: { id: string; target: DropTarget }[];
/** 模拟 `setPointerCapture` 抛异常（真浏览器里的 NotFoundError） */
let captureThrows = false;
/** setPointerCapture 被调用了几次 —— 用来钉住"只在真拖拽时才捕获" */
let captureCalls = 0;

const ROWS = ['a', 'b', 'c'];

/**
 * 骨架必须由 **React** 渲染：hook 的 `onRowPointerDown` 要挂成 React 的
 * `onPointerDown` 才会被调用（用 innerHTML 造出来的 div 上没有 React 的监听）。
 */
function Harness() {
  api = useDragSort({
    onCommit: (id, target) => {
      commits.push({ id, target });
    },
  });
  return (
    <div>
      <div id="d1" data-drop-day="d1" />
      <div id="d2" data-drop-day="d2" />
      {ROWS.map((id) => (
        <div
          key={id}
          id={`row-${id}`}
          data-drag-id={id}
          data-drag-date="d1"
          onPointerDown={api.onRowPointerDown}
        />
      ))}
    </div>
  );
}

/** 行高 48、列宽 200 —— 与真实列表接近，落点判定才有意义 */
function buildDom(): void {
  setRect(container.querySelector('#d1') as Element, { top: 0, bottom: 300, left: 0, right: 200 });
  setRect(container.querySelector('#d2') as Element, { top: 0, bottom: 300, left: 200, right: 400 });
  setRect(container.querySelector('#row-a') as Element, { top: 0, bottom: 48, left: 0, right: 200 });
  setRect(container.querySelector('#row-b') as Element, { top: 48, bottom: 96, left: 0, right: 200 });
  setRect(container.querySelector('#row-c') as Element, { top: 96, bottom: 144, left: 0, right: 200 });
}

function row(id: string): HTMLElement {
  return host.querySelector(`#row-${id}`) as HTMLElement;
}

/** 打一个 pointer 事件到行上（React 的 onPointerDown / hook 的原生监听都挂在行上） */
function fire(
  target: HTMLElement,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  x: number,
  y: number,
  pointerType: 'mouse' | 'touch' = 'mouse',
): void {
  act(() => {
    target.dispatchEvent(
      new FakePointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerType, button: 0 }),
    );
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as unknown as { PointerEvent: unknown }).PointerEvent = FakePointerEvent;
  (
    window as unknown as { PointerEvent: unknown }
  ).PointerEvent = FakePointerEvent;
  const proto = window.Element.prototype as unknown as Record<string, unknown>;
  captureThrows = false;
  captureCalls = 0;
  proto.setPointerCapture = function setPointerCapture() {
    /**
     * jsdom 没有真正的指针捕获，事件直接打到元素上即可。
     * `captureThrows` 用来模拟"指针已经失效"——真浏览器里 `setPointerCapture`
     * 会抛 `NotFoundError`，那是拖拽卡死的诱因（见 useDragSort 的注释）。
     */
    captureCalls += 1;
    if (captureThrows) throw new Error('NotFoundError: invalid pointerId');
  };
  proto.releasePointerCapture = function releasePointerCapture() {
    /* noop */
  };
  proto.hasPointerCapture = function hasPointerCapture() {
    return true;
  };

  commits = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  host = document.createElement('div');
  container.appendChild(host);

  root = createRoot(host);
  act(() => {
    root.render(<Harness />);
  });
  // 矩形要在渲染之后量：React 重渲不会重建这些节点，量一次就够
  buildDom();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('useDragSort · 鼠标', () => {
  it('位移不足阈值 → 不进入拖拽（点击仍然是点击）', () => {
    fire(row('c'), 'pointerdown', 100, 120);
    fire(row('c'), 'pointermove', 102, 121);
    expect(api.draggingId).toBe(null);
    fire(row('c'), 'pointerup', 102, 121);
    expect(commits).toHaveLength(0);
  });

  it('拖到第一行上方 → 插到 a 之前', () => {
    fire(row('c'), 'pointerdown', 100, 120);
    fire(row('c'), 'pointermove', 100, 100);
    expect(api.draggingId).toBe('c');
    fire(row('c'), 'pointermove', 100, 10);
    expect(api.dropTarget).toEqual({ kind: 'before', date: 'd1', beforeId: 'a' });

    fire(row('c'), 'pointerup', 100, 10);
    expect(commits).toEqual([{ id: 'c', target: { kind: 'before', date: 'd1', beforeId: 'a' } }]);
    expect(api.draggingId).toBe(null);
    expect(api.dropTarget).toBe(null);
  });

  it('拖到另一列 → 只改日期', () => {
    fire(row('c'), 'pointerdown', 100, 120);
    fire(row('c'), 'pointermove', 100, 100);
    fire(row('c'), 'pointermove', 300, 150);
    expect(api.dropTarget).toEqual({ kind: 'day', date: 'd2' });
    fire(row('c'), 'pointerup', 300, 150);
    expect(commits).toEqual([{ id: 'c', target: { kind: 'day', date: 'd2' } }]);
  });

  it('拖到所有列之外 → 松手无效，不提交', () => {
    fire(row('c'), 'pointerdown', 100, 120);
    fire(row('c'), 'pointermove', 100, 100);
    fire(row('c'), 'pointermove', 900, 900);
    expect(api.dropTarget).toBe(null);
    fire(row('c'), 'pointerup', 900, 900);
    expect(commits).toHaveLength(0);
  });

  it('拖拽结束后紧跟的 click 被吞掉（否则松手就弹抽屉）', () => {
    fire(row('c'), 'pointerdown', 100, 120);
    fire(row('c'), 'pointermove', 100, 100);
    fire(row('c'), 'pointerup', 100, 100);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    row('c').dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
  });

  it('没拖过的点击不被吞', () => {
    fire(row('c'), 'pointerdown', 100, 120);
    fire(row('c'), 'pointerup', 100, 120);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    row('c').dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
  });
});

describe('useDragSort · 状态机不能卡死', () => {
  it('setPointerCapture 抛异常 → 拖拽照常工作，且下一次仍然可用', () => {
    captureThrows = true;
    fire(row('c'), 'pointerdown', 100, 120);
    fire(row('c'), 'pointermove', 100, 100);
    /**
     * 捕获失败**不该**让拖拽失效：监听挂在 document 上，指针事件照样能收到。
     * 捕获只是"指针移出元素/窗口时仍能追踪"的保险。
     */
    expect(api.draggingId).toBe('c');
    fire(row('c'), 'pointerup', 100, 10);
    expect(commits).toHaveLength(1);

    /**
     * 且失败的那一次**必须把 session 清掉** —— 不清的话 `session.current`
     * 永远非空，之后每次 pointerdown 都被 `if (session.current) return` 挡掉，
     * 表现就是"拖拽彻底失灵，刷新才好"。
     */
    captureThrows = false;
    fire(row('b'), 'pointerdown', 100, 60);
    fire(row('b'), 'pointermove', 100, 40);
    expect(api.draggingId).toBe('b');
    fire(row('b'), 'pointerup', 100, 10);
    expect(commits).toHaveLength(2);
  });

  it('**普通点击绝不能捕获指针**（否则 click 会被重定向，抽屉打不开）', () => {
    /**
     * Pointer Events 规范：捕获期间兼容性鼠标事件也会重定向到捕获元素。
     * 于是 pointerup 的 target 变成整行，浏览器算出 click 的目标 = 行，
     * 行里那个 `role="button"` 的 onClick 永远不触发 —— 任务无法编辑。
     *
     * 所以：pointerdown 时**什么都不捕获**，只有真拖起来才捕获。
     * jsdom 的 setPointerCapture 是空实现，这条只能靠"调用次数"来守。
     */
    fire(row('c'), 'pointerdown', 100, 120);
    fire(row('c'), 'pointerup', 100, 120);
    expect(captureCalls).toBe(0);
  });

  it('真拖拽才捕获（松手那次 click 本来就要吞掉）', () => {
    fire(row('c'), 'pointerdown', 100, 120);
    fire(row('c'), 'pointermove', 100, 100);
    expect(captureCalls).toBe(1);
    fire(row('c'), 'pointerup', 100, 10);
  });

  it('普通点击（从未生效）之后，紧接着的第二次点击也正常', () => {
    fire(row('c'), 'pointerdown', 100, 120);
    fire(row('c'), 'pointerup', 100, 120);
    expect(api.draggingId).toBe(null);

    fire(row('b'), 'pointerdown', 100, 60);
    fire(row('b'), 'pointerup', 100, 60);
    expect(api.draggingId).toBe(null);
    expect(commits).toHaveLength(0);
  });

  it('勾选框 / 输入框上按下不进入拖拽待定态（否则手指一抖勾选就失效）', () => {
    const box = document.createElement('input');
    box.type = 'checkbox';
    row('c').appendChild(box);
    act(() => {
      box.dispatchEvent(
        new FakePointerEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 120, button: 0 }),
      );
    });
    fire(row('c'), 'pointermove', 100, 100);
    expect(api.draggingId).toBe(null);
    box.remove();
  });
});

describe('useDragSort · 边缘自动滚动', () => {
  let scrollSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    scrollSpy = vi.fn();
    (window as unknown as { scrollBy: unknown }).scrollBy = scrollSpy;
  });

  it('拖到下边缘 → 持续向下滚（手指可以一动不动）', async () => {
    fire(row('c'), 'pointerdown', 100, 120);
    fire(row('c'), 'pointermove', 100, 100);
    // 停在下触发区里，之后不再 dispatch 任何 pointermove
    fire(row('c'), 'pointermove', 150, window.innerHeight - 5);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });

    expect(scrollSpy).toHaveBeenCalled();
    const lastDelta = scrollSpy.mock.calls[scrollSpy.mock.calls.length - 1]?.[1] as number;
    expect(lastDelta).toBeGreaterThan(0);

    fire(row('c'), 'pointerup', 150, window.innerHeight - 5);
  });

  it('拖到视口中部 → 一帧都不滚', async () => {
    fire(row('c'), 'pointerdown', 100, 120);
    fire(row('c'), 'pointermove', 100, 100);
    fire(row('c'), 'pointermove', 150, window.innerHeight / 2);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });

    expect(scrollSpy).not.toHaveBeenCalled();
    fire(row('c'), 'pointerup', 150, window.innerHeight / 2);
  });

  it('松手后循环停掉（不能继续偷偷滚页面）', async () => {
    fire(row('c'), 'pointerdown', 100, 120);
    fire(row('c'), 'pointermove', 100, 100);
    fire(row('c'), 'pointermove', 150, window.innerHeight - 5);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });

    fire(row('c'), 'pointerup', 150, window.innerHeight - 5);
    scrollSpy.mockClear();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(scrollSpy).not.toHaveBeenCalled();
  });
});

describe('useDragSort · 触摸', () => {
  it('长按生效前就移动 → 判定为滚动，放弃拖拽', () => {
    fire(row('c'), 'pointerdown', 100, 120, 'touch');
    fire(row('c'), 'pointermove', 100, 90, 'touch');
    expect(api.draggingId).toBe(null);
    fire(row('c'), 'pointerup', 100, 90, 'touch');
    expect(commits).toHaveLength(0);
  });

  it('按住 380ms 后进入拖拽，并阻止页面跟着滚', async () => {
    fire(row('c'), 'pointerdown', 100, 120, 'touch');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 420));
    });
    expect(api.draggingId).toBe('c');

    const touchMove = new Event('touchmove', { bubbles: true, cancelable: true });
    document.dispatchEvent(touchMove);
    expect(touchMove.defaultPrevented).toBe(true);

    fire(row('c'), 'pointermove', 300, 150, 'touch');
    expect(api.dropTarget).toEqual({ kind: 'day', date: 'd2' });
    fire(row('c'), 'pointerup', 300, 150, 'touch');
    expect(commits).toEqual([{ id: 'c', target: { kind: 'day', date: 'd2' } }]);
  });

  it('拖拽进行中侧滑被禁用（否则横拖到另一列的一路上会"右滑完成"）', async () => {
    let swipes = 0;
    function SwipeHarness() {
      const { handlers } = useSwipe({
        onSwipeRight: () => {
          swipes += 1;
        },
        enabled: false,
      });
      return <div id="swipe" {...handlers} />;
    }
    const swipeHost = document.createElement('div');
    container.appendChild(swipeHost);
    const swipeRoot = createRoot(swipeHost);
    act(() => {
      swipeRoot.render(<SwipeHarness />);
    });

    const target = swipeHost.querySelector('#swipe') as HTMLElement;
    const touch = (type: string, x: number, y: number): void => {
      act(() => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        (event as unknown as { touches: unknown }).touches = [{ clientX: x, clientY: y }];
        target.dispatchEvent(event);
      });
    };

    touch('touchstart', 10, 10);
    touch('touchmove', 200, 12);
    touch('touchend', 200, 12);
    expect(swipes).toBe(0);

    act(() => swipeRoot.unmount());
    swipeHost.remove();
  });

  it('pointercancel（浏览器接管滚动）→ 什么都不做', async () => {
    fire(row('c'), 'pointerdown', 100, 120, 'touch');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 420));
    });
    expect(api.draggingId).toBe('c');
    act(() => {
      row('c').dispatchEvent(new FakePointerEvent('pointercancel', { bubbles: true, pointerType: 'touch' }));
    });
    expect(api.draggingId).toBe(null);
    expect(commits).toHaveLength(0);
  });
});
