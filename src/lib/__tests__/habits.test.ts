import { describe, expect, it } from 'vitest';
import {
  HABIT_NAME_MAX,
  HABIT_TASK_LOG_KEEP_MAX,
  activeHabits,
  checkedHabitIds,
  dueHabitTasks,
  habitCheckKey,
  habitCalendar,
  habitDayProgress,
  habitMonthCount,
  habitStreak,
  habitStreakMap,
  habitSummaryMap,
  mergeHabitChecks,
  mergeHabitTaskLog,
  mergeHabits,
  normalizeHabitName,
  sanitizeHabitTaskLog,
  toggleHabitCheck,
} from '../habits';
import { sanitizeHabitChecks, sanitizeHabits } from '../sanitize';
import { addDays } from '../date';
import { createEmptyState, reducer } from '../../store/reducer';
import { SCHEMA_VERSION, createDefaultSettings } from '../../constants';
import { mergeSnapshots } from '../merge';
import type { AppState, DateKey, Habit, HabitCheck, PersistedPayload } from '../../types';

/* ============================================================================
   习惯打卡（F12）
   ========================================================================= */

const TODAY = '2026-10-30' as DateKey;
const NOW = '2026-10-30T09:00:00.000Z';

function habit(id: string, name = id, archivedAt: string | null = null): Habit {
  return { id, name, createdAt: NOW, archivedAt };
}

function check(habitId: string, date: DateKey): HabitCheck {
  return { habitId, date };
}

describe('normalizeHabitName', () => {
  it('trim + 截断；非字符串 → 空串（调用方据此拒绝）', () => {
    expect(normalizeHabitName('  背单词 ')).toBe('背单词');
    expect(normalizeHabitName('x'.repeat(HABIT_NAME_MAX + 10))).toHaveLength(HABIT_NAME_MAX);
    expect(normalizeHabitName(undefined)).toBe('');
    expect(normalizeHabitName(42)).toBe('');
  });
});

describe('activeHabits', () => {
  it('只留未归档的，保持原顺序', () => {
    const list = [habit('a'), habit('b', 'b', NOW), habit('c')];
    expect(activeHabits(list).map((h) => h.id)).toEqual(['a', 'c']);
  });

  it('脏数据不抛', () => {
    expect(activeHabits(null as unknown as Habit[])).toEqual([]);
    expect(activeHabits([null as unknown as Habit, habit('a')]).map((h) => h.id)).toEqual(['a']);
  });
});

describe('toggleHabitCheck', () => {
  it('没打过 → 追加；再点一次 → 撤回', () => {
    const once = toggleHabitCheck([], 'a', TODAY);
    expect(once).toEqual([check('a', TODAY)]);
    expect(toggleHabitCheck(once, 'a', TODAY)).toEqual([]);
  });

  it('幂等：同 (habitId, date) 不会出现两条', () => {
    const dirty = [check('a', TODAY), check('a', TODAY)];
    const next = toggleHabitCheck(dirty, 'a', TODAY);
    expect(next).toEqual([]);
  });

  it('只动指定的那一天，别的日子不受影响', () => {
    const list = [check('a', '2026-10-29' as DateKey), check('b', TODAY)];
    const next = toggleHabitCheck(list, 'a', TODAY);
    expect(next).toEqual([
      check('a', '2026-10-29' as DateKey),
      check('b', TODAY),
      check('a', TODAY),
    ]);
  });

  it('空 habitId / 空日期拒绝写入', () => {
    const list = [check('a', TODAY)];
    expect(toggleHabitCheck(list, '', TODAY)).toBe(list);
    expect(toggleHabitCheck(list, 'a', '' as DateKey)).toBe(list);
  });
});

describe('habitStreak', () => {
  it('今天已打卡 → 含今天往前数', () => {
    const checks = [
      check('a', '2026-10-30' as DateKey),
      check('a', '2026-10-29' as DateKey),
      check('a', '2026-10-28' as DateKey),
    ];
    expect(habitStreak(checks, 'a', TODAY)).toBe(3);
  });

  it('今天还没打卡 → 从昨天起算（零点一过不该直接归零）', () => {
    const checks = [check('a', '2026-10-29' as DateKey), check('a', '2026-10-28' as DateKey)];
    expect(habitStreak(checks, 'a', TODAY)).toBe(2);
  });

  it('中间断了一天 → 只数到断点', () => {
    const checks = [
      check('a', '2026-10-30' as DateKey),
      check('a', '2026-10-29' as DateKey),
      // 28 缺
      check('a', '2026-10-27' as DateKey),
    ];
    expect(habitStreak(checks, 'a', TODAY)).toBe(2);
  });

  it('别的习惯的记录不算进来', () => {
    expect(habitStreak([check('b', TODAY)], 'a', TODAY)).toBe(0);
  });
});

describe('habitDayProgress / checkedHabitIds', () => {
  it('只统计在用的习惯（归档的不计入分母）', () => {
    const habits = [habit('a'), habit('b'), habit('c', 'c', NOW)];
    const checks = [check('a', TODAY), check('c', TODAY)];
    expect(habitDayProgress(habits, checks, TODAY)).toEqual({ done: 1, total: 2 });
  });

  it('checkedHabitIds 只返回当天的', () => {
    const checks = [check('a', TODAY), check('b', '2026-10-29' as DateKey)];
    expect([...checkedHabitIds(checks, TODAY)]).toEqual(['a']);
  });
});

describe('合并（多设备）', () => {
  it('习惯按 id 取并集，改名以较新一方（base）为准', () => {
    const base = [habit('a', '背单词')];
    const other = [habit('a', '背英语'), habit('b', '跑步')];
    expect(mergeHabits(base, other).map((h) => `${h.id}:${h.name}`)).toEqual([
      'a:背单词',
      'b:跑步',
    ]);
  });

  it('打卡按 habitId+date 取并集，去重', () => {
    const base = [check('a', TODAY)];
    const other = [check('a', TODAY), check('b', TODAY)];
    expect(mergeHabitChecks(base, other)).toEqual([check('a', TODAY), check('b', TODAY)]);
  });

  it('脏数据（缺 id / 缺日期）被丢掉，不抛', () => {
    const dirty = [
      { habitId: '', date: TODAY },
      { habitId: 'a', date: '' },
      null,
    ] as unknown as HabitCheck[];
    expect(mergeHabitChecks([], dirty)).toEqual([]);
  });

  it('只增不改：并集里不会因为对方没有而消失', () => {
    const base = [check('a', '2026-10-01' as DateKey)];
    const other: HabitCheck[] = [];
    expect(mergeHabitChecks(base, other)).toEqual(base);
  });
});

describe('sanitizeHabits / sanitizeHabitChecks', () => {
  it('丢掉无名 / 无 id / 重复 id 的项', () => {
    const list = sanitizeHabits([
      { id: 'a', name: '背单词' },
      { id: 'a', name: '重复' },
      { id: '', name: '无 id' },
      { id: 'b', name: '   ' },
      { id: 'c', name: '跑步', archivedAt: NOW },
    ]);
    expect(list.map((h) => `${h.id}:${h.name}:${h.archivedAt === null ? '-' : 'archived'}`)).toEqual([
      'a:背单词:-',
      'c:跑步:archived',
    ]);
  });

  it('孤儿打卡（习惯已不存在）被丢掉', () => {
    const habits = sanitizeHabits([{ id: 'a', name: '背单词' }]);
    const checks = sanitizeHabitChecks(
      [
        { habitId: 'a', date: TODAY },
        { habitId: 'gone', date: TODAY },
        { habitId: 'a', date: '不是日期' },
        { habitId: 'a', date: TODAY },
      ],
      habits,
    );
    expect(checks).toEqual([check('a', TODAY)]);
  });

  it('归档的习惯仍然保留它的打卡（历史不能因为归档而丢）', () => {
    const habits = sanitizeHabits([{ id: 'a', name: '背单词', archivedAt: NOW }]);
    expect(sanitizeHabitChecks([{ habitId: 'a', date: TODAY }], habits)).toEqual([check('a', TODAY)]);
  });
});

describe('reducer：SET_HABITS / HABIT_TOGGLE_CHECK', () => {
  function state(): AppState {
    return createEmptyState();
  }

  it('删掉习惯会连带清掉它的打卡（否则孤儿记录永远删不干净）', () => {
    const s0 = reducer(state(), {
      type: 'SET_HABITS',
      habits: [habit('a'), habit('b')],
    });
    const s1 = reducer(s0, { type: 'HABIT_TOGGLE_CHECK', habitId: 'a', date: TODAY });
    const s2 = reducer(s1, { type: 'HABIT_TOGGLE_CHECK', habitId: 'b', date: TODAY });
    expect(s2.settings.habitChecks).toHaveLength(2);

    const s3 = reducer(s2, { type: 'SET_HABITS', habits: [habit('a')] });
    expect(s3.settings.habits.map((h) => h.id)).toEqual(['a']);
    expect(s3.settings.habitChecks).toEqual([check('a', TODAY)]);
  });

  it('内容没变 → 返回同一个 state（settings 会触发写盘 + 云推送）', () => {
    const s0 = reducer(state(), { type: 'SET_HABITS', habits: [habit('a')] });
    const s1 = reducer(s0, { type: 'SET_HABITS', habits: [habit('a')] });
    expect(s1).toBe(s0);
  });

  it('给不存在的习惯打卡 → 不动（孤儿打卡是纯垃圾）', () => {
    const s0 = reducer(state(), { type: 'SET_HABITS', habits: [habit('a')] });
    const s1 = reducer(s0, { type: 'HABIT_TOGGLE_CHECK', habitId: 'nope', date: TODAY });
    expect(s1).toBe(s0);
  });

  it('打卡切换只动 habitChecks，不碰 habits', () => {
    const s0 = reducer(state(), { type: 'SET_HABITS', habits: [habit('a')] });
    const s1 = reducer(s0, { type: 'HABIT_TOGGLE_CHECK', habitId: 'a', date: TODAY });
    expect(s1.settings.habits).toBe(s0.settings.habits);
    expect(s1.settings.habitChecks).toEqual([check('a', TODAY)]);
  });

  it('归档的习惯仍然允许补记/撤回（历史补录是合理需求）', () => {
    const s0 = reducer(state(), { type: 'SET_HABITS', habits: [habit('a', 'a', NOW)] });
    const s1 = reducer(s0, { type: 'HABIT_TOGGLE_CHECK', habitId: 'a', date: TODAY });
    expect(s1.settings.habitChecks).toEqual([check('a', TODAY)]);
  });
});

describe('habitCheckKey', () => {
  it('habitId + date 拼成唯一键', () => {
    expect(habitCheckKey('a', TODAY)).toBe(`a|${TODAY}`);
  });
});

describe('云合并：习惯打卡不能被整包覆盖', () => {
  /** 只造合并需要的最小载荷（其余集合留空） */
  function payload(
    savedAt: string,
    habits: Habit[],
    habitChecks: HabitCheck[],
  ): PersistedPayload {
    return {
      schemaVersion: SCHEMA_VERSION,
      savedAt,
      tasks: [],
      settings: { ...createDefaultSettings('2026-10-30'), habits, habitChecks },
      diary: [],
      tombstones: [],
      focusSessions: [],
      notes: [],
    };
  }

  it('本机更新的情况下，对方那天打的卡仍然并进来（否则连续天数会掉）', () => {
    const local = payload('2026-10-30T10:00:00.000Z', [habit('a')], [check('a', '2026-10-30' as DateKey)]);
    // 远端更旧，但它在 29 号打过卡
    const remote = payload('2026-10-29T10:00:00.000Z', [habit('a')], [check('a', '2026-10-29' as DateKey)]);

    const merged = mergeSnapshots(local, remote);
    expect(merged.settings.habitChecks).toEqual(
      expect.arrayContaining([check('a', '2026-10-30' as DateKey), check('a', '2026-10-29' as DateKey)]),
    );
  });

  it('对方新建的习惯也会并进来（不只是打卡）', () => {
    const local = payload('2026-10-30T10:00:00.000Z', [habit('a')], []);
    const remote = payload('2026-10-29T10:00:00.000Z', [habit('b', '跑步')], []);
    expect(mergeSnapshots(local, remote).settings.habits.map((h) => h.id).sort()).toEqual(['a', 'b']);
  });

  it('老客户端（载荷里没有 habits 字段）不会把本机的习惯清掉', () => {
    const local = payload('2026-10-30T10:00:00.000Z', [habit('a')], [check('a', '2026-10-30' as DateKey)]);
    const legacy = payload('2026-10-29T10:00:00.000Z', [], []);
    // 模拟旧版载荷：settings 里压根没有这两个键
    const stripped = {
      ...legacy,
      settings: (({ habits: _h, habitChecks: _c, ...rest }) => rest)(
        legacy.settings as unknown as Record<string, unknown>,
      ) as unknown as PersistedPayload['settings'],
    };
    const merged = mergeSnapshots(local, stripped);
    expect(merged.settings.habits.map((h) => h.id)).toEqual(['a']);
    expect(merged.settings.habitChecks).toHaveLength(1);
  });
});

/* ============================================================================
   F15-B 习惯日历：看得见"漏在哪天"
   ========================================================================= */
describe('habitCalendar', () => {
  // 注意：helper 的第二参是 name，第三参才是 archivedAt
  const HABITS = [habit('h1'), habit('h2'), habit('h3', 'h3', NOW)];

  function build(checks: HabitCheck[]) {
    return habitCalendar({
      habits: HABITS,
      checks,
      year: 2026,
      month0: 9, // 2026-10
      weekStart: 1,
      today: TODAY,
    });
  }

  it('固定 42 格，且 inMonth 只标当月', () => {
    const days = build([]);
    expect(days).toHaveLength(42);
    expect(days.filter((d) => d.inMonth)).toHaveLength(31);
  });

  it('分母只算在用的习惯（归档的不计入）', () => {
    const days = build([]);
    expect(days[0]?.total).toBe(2);
  });

  it('每天几个打卡 → done / ratio', () => {
    const days = build([
      { habitId: 'h1', date: '2026-10-05' as DateKey },
      { habitId: 'h2', date: '2026-10-05' as DateKey },
    ]);
    const day5 = days.find((d) => d.date === '2026-10-05');
    expect(day5?.done).toBe(2);
    expect(day5?.ratio).toBe(1);
    const day6 = days.find((d) => d.date === '2026-10-06');
    expect(day6?.done).toBe(0);
    expect(day6?.ratio).toBe(0);
  });

  it('归档习惯的打卡不计入（孤儿记录不该把日历染深）', () => {
    const days = build([{ habitId: 'h3', date: '2026-10-07' as DateKey }]);
    expect(days.find((d) => d.date === '2026-10-07')?.done).toBe(0);
  });

  it('没有习惯时 total=0 且 ratio=0（不会除以 0 得到 Infinity）', () => {
    const days = habitCalendar({
      habits: [],
      checks: [],
      year: 2026,
      month0: 9,
      weekStart: 1,
      today: TODAY,
    });
    expect(days[0]?.total).toBe(0);
    expect(days[0]?.ratio).toBe(0);
  });
});

describe('habitMonthCount', () => {
  it('只数这个习惯这个月的次数', () => {
    const checks = [
      { habitId: 'h1', date: '2026-10-01' as DateKey },
      { habitId: 'h1', date: '2026-10-31' as DateKey },
      { habitId: 'h1', date: '2026-09-30' as DateKey }, // 上月
      { habitId: 'h2', date: '2026-10-01' as DateKey }, // 别的习惯
    ];
    expect(habitMonthCount(checks, 'h1', 2026, 9)).toBe(2);
  });

  it('空数据 → 0', () => {
    expect(habitMonthCount([], 'h1', 2026, 9)).toBe(0);
  });
});

/* ============================================================================
   习惯 → 今日任务（长期迭代「习惯与任务联动」）
   ----------------------------------------------------------------------------
   这里守的是"**一天只派一次**"这条唯一的防线。
   一旦漏了，症状不是报错，而是用户每天打开应用看到两条一模一样的
   「背单词」—— 删掉一条，下次打开又补一条，且分不清哪条是哪条。
   `habitTaskLog` 就是为此存在的；它与 `habitChecks` 形状相同但语义相反
   （"派过" vs "做过"），合成一张表会让打卡一次就再也不生成任务。
   ========================================================================= */

describe('dueHabitTasks', () => {
  const auto = (id: string, name = id): Habit => ({
    ...habit(id, name),
    autoTask: true,
  });

  it('只返回开了开关的习惯', () => {
    const due = dueHabitTasks({
      habits: [auto('a', '背单词'), habit('b', '跑步')],
      habitTaskLog: [],
      date: TODAY,
    });
    expect(due).toEqual([{ habitId: 'a', title: '背单词' }]);
  });

  it('已经派过的（流水里有 habitId|date）不再返回', () => {
    const due = dueHabitTasks({
      habits: [auto('a')],
      habitTaskLog: [{ habitId: 'a', date: TODAY }],
      date: TODAY,
    });
    expect(due).toEqual([]);
  });

  it('流水里是**别的日期** → 今天照常派（跨天后要重新生成）', () => {
    const due = dueHabitTasks({
      habits: [auto('a')],
      habitTaskLog: [{ habitId: 'a', date: '2026-10-29' as DateKey }],
      date: TODAY,
    });
    expect(due).toHaveLength(1);
  });

  it('归档的习惯不派（归档 = 从今日页消失）', () => {
    const due = dueHabitTasks({
      habits: [{ ...auto('a'), archivedAt: NOW }],
      habitTaskLog: [],
      date: TODAY,
    });
    expect(due).toEqual([]);
  });

  it('打卡过不影响派任务（"做过"与"派过"是两件事）', () => {
    const due = dueHabitTasks({
      habits: [auto('a')],
      habitTaskLog: [],
      date: TODAY,
    });
    expect(due).toHaveLength(1);
  });

  it('脏输入不抛（缺数组 / 缺日期）', () => {
    const bad = { habits: null, habitTaskLog: undefined, date: '' } as unknown as Parameters<
      typeof dueHabitTasks
    >[0];
    expect(dueHabitTasks(bad)).toEqual([]);
  });
});

describe('sanitizeHabitTaskLog', () => {
  it('丢掉孤儿记录（习惯已被删除）', () => {
    const log = sanitizeHabitTaskLog(
      [
        { habitId: 'a', date: TODAY },
        { habitId: 'ghost', date: TODAY },
      ],
      [habit('a')],
    );
    expect(log).toEqual([{ habitId: 'a', date: TODAY }]);
  });

  it('同 key 去重 + 按日期升序', () => {
    const log = sanitizeHabitTaskLog(
      [
        { habitId: 'a', date: '2026-10-30' },
        { habitId: 'a', date: '2026-10-28' },
        { habitId: 'a', date: '2026-10-30' },
      ],
      [habit('a')],
    );
    expect(log.map((entry) => entry.date)).toEqual(['2026-10-28', '2026-10-30']);
  });

  it('非法日期 / 非法结构一律丢弃', () => {
    const log = sanitizeHabitTaskLog(
      [null, 'x', { habitId: 'a', date: '2026-13-40' }, { habitId: '', date: TODAY }],
      [habit('a')],
    );
    expect(log).toEqual([]);
  });

  it('超量时丢**最旧**的，今天的判定不受影响', () => {
    const habits = [habit('a')];
    const many = Array.from({ length: HABIT_TASK_LOG_KEEP_MAX + 5 }, (_, index) => ({
      habitId: 'a',
      // 从 2020-01-01 起每天一条
      date: addDays('2020-01-01', index),
    }));
    const log = sanitizeHabitTaskLog(many, habits);
    expect(log).toHaveLength(HABIT_TASK_LOG_KEEP_MAX);
    expect(log[0]?.date).toBe(addDays('2020-01-01', 5));
    expect(log[log.length - 1]?.date).toBe(many[many.length - 1]?.date);
  });
});

describe('mergeHabitTaskLog', () => {
  it('两台设备取并集、同 key 去重', () => {
    const merged = mergeHabitTaskLog(
      [{ habitId: 'a', date: TODAY }],
      [
        { habitId: 'a', date: TODAY },
        { habitId: 'b', date: TODAY },
      ],
    );
    expect(merged).toHaveLength(2);
  });

  it('并集之后仍按日期升序（合并结果要满足 sanitize 的口径）', () => {
    const merged = mergeHabitTaskLog(
      [{ habitId: 'a', date: '2026-10-30' }],
      [{ habitId: 'a', date: '2026-10-28' }],
    );
    expect(merged.map((entry) => entry.date)).toEqual(['2026-10-28', '2026-10-30']);
  });
});

/* ============================================================================
   批量统计（v0.29.2 性能修正）：一份索引算全部习惯
   ----------------------------------------------------------------------------
   原来是 `habits.map(h => habitStreak(checks, h.id, today))`，
   每个习惯都把几千条流水 `filter` + `new Set` 一遍 —— 8 个习惯 × 4000 条
   就是每次渲染 3 万多次元素访问，而今日页每勾一次任务都要付一次。
   批量版只扫一遍流水，结果必须与逐个算**完全一致**（这条是重构的安全网）。
   ========================================================================= */
describe('habitStreakMap / habitSummaryMap', () => {
  const checks = [
    { habitId: 'a', date: '2026-10-31' as DateKey },
    { habitId: 'a', date: '2026-10-30' as DateKey },
    { habitId: 'a', date: '2026-10-29' as DateKey },
    { habitId: 'b', date: '2026-10-31' as DateKey },
    { habitId: 'b', date: '2026-10-01' as DateKey },
  ];

  it('批量结果与逐个 habitStreak 完全一致（含"今天没打卡"的回落）', () => {
    const today: DateKey = '2026-10-31';
    const streak = habitStreakMap(checks, today);
    for (const id of ['a', 'b', 'c']) {
      expect(streak.get(id) ?? 0).toBe(habitStreak(checks, id, today));
    }
    expect(streak.get('a')).toBe(3);
    expect(streak.get('b')).toBe(1);
    // 没打过卡的习惯不在 Map 里（调用方 `?? 0`），与逐个算的 0 等价
    expect(streak.get('c') ?? 0).toBe(0);
  });

  it('今天还没打卡 → 从昨天起算（与 havitStreak 同口径）', () => {
    const today: DateKey = '2026-11-01';
    expect(habitStreakMap(checks, today).get('a')).toBe(3);
  });

  it('月份小结：本月天数与连续天数一起给', () => {
    const summary = habitSummaryMap(checks, '2026-10-31', 2026, 9);
    expect(summary.get('a')).toEqual({ monthCount: 3, streak: 3 });
    expect(summary.get('b')).toEqual({ monthCount: 2, streak: 1 });
  });

  it('切到没有记录的月份 → 本月 0 天，连续天数照算（连续跨月不断）', () => {
    const summary = habitSummaryMap(checks, '2026-10-31', 2026, 8);
    expect(summary.get('a')?.monthCount).toBe(0);
    expect(summary.get('a')?.streak).toBe(3);
  });

  it('脏数据不抛：null / 缺字段的记录被跳过', () => {
    const dirty = [null, {}, { habitId: 'a' }, { habitId: 'a', date: '2026-10-31' }];
    expect(() => habitStreakMap(dirty as unknown as HabitCheck[], '2026-10-31')).not.toThrow();
    expect(habitStreakMap(dirty as unknown as HabitCheck[], '2026-10-31').get('a')).toBe(1);
  });
});
