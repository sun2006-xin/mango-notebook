// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HabitsEditor } from '../HabitsEditor';
import type { Habit } from '../../../types';

/* ============================================================================
   习惯编辑器里的「每天生成任务」开关（长期迭代）

   这个开关是**越权风险最高**的一处：默认必须是关的，且开关本身只是
   "算出改完之后的数组"（走 SET_HABITS 整表替换），不新造 action。
   所以这里只钉两件事：默认不加 `autoTask`、点一下能改值。
   ========================================================================= */

const NOW = '2026-10-30T09:00:00.000Z';

function habit(overrides: Partial<Habit> = {}): Habit {
  return { id: 'h1', name: '背单词', createdAt: NOW, archivedAt: null, ...overrides };
}

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
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

function render(habits: Habit[], onChange: (next: Habit[]) => void): void {
  act(() => {
    root?.render(<HabitsEditor habits={habits} onChange={onChange} now={() => NOW} />);
  });
}

function click(el: Element | null): void {
  act(() => {
    (el as HTMLElement).click();
  });
}

describe('HabitsEditor · 每天生成任务', () => {
  it('默认关（不请自来地往清单里塞任务是越权）', () => {
    render([habit()], () => undefined);
    const button = container.querySelector('[data-testid="habit-auto-task"]');
    expect(button?.getAttribute('aria-pressed')).toBe('false');
    expect(button?.textContent).toContain('关');
  });

  it('点一下 → onChange 收到 autoTask: true', () => {
    const onChange = vi.fn();
    render([habit()], onChange);
    click(container.querySelector('[data-testid="habit-auto-task"]'));

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]?.[0] as Habit[];
    expect(next[0]?.autoTask).toBe(true);
    // 整表替换：其它字段原样带过去
    expect(next[0]?.name).toBe('背单词');
  });

  it('已经是开的 → 再点一下变回关', () => {
    const onChange = vi.fn();
    render([habit({ autoTask: true })], onChange);
    const button = container.querySelector('[data-testid="habit-auto-task"]');
    expect(button?.getAttribute('aria-pressed')).toBe('true');
    click(button);

    const next = onChange.mock.calls[0]?.[0] as Habit[];
    expect(next[0]?.autoTask).toBe(false);
  });

  it('已归档的习惯没有这个开关（归档 = 从今日页消失，不会再派任务）', () => {
    render([habit({ archivedAt: NOW })], () => undefined);
    expect(container.querySelector('[data-testid="habit-auto-task"]')).toBeNull();
  });
});
