// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingRow } from '../SettingRow';

/* ============================================================================
   设置行的排版契约

   这三条都是"改起来看不见、坏起来到处歪"的地方：
   ① 标题必须渲染 —— 抽组件时忘写 `{label}` 是纯手误，编译完全通过；
   ② 没给 hint 时**不留下空容器** —— 留一个空的 `mt-1` div 会让那一行
      比邻居多出 20px 空白，整列间距变得忽宽忽窄（看着像没对齐）；
   ③ 控件原样作为 children 渲染 —— 行只是排版，不能替控件加/减样式，
      否则 `shrink-0` 这类移动端关键类会被悄悄改掉。
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
});

describe('SettingRow', () => {
  it('标题与说明都渲染', () => {
    act(() => {
      root?.render(
        <SettingRow label="外观" hint="深色模式夜间更省眼">
          <button type="button">控件</button>
        </SettingRow>,
      );
    });
    expect(container.textContent).toContain('外观');
    expect(container.textContent).toContain('深色模式夜间更省眼');
    expect(container.textContent).toContain('控件');
  });

  it('没有 hint 时不留空容器（否则该行会凭空高出一截）', () => {
    act(() => {
      root?.render(
        <SettingRow label="外观">
          <span>控件</span>
        </SettingRow>,
      );
    });
    const hint = container.querySelector('.text-label.text-ink-2');
    expect(hint).toBeNull();
  });

  it('控件原样渲染：行不替它加/减类名', () => {
    act(() => {
      root?.render(
        <SettingRow label="专注时长" hint="番茄钟一段多长">
          <div data-testid="ctrl" className="shrink-0">控件</div>
        </SettingRow>,
      );
    });
    const control = container.querySelector('[data-testid="ctrl"]');
    expect(control?.className).toBe('shrink-0');
    // 控件是行的直接子元素，没有被包一层会改变 flex 行为的容器
    expect(control?.parentElement?.className).toContain('flex flex-wrap items-center');
  });

  it('整行带着分隔线（相邻两行靠它分开，漏了会连成一片）', () => {
    act(() => {
      root?.render(<SettingRow label="外观"><span /></SettingRow>);
    });
    expect(container.firstElementChild?.className).toContain('border-b');
  });
});
