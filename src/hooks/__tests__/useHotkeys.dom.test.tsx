// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VIEW_ORDER } from '../../constants';
import { isTypingTarget, resolveHotkey, useHotkeys } from '../useHotkeys';
import type { HotkeyHandlers } from '../useHotkeys';

/* ============================================================================
   键盘快捷键（v0.26）

   一条快捷键最容易出错的不是"按了没反应"，而是**在不该响应的时候响应了**：
   在日记里写字母 N，光标被弹到任务输入框 —— 用户会以为输入法坏了。
   所以这里一半的用例都在测"什么时候必须装作没听见"。
   ========================================================================= */

describe('resolveHotkey：按键 → 动作（纯函数）', () => {
  it('N / n 都是新建', () => {
    expect(resolveHotkey({ key: 'n' })).toEqual({ kind: 'new' });
    expect(resolveHotkey({ key: 'N' })).toEqual({ kind: 'new' });
  });

  it('/ 是搜索', () => {
    expect(resolveHotkey({ key: '/' })).toEqual({ kind: 'search' });
  });

  it('1–7 映射到导航顺序上的视图', () => {
    VIEW_ORDER.forEach((view, index) => {
      expect(resolveHotkey({ key: String(index + 1) })).toEqual({ kind: 'view', view });
    });
  });

  it('超出导航范围的数字不认（8/9 不越界成 undefined 视图）', () => {
    if (VIEW_ORDER.length < 8) expect(resolveHotkey({ key: '8' })).toBeNull();
    expect(resolveHotkey({ key: '0' })).toBeNull();
    expect(resolveHotkey({ key: '9' })).toBeNull();
  });

  it('不相干的键一律 null（别 preventDefault 抢别人的键）', () => {
    for (const key of ['a', 'Enter', ' ', 'Escape', 'ArrowDown', '?']) {
      expect(resolveHotkey({ key })).toBeNull();
    }
  });

  it('正在打字时不响应（input / textarea / contenteditable）', () => {
    expect(resolveHotkey({ key: 'n', typing: true })).toBeNull();
    expect(resolveHotkey({ key: '/', typing: true })).toBeNull();
    expect(resolveHotkey({ key: '1', typing: true })).toBeNull();
  });

  /**
   * 三个修饰键各一条用例：合在一起写的话，变异时只会红一条，
   * "是 Ctrl 被抢了还是 Alt 被抢了"就看不出来。
   */
  it('Ctrl+N 不抢（浏览器的新窗口）', () => {
    expect(resolveHotkey({ key: 'n', ctrlKey: true })).toBeNull();
  });

  it('Cmd+N 不抢（macOS）', () => {
    expect(resolveHotkey({ key: 'n', metaKey: true })).toBeNull();
  });

  it('Alt+/ 不抢', () => {
    expect(resolveHotkey({ key: '/', altKey: true })).toBeNull();
  });

  it('已被别人 preventDefault 的按键尊重先手', () => {
    expect(resolveHotkey({ key: 'n', prevented: true })).toBeNull();
  });

  it('浮层开着（enabled=false）时整体失效', () => {
    expect(resolveHotkey({ key: 'n', enabled: false })).toBeNull();
    expect(resolveHotkey({ key: '1', enabled: false })).toBeNull();
  });
});

describe('isTypingTarget：哪些元素算"正在打字"', () => {
  it('input / textarea / select 都算', () => {
    for (const tag of ['input', 'textarea', 'select']) {
      expect(isTypingTarget(document.createElement(tag))).toBe(true);
    }
  });

  it('contenteditable 也算（富文本编辑器）', () => {
    const div = document.createElement('div');
    div.setAttribute('contenteditable', 'true');
    // jsdom 不实现 isContentEditable 的语义，这里直接给个真值模拟
    Object.defineProperty(div, 'isContentEditable', { value: true });
    expect(isTypingTarget(div)).toBe(true);
  });

  it('普通元素 / null 不算', () => {
    expect(isTypingTarget(document.createElement('div'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

interface ProbeProps {
  handlers: HotkeyHandlers;
  enabled?: boolean;
}

function Probe({ handlers, enabled = true }: ProbeProps): null {
  useHotkeys(handlers, { enabled });
  return null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

function mount(props: ProbeProps): void {
  act(() => root.render(<Probe {...props} />));
}

function press(key: string, target: EventTarget = window, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe('useHotkeys：真实键盘事件', () => {
  it('按 N 触发新建，且 preventDefault（不让浏览器插手）', () => {
    const onNew = vi.fn();
    mount({ handlers: { onNew } });
    const event = press('n');
    expect(onNew).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('按 / 打开搜索', () => {
    const onSearch = vi.fn();
    mount({ handlers: { onSearch } });
    press('/');
    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it('按 3 切到第 3 个视图', () => {
    const onView = vi.fn();
    mount({ handlers: { onView } });
    press('3');
    expect(onView).toHaveBeenCalledWith(VIEW_ORDER[2]);
  });

  it('在输入框里按 N：不触发，也不 preventDefault（字母要能打进去）', () => {
    const onNew = vi.fn();
    const input = document.createElement('input');
    document.body.appendChild(input);
    mount({ handlers: { onNew } });

    const event = press('n', input);

    expect(onNew).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('浮层开着（enabled=false）时按 1 不切视图', () => {
    const onView = vi.fn();
    mount({ handlers: { onView }, enabled: false });

    press('1');

    expect(onView).not.toHaveBeenCalled();
  });

  it('没有对应 handler 的键不报错、也不 preventDefault', () => {
    mount({ handlers: {} });
    const event = press('n');
    expect(event.defaultPrevented).toBe(false);
  });

  it('卸载后不再响应（监听器必须摘掉）', () => {
    const onNew = vi.fn();
    mount({ handlers: { onNew } });
    act(() => root.unmount());

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', cancelable: true }));

    expect(onNew).not.toHaveBeenCalled();
  });

  it('handler 换了新的（每次渲染都是新对象）也能调到最新那个', () => {
    const first = vi.fn();
    const second = vi.fn();
    mount({ handlers: { onNew: first } });
    act(() => root.render(<Probe handlers={{ onNew: second }} />));

    press('n');

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
