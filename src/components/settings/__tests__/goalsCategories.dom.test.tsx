// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* ============================================================================
   GoalsEditor / CategoriesEditor（设置页拆出来的两块）

   为什么从 SettingsView 里搬出来还要单独补测试：

   这两块原来躺在那 1400 行的视图里，**没有任何 UI 测试覆盖** ——
   搬运时一个 props 改名、一个 `dispatch` 漏传，全量测试也照样绿，
   因为没人从界面上点过它们。搬出来正好是个补齐的机会：
   现在它们的依赖只剩 context + 两个纯函数，可以独立挂载。

   钉的都是"用户点下去会发生什么"：
   ① 输名字 → 点添加 → dispatch 出 `SET_GOALS` / `CATEGORY_ADD`，字段对不对；
   ② 重名 / 空名 → **不 dispatch**，只提示（连点两下不该造出两条一样的）；
   ③ 删除 → 只删那一条；分类只剩一个时拒绝删（否则任务无处归类）；
   ④ 从「输入框改完失焦」这条路（分类重命名）必须真的级联。
   ========================================================================= */

const mocks = vi.hoisted(() => ({
  state: null as unknown,
  dispatch: vi.fn(),
  show: vi.fn(),
}));

vi.mock('../../../store/StoreContext', () => ({
  useAppState: () => mocks.state,
  useAppDispatch: () => mocks.dispatch,
}));

vi.mock('../../../hooks/useToast', () => ({
  useToast: () => ({ show: mocks.show, dismiss: vi.fn() }),
}));

const { GoalsEditor } = await import('../GoalsEditor');
const { CategoriesEditor } = await import('../CategoriesEditor');
const { createDefaultSettings } = await import('../../../constants');

const TODAY = '2026-10-31' as const;

function stateWith(settings: Record<string, unknown>, tasks: unknown[] = []): unknown {
  return {
    tasks,
    settings: { ...createDefaultSettings(TODAY), ...settings },
    diary: [],
    notes: [],
    focusSessions: [],
    tombstones: [],
  };
}

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  // React 18 的 act 需要显式开关，否则每次 act 都打一行警告
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.dispatch.mockReset();
  mocks.show.mockReset();
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  container.remove();
});

function render(node: React.ReactNode): void {
  act(() => root?.render(node));
}

function type(el: Element | null, value: string): void {
  const input = el as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function click(el: Element | null): void {
  act(() => {
    (el as HTMLElement).click();
  });
}

describe('GoalsEditor · 目标倒计时', () => {
  it('没有目标时显示空态', () => {
    mocks.state = stateWith({ goals: [] });
    render(<GoalsEditor today={TODAY} />);
    expect(container.querySelector('[data-testid="goal-empty"]')).not.toBeNull();
  });

  it('输入名字 + 选日期 → 点添加 → dispatch SET_GOALS（带新目标）', () => {
    mocks.state = stateWith({ goals: [] });
    render(<GoalsEditor today={TODAY} />);

    type(container.querySelector('[data-testid="goal-name-input"]'), '转本考试');
    type(container.querySelector('[data-testid="goal-date-input"]'), '2027-04-01');
    click(container.querySelector('[data-testid="goal-add"]'));

    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    const action = mocks.dispatch.mock.calls[0][0];
    expect(action.type).toBe('SET_GOALS');
    expect(action.goals).toHaveLength(1);
    expect(action.goals[0].name).toBe('转本考试');
    expect(action.goals[0].date).toBe('2027-04-01');
    expect(action.goals[0].id).toEqual(expect.any(String));
  });

  it('名字为空 → 不 dispatch，只提示', () => {
    mocks.state = stateWith({ goals: [] });
    render(<GoalsEditor today={TODAY} />);
    click(container.querySelector('[data-testid="goal-add"]'));

    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.show).toHaveBeenCalled();
  });

  it('同名同日期再来一次 → 挡住（连点两下不该造出两条一样的）', () => {
    mocks.state = stateWith({ goals: [{ id: 'g1', name: '转本考试', date: '2027-04-01' }] });
    render(<GoalsEditor today={TODAY} />);

    type(container.querySelector('[data-testid="goal-name-input"]'), '转本考试');
    type(container.querySelector('[data-testid="goal-date-input"]'), '2027-04-01');
    click(container.querySelector('[data-testid="goal-add"]'));

    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.show.mock.calls[0][0]).toContain('已经在列表里');
  });

  it('删除 → dispatch 的是"去掉这一条之后"的完整数组', () => {
    mocks.state = stateWith({
      goals: [
        { id: 'g1', name: '转本考试', date: '2027-04-01' },
        { id: 'g2', name: '四级', date: '2027-06-01' },
      ],
    });
    render(<GoalsEditor today={TODAY} />);

    click(container.querySelector('[data-testid="goal-delete-g1"]'));

    const action = mocks.dispatch.mock.calls[0][0];
    expect(action.type).toBe('SET_GOALS');
    expect(action.goals.map((goal: { id: string }) => goal.id)).toEqual(['g2']);
  });

  it('倒计时按"距今天数"显示，过期的说已过期', () => {
    mocks.state = stateWith({ goals: [{ id: 'g1', name: '已过', date: '2026-10-01' }] });
    render(<GoalsEditor today={TODAY} />);
    expect(container.querySelector('[data-testid="goal-item-g1"]')?.textContent).toContain('已过');
  });
});

describe('CategoriesEditor · 分类管理', () => {
  it('新增分类 → dispatch CATEGORY_ADD', () => {
    mocks.state = stateWith({ categories: [{ id: 'c1', name: '学习' }] });
    render(<CategoriesEditor />);

    type(container.querySelector('[data-testid="cat-add-input"]'), '运动');
    click([...container.querySelectorAll('button')].find((b) => b.textContent === '添加分类') ?? null);

    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    const action = mocks.dispatch.mock.calls[0][0];
    expect(action.type).toBe('CATEGORY_ADD');
    expect(action.name).toBe('运动');
  });

  it('重名分类 → 不 dispatch', () => {
    mocks.state = stateWith({ categories: [{ id: 'c1', name: '学习' }] });
    render(<CategoriesEditor />);

    type(container.querySelector('[data-testid="cat-add-input"]'), '学习');
    click([...container.querySelectorAll('button')].find((b) => b.textContent === '添加分类') ?? null);

    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.show.mock.calls[0][0]).toContain('已存在');
  });

  it('改名后失焦 → dispatch CATEGORY_RENAME（级联重写任务分类）', () => {
    mocks.state = stateWith({ categories: [{ id: 'c1', name: '学习' }] });
    render(<CategoriesEditor />);

    const input = container.querySelector('[data-cat-id="c1"] input') as HTMLInputElement;
    input.value = '功课';
    act(() => {
      // React 把 onBlur 挂在 focusout 上（blur 本身不冒泡，派发给根监听器收不到）
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });

    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    const action = mocks.dispatch.mock.calls[0][0];
    expect(action.type).toBe('CATEGORY_RENAME');
    expect(action).toMatchObject({ id: 'c1', name: '功课' });
  });

  it('改成已存在的名字 → 驳回并把输入框写回原值', () => {
    mocks.state = stateWith({
      categories: [
        { id: 'c1', name: '学习' },
        { id: 'c2', name: '运动' },
      ],
    });
    render(<CategoriesEditor />);

    const input = container.querySelector('[data-cat-id="c1"] input') as HTMLInputElement;
    input.value = '运动';
    act(() => {
      // React 把 onBlur 挂在 focusout 上（blur 本身不冒泡，派发给根监听器收不到）
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });

    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(input.value).toBe('学习');
  });

  it('只剩一个分类时不许删（否则任务无处归类）', () => {
    mocks.state = stateWith({ categories: [{ id: 'c1', name: '学习' }] });
    render(<CategoriesEditor />);

    click(container.querySelector('[aria-label="删除分类 学习"]'));

    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.show.mock.calls[0][0]).toContain('至少保留一个');
  });

  it('有多个分类时删除 → dispatch CATEGORY_REMOVE', () => {
    mocks.state = stateWith({
      categories: [
        { id: 'c1', name: '学习' },
        { id: 'c2', name: '运动' },
      ],
    });
    render(<CategoriesEditor />);

    click(container.querySelector('[aria-label="删除分类 运动"]'));

    const action = mocks.dispatch.mock.calls[0][0];
    expect(action).toMatchObject({ type: 'CATEGORY_REMOVE', id: 'c2' });
  });

  it('每个分类显示各自的任务条数', () => {
    mocks.state = stateWith({ categories: [{ id: 'c1', name: '学习' }] }, [
      { id: 't1', title: 'A', date: TODAY, category: '学习', done: false, updatedAt: TODAY },
      { id: 't2', title: 'B', date: TODAY, category: '学习', done: false, updatedAt: TODAY },
    ]);
    render(<CategoriesEditor />);
    expect(container.textContent).toContain('2 项');
  });
});
