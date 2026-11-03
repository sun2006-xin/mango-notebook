// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* ============================================================================
   两条"到点自动做"的 hook（长期迭代）
   ----------------------------------------------------------------------------
   这里只测**调度**：什么时候该 dispatch、dispatch 什么、以及不该 dispatch 时
   有没有真的什么都没做。业务判定在 lib 的测试里，落库在 store 的测试里。

   三条最容易写错、也最容易在真机上表现为"每天多出两条任务"的地方：
   ① 判完 due 之后必须派 `HABIT_TASK_GENERATE`，而不是自己拼任务；
   ② 周报落库前必须**合并**已有日记（直接覆盖会吃掉用户写的东西）；
   ③ `already-written` 也要记流水，否则每次启动都重新检查、用户删掉后又被写回。
   ========================================================================= */

const mocks = vi.hoisted(() => ({
  state: null as unknown,
  dispatch: vi.fn(),
}));

vi.mock('../../store/StoreContext', () => ({
  useAppState: () => mocks.state,
  useAppDispatch: () => mocks.dispatch,
}));

const { useHabitAutoTask } = await import('../useHabitAutoTask');
const { useWeeklyAutoReport } = await import('../useWeeklyAutoReport');
const { createDefaultSettings } = await import('../../constants');
const { TEXT } = await import('../../constants');

const TODAY = '2026-10-24'; // 周五；本周 10-19 起 → 上一周 10-12 ~ 10-18
const NOW = '2026-10-24T09:00:00.000Z';

interface StateLike {
  tasks: unknown[];
  diary: { date: string; content: string; updatedAt: string }[];
  notes: unknown[];
  focusSessions: unknown[];
  settings: Record<string, unknown>;
}

function makeState(overrides: Partial<StateLike> = {}): StateLike {
  return {
    tasks: [],
    diary: [],
    notes: [],
    focusSessions: [],
    settings: createDefaultSettings(TODAY) as unknown as Record<string, unknown>,
    ...overrides,
  };
}

function stateWith(settings: Record<string, unknown>, rest: Partial<StateLike> = {}): StateLike {
  const base = makeState(rest);
  return { ...base, settings: { ...base.settings, ...settings } };
}

function taskRow(id: string, date: string, done: boolean) {
  return {
    id,
    title: id,
    note: '',
    date,
    time: null,
    repeat: 'none',
    priority: 'medium',
    category: '学习',
    done,
    doneAt: done ? `${date}T10:00:00.000Z` : null,
    createdAt: NOW,
    updatedAt: NOW,
    parentId: null,
    estimatedMinutes: 0,
    order: 0,
  };
}

function focusRow(id: string, date: string, minutes: number) {
  const start = `${date}T09:00:00`;
  return {
    id,
    taskId: null,
    date,
    startedAt: new Date(Date.parse(start)).toISOString(),
    endedAt: new Date(Date.parse(start) + minutes * 60_000).toISOString(),
    durationMs: minutes * 60_000,
  };
}

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  mocks.dispatch.mockClear();
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

function mount(element: React.ReactElement): void {
  act(() => {
    root?.render(element);
  });
}

describe('useHabitAutoTask', () => {
  function Probe({ today }: { today: string }) {
    useHabitAutoTask(today);
    return null;
  }

  const autoHabit = {
    id: 'h1',
    name: '背单词',
    createdAt: NOW,
    archivedAt: null,
    autoTask: true,
  };

  it('有该派的习惯 → 派 HABIT_TASK_GENERATE（只派这一条，不自己拼任务）', () => {
    mocks.state = stateWith({ habits: [autoHabit] });
    mount(<Probe today={TODAY} />);
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch.mock.calls[0]?.[0]).toMatchObject({
      type: 'HABIT_TASK_GENERATE',
      date: TODAY,
    });
  });

  it('没有该派的（都已派过）→ 一次都不派', () => {
    mocks.state = stateWith({
      habits: [autoHabit],
      habitTaskLog: [{ habitId: 'h1', date: TODAY }],
    });
    mount(<Probe today={TODAY} />);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('一个习惯都没开开关 → 一次都不派', () => {
    mocks.state = stateWith({ habits: [{ ...autoHabit, autoTask: false }] });
    mount(<Probe today={TODAY} />);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('跨天（today 变）→ 重新派一次', () => {
    mocks.state = stateWith({
      habits: [autoHabit],
      habitTaskLog: [{ habitId: 'h1', date: TODAY }],
    });
    mount(<Probe today={TODAY} />);
    expect(mocks.dispatch).not.toHaveBeenCalled();

    mount(<Probe today="2026-10-25" />);
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch.mock.calls[0]?.[0]).toMatchObject({ date: '2026-10-25' });
  });
});

describe('useWeeklyAutoReport', () => {
  function Probe({ today }: { today: string }) {
    useWeeklyAutoReport(today);
    return null;
  }

  const lastWeekFocus = [focusRow('f1', '2026-10-14', 60)];

  it('开关关着 → 什么都不做（连统计都不算）', () => {
    mocks.state = stateWith(
      { weeklyAutoReport: false },
      { focusSessions: lastWeekFocus },
    );
    mount(<Probe today={TODAY} />);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('上一周有数据 → 写日记 + 记流水，落在上一周最后一天', () => {
    mocks.state = stateWith({ weeklyAutoReport: true }, { focusSessions: lastWeekFocus });
    mount(<Probe today={TODAY} />);

    expect(mocks.dispatch).toHaveBeenCalledTimes(2);
    expect(mocks.dispatch.mock.calls[0]?.[0]).toMatchObject({
      type: 'DIARY_UPSERT',
      date: '2026-10-18',
    });
    expect(mocks.dispatch.mock.calls[1]?.[0]).toEqual({
      type: 'WEEKLY_REPORT_LOG_ADD',
      startKey: '2026-10-12',
    });
  });

  it('目标日已经有别的日记 → 合并进去，不覆盖用户写的字', () => {
    mocks.state = stateWith(
      { weeklyAutoReport: true },
      {
        focusSessions: lastWeekFocus,
        diary: [{ date: '2026-10-18', content: '今天和同学聊了很久', updatedAt: NOW }],
      },
    );
    mount(<Probe today={TODAY} />);

    const upsert = mocks.dispatch.mock.calls[0]?.[0] as {
      type: string;
      content: string;
    };
    expect(upsert.type).toBe('DIARY_UPSERT');
    expect(upsert.content).toContain('今天和同学聊了很久');
    expect(upsert.content).toContain(TEXT.weeklyMarker);
  });

  it('这一周已经处理过 → 不写（流水先挡住，连统计都不算）', () => {
    mocks.state = stateWith(
      { weeklyAutoReport: true, weeklyReportLog: ['2026-10-12'] },
      { focusSessions: lastWeekFocus },
    );
    mount(<Probe today={TODAY} />);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('目标日已经有周报 → 只记流水（不重复写，也不每次启动重新检查）', () => {
    mocks.state = stateWith(
      { weeklyAutoReport: true },
      {
        focusSessions: lastWeekFocus,
        diary: [
          {
            date: '2026-10-18',
            content: `${TEXT.weeklyMarker} · 10月12日–10月18日`,
            updatedAt: NOW,
          },
        ],
      },
    );
    mount(<Probe today={TODAY} />);

    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch.mock.calls[0]?.[0]).toEqual({
      type: 'WEEKLY_REPORT_LOG_ADD',
      startKey: '2026-10-12',
    });
  });

  it('上一周是空周 → 不写，也**不**记流水（以后同步进来数据还能补上）', () => {
    mocks.state = stateWith({ weeklyAutoReport: true }, { tasks: [taskRow('t1', '2026-10-14', false)] });
    mount(<Probe today={TODAY} />);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('只有本周的数据 → 不写（只结上一周，不在周中宣布本周的成绩）', () => {
    mocks.state = stateWith(
      { weeklyAutoReport: true },
      { focusSessions: [focusRow('f1', '2026-10-22', 300)] },
    );
    mount(<Probe today={TODAY} />);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
});
