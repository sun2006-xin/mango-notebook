import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../../constants';
import { dueHabitTasks } from '../../lib/habits';
import { sanitizeSettings } from '../../lib/sanitize';
import { createEmptyState, reducer } from '../reducer';
import type { AppState, DateKey, Habit, Task } from '../../types';

/* ============================================================================
   长期迭代的三条 action（习惯 → 今日任务 / 自动周报）
   ----------------------------------------------------------------------------
   这里只钉 reducer：**派一次就不再派**、**开关没变不写盘**、
   **任务和流水必须一起落**。触发时机（挂载 / 跨天）在 hooks 的测试里。

   为什么"任务和流水必须一起落"要专门测：分成两个 action 的话，
   中间任何一次中断都会留下"任务建了但没记流水"，下次启动再建一遍 ——
   用户看到的是一天的待办里出现两条「背单词」，删掉还长回来。
   ========================================================================= */

const TODAY = '2026-10-30' as DateKey;
const NOW = '2026-10-30T09:00:00.000Z';

function habit(id: string, name = id, extra: Partial<Habit> = {}): Habit {
  return { id, name, createdAt: NOW, archivedAt: null, ...extra };
}

function base(overrides: Partial<AppState> = {}): AppState {
  const empty = createEmptyState();
  return {
    ...empty,
    settings: { ...createDefaultSettings(TODAY), ...overrides.settings },
    ...overrides,
  };
}

function task(id: string, date: DateKey, order: number): Task {
  return {
    id,
    title: id,
    note: '',
    date,
    time: null,
    repeat: 'none',
    priority: 'medium',
    category: '学习',
    done: false,
    doneAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    parentId: null,
    estimatedMinutes: 0,
    order,
  };
}

describe('HABIT_TASK_GENERATE', () => {
  it('没有习惯开开关 → 返回同一个 state（不写盘、不推送）', () => {
    const state = base({ settings: { ...createDefaultSettings(TODAY), habits: [habit('a')] } });
    expect(reducer(state, { type: 'HABIT_TASK_GENERATE', date: TODAY, now: NOW })).toBe(state);
  });

  it('开了开关 → 建一条任务（标题=习惯名、日期=传入日期、顶层、未完成）', () => {
    const state = base({
      settings: {
        ...createDefaultSettings(TODAY),
        habits: [habit('a', '背单词', { autoTask: true })],
      },
    });
    const next = reducer(state, { type: 'HABIT_TASK_GENERATE', date: TODAY, now: NOW });
    expect(next.tasks).toHaveLength(1);
    expect(next.tasks[0]).toMatchObject({
      title: '背单词',
      date: TODAY,
      parentId: null,
      done: false,
      createdAt: NOW,
    });
  });

  it('同一天再派一次 → 返回同一个 state（流水挡住了）', () => {
    const state = base({
      settings: {
        ...createDefaultSettings(TODAY),
        habits: [habit('a', '背单词', { autoTask: true })],
      },
    });
    const first = reducer(state, { type: 'HABIT_TASK_GENERATE', date: TODAY, now: NOW });
    expect(first.tasks).toHaveLength(1);
    expect(reducer(first, { type: 'HABIT_TASK_GENERATE', date: TODAY, now: NOW })).toBe(first);
  });

  it('换一天 → 再派一次（跨天要重新生成）', () => {
    const state = base({
      settings: {
        ...createDefaultSettings(TODAY),
        habits: [habit('a', '背单词', { autoTask: true })],
      },
    });
    const first = reducer(state, { type: 'HABIT_TASK_GENERATE', date: TODAY, now: NOW });
    const next = reducer(first, { type: 'HABIT_TASK_GENERATE', date: '2026-10-31', now: NOW });
    expect(next.tasks).toHaveLength(2);
    expect(next.tasks[1]?.date).toBe('2026-10-31');
  });

  it('两个习惯同一天 → 两条任务 + 两条流水', () => {
    const state = base({
      settings: {
        ...createDefaultSettings(TODAY),
        habits: [
          habit('a', '背单词', { autoTask: true }),
          habit('b', '跑步', { autoTask: true }),
          habit('c', '不生成'),
        ],
      },
    });
    const next = reducer(state, { type: 'HABIT_TASK_GENERATE', date: TODAY, now: NOW });
    expect(next.tasks.map((item) => item.title).sort()).toEqual(['跑步', '背单词'].sort());
    expect(next.settings.habitTaskLog).toHaveLength(2);
  });

  it('归档的习惯不生成', () => {
    const state = base({
      settings: {
        ...createDefaultSettings(TODAY),
        habits: [habit('a', '背单词', { autoTask: true, archivedAt: NOW })],
      },
    });
    expect(reducer(state, { type: 'HABIT_TASK_GENERATE', date: TODAY, now: NOW })).toBe(state);
  });

  /** 排序位：这天手动排过就排队尾，没排过就保持 0（自动排序） */
  it('当天已手动排序 → 新任务拿到 max+1（不会顶到最前面）', () => {
    const state = base({
      tasks: [task('t1', TODAY, 5)],
      settings: {
        ...createDefaultSettings(TODAY),
        habits: [habit('a', '背单词', { autoTask: true })],
      },
    });
    const next = reducer(state, { type: 'HABIT_TASK_GENERATE', date: TODAY, now: NOW });
    expect(next.tasks.find((item) => item.title === '背单词')?.order).toBe(6);
  });

  it('分类取第一个分类（习惯本身不带分类）', () => {
    const settings = createDefaultSettings(TODAY);
    const state = base({
      settings: { ...settings, habits: [habit('a', '背单词', { autoTask: true })] },
    });
    const next = reducer(state, { type: 'HABIT_TASK_GENERATE', date: TODAY, now: NOW });
    expect(next.tasks[0]?.category).toBe(settings.categories[0]?.name);
  });

  /**
   * 习惯名被清空时 `createTask` 会抛。这时候**不能记流水** ——
   * 记了就等于"这个习惯今天派过了"，用户改好名字之后当天再也拿不到任务。
   */
  it('习惯名为空 → 不生成任务，也不记流水（改好名字当天还能补上）', () => {
    const state = base({
      settings: {
        ...createDefaultSettings(TODAY),
        habits: [habit('a', '', { autoTask: true })],
      },
    });
    const next = reducer(state, { type: 'HABIT_TASK_GENERATE', date: TODAY, now: NOW });
    expect(next).toBe(state);
    expect(next.settings.habitTaskLog).toHaveLength(0);
  });
});

describe('SET_WEEKLY_AUTO_REPORT', () => {
  it('默认开（否则这个功能在真实使用里等于不存在）', () => {
    expect(createDefaultSettings(TODAY).weeklyAutoReport).toBe(true);
  });

  it('关掉 → false', () => {
    const state = base();
    const next = reducer(state, { type: 'SET_WEEKLY_AUTO_REPORT', value: false });
    expect(next.settings.weeklyAutoReport).toBe(false);
  });

  it('值没变 → 同一个 state（checkbox 会给一次多余回调，不该触发写盘）', () => {
    const state = base();
    expect(reducer(state, { type: 'SET_WEEKLY_AUTO_REPORT', value: true })).toBe(state);
  });
});

describe('WEEKLY_REPORT_LOG_ADD', () => {
  it('记下一个周起始日', () => {
    const state = base();
    const next = reducer(state, { type: 'WEEKLY_REPORT_LOG_ADD', startKey: '2026-10-19' });
    expect(next.settings.weeklyReportLog).toEqual(['2026-10-19']);
  });

  it('重复记 → 同一个 state', () => {
    const state = base();
    const first = reducer(state, { type: 'WEEKLY_REPORT_LOG_ADD', startKey: '2026-10-19' });
    expect(reducer(first, { type: 'WEEKLY_REPORT_LOG_ADD', startKey: '2026-10-19' })).toBe(first);
  });

  it('按日期升序收敛（与冷启动读盘的口径一致）', () => {
    const state = base();
    const first = reducer(state, { type: 'WEEKLY_REPORT_LOG_ADD', startKey: '2026-10-19' });
    const second = reducer(first, { type: 'WEEKLY_REPORT_LOG_ADD', startKey: '2026-10-12' });
    expect(second.settings.weeklyReportLog).toEqual(['2026-10-12', '2026-10-19']);
  });

  it('非法日期 → 拒绝（不会写进一个空日期）', () => {
    const state = base();
    expect(reducer(state, { type: 'WEEKLY_REPORT_LOG_ADD', startKey: '不是日期' })).toBe(state);
  });

  /**
   * 满上限（60 周，约一年）之后仍然要能记新的一周。
   *
   * 原来的幂等判据是"长度没变就返回原 state"，而 sanitize 满 60 条会丢最旧一条
   * —— 加新的与丢旧的抵消，长度不变 → 判成无变化。于是第 61 周起永远记不进流水：
   * 用户删掉那段自动周报，每次启动又会被写回来（还附带一次保存 + 云推送）。
   * 满一年才复发，靠手测几乎不可能发现。
   */
  it('流水已满 60 周 → 新的一周仍能记进去（长度不变不代表没变化）', () => {
    const full = Array.from({ length: 60 }, (_, i) => {
      const d = new Date(2024, 0, 1 + i * 7);
      const p = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    });
    const state = { ...base(), settings: { ...base().settings, weeklyReportLog: full } };

    const next = reducer(state, { type: 'WEEKLY_REPORT_LOG_ADD', startKey: '2026-11-02' });
    expect(next.settings.weeklyReportLog).toContain('2026-11-02');
    // 仍然守 60 条上限（丢最旧，不是无限增长）
    expect(next.settings.weeklyReportLog).toHaveLength(60);
  });

  it('已经记过的一周 → 幂等（返回同一个 state，不产生多余写盘）', () => {
    const state = base();
    const once = reducer(state, { type: 'WEEKLY_REPORT_LOG_ADD', startKey: '2026-11-02' });
    const twice = reducer(once, { type: 'WEEKLY_REPORT_LOG_ADD', startKey: '2026-11-02' });
    expect(twice).toBe(once);
  });
});

/* ============================================================================
   老数据兼容（这条不写，升级当天就可能是「打开白屏」）

   0.27 及更早的载荷里没有 `habitTaskLog` / `weeklyAutoReport` / `weeklyReportLog`
   三个键。它们都是**必填**字段，靠 `sanitizeSettings` 逐字段重建时兜默认值。
   `sanitizeSettings` 是"逐字段重建"而不是 `...rec` —— 往它里面加字段时
   **必须显式写一行**，否则冷启动读回来是 undefined，而 hooks 里
   `weeklyReportLog.includes(...)` 会当场抛 TypeError（白屏）。
   ========================================================================= */

describe('老载荷（0.27 格式）读回来不炸', () => {
  // 模拟旧版落盘：这三个键完全不存在
  const legacy = {
    theme: 'light',
    habits: [{ id: 'h1', name: '背单词', createdAt: NOW, archivedAt: null }],
    habitChecks: [{ habitId: 'h1', date: TODAY }],
    lastView: 'today',
    lastSelectedDate: TODAY,
  } as unknown;

  it('三个新字段都补上了默认值', () => {
    const settings = sanitizeSettings(legacy);
    expect(settings.habitTaskLog).toEqual([]);
    expect(settings.weeklyAutoReport).toBe(true);
    expect(settings.weeklyReportLog).toEqual([]);
  });

  it('老习惯没有 autoTask → 视为关（不能因为缺字段就开始往清单里塞任务）', () => {
    const settings = sanitizeSettings(legacy);
    expect(settings.habits[0]?.autoTask).toBeUndefined();
  });

  it('拿这份设置跑两个 hook 的判定都不抛', () => {
    const settings = sanitizeSettings(legacy);
    expect(dueHabitTasks({ habits: settings.habits, habitTaskLog: settings.habitTaskLog, date: TODAY })).toEqual([]);
    expect(settings.weeklyReportLog.includes('2026-10-19')).toBe(false);
  });
});

describe('SET_HABITS · 只改 autoTask 也必须生效', () => {
  /**
   * 这条守的是 `sameHabits`（`domains/habits.ts`）的字段清单。
   * 它原本只比 id / name / archivedAt —— 加上 `autoTask` 之后若忘了同步，
   * 结果就是**点开关毫无反应**：reducer 判「内容没变」，返回同一个 state，
   * UI 上按钮弹回原样，而且不报错、不写日志，查起来毫无线索。
   */
  it('打开「每天生成任务」→ habits 真的更新（不是同一个 state）', () => {
    const state = base({
      settings: { ...createDefaultSettings(TODAY), habits: [habit('a', '背单词')] },
    });
    const next = reducer(state, {
      type: 'SET_HABITS',
      habits: [{ ...habit('a', '背单词'), autoTask: true }],
    });
    expect(next).not.toBe(state);
    expect(next.settings.habits[0]?.autoTask).toBe(true);
  });

  it('再关掉 → 变回关（false 被收敛掉，不留下一个等于 false 的字段）', () => {
    const state = base({
      settings: {
        ...createDefaultSettings(TODAY),
        habits: [{ ...habit('a', '背单词'), autoTask: true }],
      },
    });
    const next = reducer(state, {
      type: 'SET_HABITS',
      habits: [{ ...habit('a', '背单词'), autoTask: false }],
    });
    expect(next).not.toBe(state);
    expect(next.settings.habits[0]?.autoTask).toBeUndefined();
  });

  /** 删掉习惯要连带清掉它的**生成流水**，与打卡同一口径（孤儿记录会跟着云同步来回传） */
  it('删掉习惯 → 它的生成流水一起清掉', () => {
    const state = base({
      settings: {
        ...createDefaultSettings(TODAY),
        habits: [habit('a'), habit('b')],
        habitTaskLog: [
          { habitId: 'a', date: TODAY },
          { habitId: 'b', date: TODAY },
        ],
      },
    });
    const next = reducer(state, { type: 'SET_HABITS', habits: [habit('a')] });
    expect(next.settings.habitTaskLog).toEqual([{ habitId: 'a', date: TODAY }]);
  });
});
