// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TaskRow } from '../TaskRow';
import { useDragSort } from '../../../hooks/useDragSort';
import type { DateKey, Task } from '../../../types';

/* ============================================================================
   "点任务能打开抽屉"—— 拖拽加进来之后最容易被踩坏的一条

   抽屉是任务**唯一**的编辑入口（标题 / 备注 / 日期 / 时间 / 优先级 / 分类）。
   一旦打开不了，"任务无法编辑"就是全局性的 —— 用户会以为数据坏了。

   拖拽引入两个可能吞掉点击的东西：
   ① 生效后吞掉紧随的 click（本来是为了防止"松手弹抽屉"，但生效判据错了就伤及无辜）；
   ② `setPointerCapture` 把 pointerup 重定向到行元素，影响 click 的落点。
   ========================================================================= */

class FakePointerEvent extends MouseEvent {
  pointerId: number;
  pointerType: string;
  constructor(type: string, init: MouseEventInit & { pointerId?: number; pointerType?: string } = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? 'mouse';
  }
}

let container: HTMLDivElement;
let root: Root;
let opened: string[];
let toggled: string[];

const TASK: Task = {
  id: 't1',
  title: '高数第三章',
  note: '',
  date: '2026-10-30' as DateKey,
  time: null,
  repeat: 'none',
  priority: 'medium',
  category: '学习',
  done: false,
  doneAt: null,
  createdAt: '2026-10-30T00:00:00.000Z',
  updatedAt: '2026-10-30T00:00:00.000Z',
  parentId: null,
  estimatedMinutes: 0,
};

/** 用真 hook + 真 TaskRow，尽量还原运行时的接线 */
function Harness() {
  const drag = useDragSort({ onCommit: () => {} });
  return (
    <div data-drop-day="2026-10-30">
      <TaskRow
        task={TASK}
        isSticky={false}
        onDragStart={drag.onRowPointerDown}
        dropRow
        onToggle={() => toggled.push(TASK.id)}
        onOpen={() => opened.push(TASK.id)}
        onDelete={() => {}}
      />
    </div>
  );
}

function row(): HTMLElement {
  return container.querySelector('.swipe') as HTMLElement;
}

function fire(
  type: 'pointerdown' | 'pointerup',
  x: number,
  y: number,
  pointerType: 'mouse' | 'touch' = 'mouse',
): void {
  act(() => {
    row().dispatchEvent(
      new FakePointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 0,
        pointerType,
      }),
    );
  });
}

/** 浏览器在 pointerup 之后一定会补一个 click（除非被 preventDefault/stopPropagation 掉） */
function click(): boolean {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  act(() => {
    row().querySelector('[role="button"]')?.dispatchEvent(event);
  });
  return event.defaultPrevented;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as unknown as { PointerEvent: unknown }).PointerEvent = FakePointerEvent;
  (window as unknown as { PointerEvent: unknown }).PointerEvent = FakePointerEvent;
  const proto = window.Element.prototype as unknown as Record<string, unknown>;
  proto.setPointerCapture = function setPointerCapture() {
    /* noop */
  };
  proto.releasePointerCapture = function releasePointerCapture() {
    /* noop */
  };
  proto.hasPointerCapture = function hasPointerCapture() {
    return true;
  };

  opened = [];
  toggled = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<Harness />);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('点击任务 → 打开抽屉（编辑的唯一入口）', () => {
  it('鼠标单击（没有位移）→ 打开抽屉', () => {
    fire('pointerdown', 100, 20);
    fire('pointerup', 100, 20);
    click();
    expect(opened).toEqual(['t1']);
  });

  it('鼠标移动几像素（<6px 阈值）→ 仍然算点击', () => {
    fire('pointerdown', 100, 20);
    fire('pointerup', 103, 21);
    click();
    expect(opened).toEqual(['t1']);
  });

  it('触摸轻点（很快抬手）→ 打开抽屉', () => {
    fire('pointerdown', 100, 20, 'touch');
    fire('pointerup', 100, 20, 'touch');
    click();
    expect(opened).toEqual(['t1']);
  });

  it('触摸**按得稍久**（超过 380ms 长按阈值）→ 仍然要能打开抽屉', async () => {
    /**
     * 这是真实的失败场景：正常人点一个任务，手指在屏幕上停 400-500ms 很常见。
     * 如果"按住 380ms"就直接进入拖拽态、并在松手时吞掉 click，
     * 用户看到的就是**点了没反应** —— 而且完全无法编辑任务。
     *
     * 正确判据不是"长按到了"，而是"**真的移动过**"：
     * 一动没动的长按应该什么都不是（既不拖拽、也不吞点击）。
     */
    fire('pointerdown', 100, 20, 'touch');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 420));
    });
    fire('pointerup', 100, 20, 'touch');
    const prevented = click();
    expect(opened).toEqual(['t1']);
    expect(prevented).toBe(false);
  });
});
