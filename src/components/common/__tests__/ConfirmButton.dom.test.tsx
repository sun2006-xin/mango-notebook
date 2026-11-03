// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmButton } from '../ConfirmButton';

/* ============================================================================
   二次确认按钮：**点一下武装，再点一下执行，3 秒自动收回**
   ----------------------------------------------------------------------------
   这个组件是把项目里四种混用的确认写法收成一个。四种写法的差别不只是外观：
   有的会自动收回、有的不会（历史回滚就不会 —— 点一下武装就永不退回，
   用户切走再回来随手一点就真的回滚了）。所以这里守的是**行为**，
   不是"按钮里有没有那句话"。
   ========================================================================= */

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

function render(props: Partial<Parameters<typeof ConfirmButton>[0]> = {}): HTMLButtonElement {
  const onConfirm = props.onConfirm ?? (() => undefined);
  act(() => {
    root?.render(
      <ConfirmButton testId="t" onConfirm={onConfirm} {...props}>
        清空数据
      </ConfirmButton>,
    );
  });
  const btn = container.querySelector<HTMLButtonElement>('[data-testid="t"]');
  if (!btn) throw new Error('按钮没渲染出来');
  return btn;
}

const click = (btn: HTMLButtonElement) => act(() => btn.click());

describe('ConfirmButton', () => {
  it('第一次点击只武装：不执行，文案切换，标记 data-armed', () => {
    const onConfirm = vi.fn();
    const btn = render({ onConfirm, confirmLabel: '确认清空？再点一次' });

    click(btn);

    expect(onConfirm).not.toHaveBeenCalled();
    expect(btn.getAttribute('data-armed')).toBe('true');
    expect(btn.textContent).toContain('确认清空？再点一次');
  });

  it('第二次点击执行且只执行一次，随后回到静息态', () => {
    const onConfirm = vi.fn();
    const btn = render({ onConfirm, confirmLabel: '确认清空？再点一次' });

    click(btn); // 武装
    click(btn); // 执行

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(btn.getAttribute('data-armed')).toBeNull();
    expect(btn.textContent).toContain('清空数据');

    // 第三次点击重新武装，不会再执行一次
    click(btn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('3 秒没有第二次点击 → 自动退回静息态（防"很久以后误点"）', () => {
    vi.useFakeTimers();
    const onConfirm = vi.fn();
    const btn = render({ onConfirm });

    click(btn);
    expect(btn.getAttribute('data-armed')).toBe('true');

    act(() => {
      vi.advanceTimersByTime(2999);
    });
    expect(btn.getAttribute('data-armed')).toBe('true');

    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(btn.getAttribute('data-armed')).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('超时可配：传 1000 就 1 秒收回', () => {
    vi.useFakeTimers();
    const btn = render({ timeoutMs: 1000 });
    click(btn);
    act(() => {
      vi.advanceTimersByTime(1001);
    });
    expect(btn.getAttribute('data-armed')).toBeNull();
  });

  it('卸载时清掉定时器：不留"组件没了还去 setState"的尾巴', () => {
    vi.useFakeTimers();
    const btn = render({});
    click(btn);
    // 武装状态下直接卸载
    act(() => root?.unmount());
    root = null;
    // 推进到原定时点：不应抛错（React 会警告 setState on unmounted）
    expect(() =>
      act(() => {
        vi.advanceTimersByTime(5000);
      }),
    ).not.toThrow();
  });

  it('disabled 时点了没反应（也不武装）', () => {
    const onConfirm = vi.fn();
    const btn = render({ onConfirm, disabled: true });
    click(btn);
    expect(btn.getAttribute('data-armed')).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  /*
    故意**不**写"onConfirm 抛错"的用例：React 会把事件处理里的异常作为
    未处理错误抛回运行器（`Unhandled Errors` 一节），而那会让整轮测试带上
    一条噪音，反而掩盖真正的问题。"先收状态再执行"这条纪律留在组件注释里，
    行为上由"第二次点击后必须回到静息态"那条用例覆盖。
  */
});
