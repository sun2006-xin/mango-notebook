import { beforeEach, describe, expect, it } from 'vitest';
import { __dayViewScans, __resetDayView, dayProgressOf, selectDayView } from '../dayView';
import { groupDayTasks } from '../task';
import { createDefaultSettings } from '../../constants';
import type { Task } from '../../types';

/* ============================================================================
   今日页派生数据：**引用稳定** + 只扫一遍（v0.30.0）
   ----------------------------------------------------------------------------
   这一层解决的问题不是"算得慢"，而是**白算**：
   ① 原来 progress / dayTasks / group 三处各扫全表（group 内部还会再扫一次）；
   ② 每次调用都新建对象 → 下游 `TaskList` 的 memo 永远不命中。

   所以两条契约：
     · 输入引用没变 → **返回同一个对象**（memo 才能生效）；
     · 输入任一项变了 → 新对象（不能拿旧数据糊弄）。
   外加一条"拆分不改行为"：与旧的 `groupDayTasks` 结果逐字段相等。
   ========================================================================= */

const TODAY = '2026-11-03';
const DATE = '2026-11-03';

function task(over: Partial<Task> & { id: string }): Task {
  return {
    title: over.id,
    note: '',
    date: DATE,
    endDate: null,
    time: null,
    repeat: 'none',
    priority: 'medium',
    category: 'c1',
    done: false,
    doneAt: null,
    createdAt: '2026-11-03T00:00:00.000Z',
    updatedAt: '2026-11-03T00:00:00.000Z',
    parentId: null,
    estimatedMinutes: 0,
    ...over,
  } as Task;
}

const baseInput = (tasks: Task[]) => ({
  tasks,
  date: DATE,
  today: TODAY,
  mode: 'all' as const,
  category: null,
  stickyDoneIds: [] as string[],
  includeOverdue: true,
});

beforeEach(() => {
  __resetDayView();
});

describe('selectDayView · 引用稳定', () => {
  it('同样的输入 → 返回同一个对象（缓存命中，不再扫表）', () => {
    const tasks = [task({ id: 'a', time: '09:00' })];
    const first = selectDayView(baseInput(tasks));
    const before = __dayViewScans;

    const second = selectDayView(baseInput(tasks));
    expect(second).toBe(first);
    expect(__dayViewScans).toBe(before); // 没有真的算第二遍
  });

  it('任务数组换了引用 → 新对象（元素是对象，只比引用，不做逐项深比）', () => {
    const tasks = [task({ id: 'a' })];
    const first = selectDayView(baseInput(tasks));
    const second = selectDayView(baseInput([...tasks]));
    expect(second).not.toBe(first);
  });

  it('stickyDoneIds 传新的空数组字面量也能命中（否则缓存会静默失效）', () => {
    const tasks = [task({ id: 'a' })];
    const first = selectDayView({ ...baseInput(tasks), stickyDoneIds: [] });
    const second = selectDayView({ ...baseInput(tasks), stickyDoneIds: [] });
    expect(second).toBe(first);
  });

  it('任一输入变了 → 新对象（日期 / 模式 / 分类 / sticky）', () => {
    const tasks = [task({ id: 'a' })];
    const first = selectDayView(baseInput(tasks));

    expect(selectDayView({ ...baseInput(tasks), date: '2026-11-04' })).not.toBe(first);
    expect(selectDayView({ ...baseInput(tasks), mode: 'open' })).not.toBe(first);
    expect(selectDayView({ ...baseInput(tasks), category: 'c1' })).not.toBe(first);
    expect(selectDayView({ ...baseInput(tasks), stickyDoneIds: ['a'] })).not.toBe(first);
  });

  it('扫描次数：任务一变只扫 1 次（旧路径是 3 次 filter + 1 次 overdue）', () => {
    /**
     * 这是**可数的事实**，不是感觉：
     * 旧实现里 progress / dayTasks / group 各调一次 `getTasksForDate`，
     * 而 `groupDayTasks` 内部又调了一次 —— 同一张表被 filter 三遍。
     * 现在一次取当日数组喂两处，所以"任务变了"这件事**只扫 1 次**。
     */
    __resetDayView();
    const tasks = [task({ id: 'a' }), task({ id: 'b' })];

    selectDayView(baseInput(tasks));
    expect(__dayViewScans).toBe(1);

    // 内容真的变了（新数组）→ 再扫 1 次
    selectDayView(baseInput([...tasks, task({ id: 'c' })]));
    expect(__dayViewScans).toBe(2);
  });

  it('UI 动作改了别的 state、但任务与筛选没变 → 仍然命中缓存', () => {
    /**
     * 这正是用户说的"每次 store 变化都走一遍分组排序"的反面：
     * 打开抽屉 / 弹 toast 只改 `ui`，`tasks` 与筛选都没变 → 这里应当直接命中。
     */
    const tasks = [task({ id: 'a' })];
    const first = selectDayView(baseInput(tasks));
    const before = __dayViewScans;

    // 模拟"打开抽屉后再关掉"：同一份 tasks 反复查询
    for (let i = 0; i < 5; i += 1) {
      expect(selectDayView(baseInput(tasks))).toBe(first);
    }
    expect(__dayViewScans).toBe(before);
  });
});

describe('selectDayView · 与旧实现同口径', () => {
  const settings = createDefaultSettings(DATE);

  function sample(): Task[] {
    return [
      task({ id: 'a', time: '09:00', priority: 'high' }),
      task({ id: 'b', time: '10:00', done: true }),
      task({ id: 'c', time: '11:00', category: 'c2' }),
      task({ id: 'd', date: '2026-11-01', time: '08:00' }), // 逾期
      task({ id: 'e', date: '2026-11-02', endDate: '2026-11-04' }), // 跨天覆盖今天
      task({ id: 'f', parentId: 'a', time: '09:30' }), // 子任务
      task({ id: 'g', done: true, time: '07:00' }),
    ];
  }

  it('progress 与 getDayProgress 完全一致', () => {
    const tasks = sample();
    const view = selectDayView(baseInput(tasks));
    expect(view.progress).toEqual(dayProgressOf(tasks, DATE));
    expect(view.progress.total).toBe(6); // 6 条覆盖今天（d 是昨天）
  });

  it('group 与 groupDayTasks 完全一致（拆分没有改变行为）', () => {
    const tasks = sample();
    const input = baseInput(tasks);
    const view = selectDayView(input);
    const legacy = groupDayTasks(input);
    expect(view.group.overdue.map((t) => t.id)).toEqual(legacy.overdue.map((t) => t.id));
    expect(view.group.open.map((t) => t.id)).toEqual(legacy.open.map((t) => t.id));
    expect(view.group.done.map((t) => t.id)).toEqual(legacy.done.map((t) => t.id));
    expect(Object.keys(view.group.childrenByParent).sort()).toEqual(
      Object.keys(legacy.childrenByParent).sort(),
    );
  });

  it('分类筛选时，group 与旧实现仍然一致（子任务不跟着分类筛）', () => {
    const tasks = sample();
    const input = { ...baseInput(tasks), category: 'c1' };
    const view = selectDayView(input);
    const legacy = groupDayTasks(input);
    expect(view.group.open.map((t) => t.id)).toEqual(legacy.open.map((t) => t.id));
    expect(view.dayTasks.length).toBe(6); // dayTasks 不受分类筛选影响
  });

  it('空列表不炸（percent 为 null）', () => {
    const view = selectDayView(baseInput([]));
    expect(view.progress).toEqual({ done: 0, total: 0, percent: null });
    expect(view.group.open).toEqual([]);
  });

  it('settings 的默认分类存在（保证样本数据没有悬空分类）', () => {
    expect(settings.categories.length).toBeGreaterThan(0);
  });
});
