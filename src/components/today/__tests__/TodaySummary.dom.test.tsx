// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TodaySummary } from '../TodaySummary';

/* ============================================================================
   今日概览条的行为（v0.29.8）
   ----------------------------------------------------------------------------
   这个组件存在的唯一理由是"**默认收起**"——首屏要把高度让给任务清单
   （实测那四块摊开占 384px，会把第一条任务顶到 1.18 屏）。
   所以行为契约就四条：
     ① 默认不渲染内容（否则收起等于没做）；
     ② 展开后才渲染，且 aria-expanded / 文案跟着变（读屏与视觉一致）；
     ③ 受控：点击只调 onToggle，不自作主张改状态；
     ④ 没有任何摘要时整块不渲染（一个空壳按钮也是噪音）。
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

function render(node: React.ReactElement) {
  act(() => root?.render(node));
}

const probe = () => container.querySelector('[data-testid="panel-content"]');

describe('TodaySummary', () => {
  it('默认收起：内容不进 DOM，但摘要仍可见', () => {
    render(
      <TodaySummary chips={['距考试 60 天', '昨日 3/5']} expanded={false} onToggle={() => {}}>
        <div data-testid="panel-content">回顾卡</div>
      </TodaySummary>,
    );
    expect(probe()).toBeNull();
    expect(container.textContent).toContain('距考试 60 天 · 昨日 3/5');
    expect(container.textContent).toContain('展开');
  });

  it('展开后才渲染内容，文案与 aria-expanded 一起变', () => {
    render(
      <TodaySummary chips={['a']} expanded onToggle={() => {}}>
        <div data-testid="panel-content">回顾卡</div>
      </TodaySummary>,
    );
    expect(probe()).not.toBeNull();
    expect(container.textContent).toContain('收起');
    expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('点击只调 onToggle（受控组件，不自作主张改状态）', () => {
    let calls = 0;
    render(
      <TodaySummary chips={['a']} expanded={false} onToggle={() => { calls += 1; }}>
        <div data-testid="panel-content">回顾卡</div>
      </TodaySummary>,
    );
    act(() => container.querySelector<HTMLButtonElement>('button')?.click());
    expect(calls).toBe(1);
    expect(probe()).toBeNull();
  });

  it('没有任何摘要时整块不渲染（空壳按钮也是噪音）', () => {
    render(
      <TodaySummary chips={[]} expanded={false} onToggle={() => {}}>
        <div data-testid="panel-content">回顾卡</div>
      </TodaySummary>,
    );
    expect(container.querySelector('button')).toBeNull();
    expect(probe()).toBeNull();
  });
});
