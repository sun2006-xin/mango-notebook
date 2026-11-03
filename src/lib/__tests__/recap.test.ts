import { describe, expect, it } from 'vitest';
import {
  buildDailyRecap,
  hasTrend,
  recapDate,
  recapLines,
  recapTrend,
  shouldShowRecap,
  todayOutlook,
} from '../recap';
import { createEmptyState, reducer } from '../../store/reducer';
import type { DateKey, FocusSession, Habit, Task } from '../../types';

/* ============================================================================
   每日收尾卡（F15-A）

   这张卡是**派生**的：不新增"打卡"动作，只把已有的任务 / 专注 / 习惯
   在正确的时间点摆出来。所以用例的重点全在"什么该说、什么不该说"。
   ========================================================================= */

const TODAY = '2026-10-30' as DateKey;
const YESTERDAY = '2026-10-29' as DateKey;
const NOWI = '2026-10-29T09:00:00.000Z';

function task(date: DateKey, done: boolean, id = `t_${date}_${done}`): Task {
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
    doneAt: done ? NOWI : null,
    createdAt: NOWI,
    updatedAt: NOWI,
    parentId: null,
    estimatedMinutes: 0,
  };
}

function session(date: DateKey, minutes: number): FocusSession {
  const started = new Date(`${date}T09:00:00.000Z`).getTime();
  return {
    id: `s_${date}_${minutes}`,
    taskId: null,
    date,
    startedAt: new Date(started).toISOString(),
    endedAt: new Date(started + minutes * 60000).toISOString(),
    category: '学习',
  } as FocusSession;
}

function habit(id: string, archivedAt: string | null = null): Habit {
  return { id, name: id, createdAt: NOWI, archivedAt };
}

const EMPTY_ARGS = {
  tasks: [] as Task[],
  focusSessions: [] as FocusSession[],
  habits: [] as Habit[],
  habitChecks: [],
  date: YESTERDAY,
  today: TODAY,
};

describe('recapDate', () => {
  it('就是昨天；跨月跨年交给 addDays', () => {
    expect(recapDate(TODAY)).toBe(YESTERDAY);
    expect(recapDate('2026-11-01' as DateKey)).toBe('2026-10-31');
    expect(recapDate('2027-01-01' as DateKey)).toBe('2026-12-31');
  });
});

describe('buildDailyRecap', () => {
  it('昨天三样全空 → hasContent=false（UI 靠它决定整块不渲染）', () => {
    const recap = buildDailyRecap(EMPTY_ARGS);
    expect(recap.hasContent).toBe(false);
    expect(recapLines(recap)).toEqual([]);
  });

  it('昨天的任务完成数 / 专注 / 习惯分别统计', () => {
    const recap = buildDailyRecap({
      ...EMPTY_ARGS,
      tasks: [task(YESTERDAY, true, 'a'), task(YESTERDAY, false, 'b')],
      focusSessions: [session(YESTERDAY, 90)],
      habits: [habit('h1'), habit('h2')],
      habitChecks: [{ habitId: 'h1', date: YESTERDAY }],
    });
    expect(recap.tasks).toEqual({ total: 2, done: 1 });
    expect(recap.focusMs).toBe(90 * 60000);
    expect(recap.habits).toEqual({ done: 1, total: 2 });
    expect(recap.hasContent).toBe(true);
    expect(recapLines(recap)).toEqual(['完成 1 / 2 项 · 专注 1小时30分钟 · 习惯 1 / 2']);
  });

  it('只算了昨天：今天的任务不进回顾', () => {
    const recap = buildDailyRecap({
      ...EMPTY_ARGS,
      tasks: [task(TODAY, true, 'x'), task(TODAY, false, 'y')],
    });
    expect(recap.tasks.total).toBe(0);
    expect(recap.today).toEqual({ open: 1, overdue: 0 });
  });

  it('逾期任务算进今天的承接，不算进昨天的完成', () => {
    const recap = buildDailyRecap({
      ...EMPTY_ARGS,
      tasks: [task('2026-10-25' as DateKey, false, 'old'), task(TODAY, false, 'now')],
    });
    expect(recap.tasks.total).toBe(0);
    expect(recap.today).toEqual({ open: 1, overdue: 1 });
    expect(todayOutlook(recap)).toBe('今天 1 项待办 · 1 项逾期');
  });

  it('归档的习惯不算进分母', () => {
    const recap = buildDailyRecap({
      ...EMPTY_ARGS,
      habits: [habit('h1'), habit('h2', NOWI)],
      habitChecks: [{ habitId: 'h2', date: YESTERDAY }],
    });
    expect(recap.habits).toEqual({ done: 0, total: 1 });
  });

  it('脏数据不抛（null 数组 / 缺字段）', () => {
    expect(() =>
      buildDailyRecap({
        ...EMPTY_ARGS,
        tasks: null as unknown as Task[],
        focusSessions: null as unknown as FocusSession[],
      }),
    ).not.toThrow();
  });
});

describe('recapLines / todayOutlook（文案克制）', () => {
  it('没有任务就不提"完成 0 / 0 项"', () => {
    const recap = buildDailyRecap({ ...EMPTY_ARGS, focusSessions: [session(YESTERDAY, 30)] });
    expect(recapLines(recap)).toEqual(['专注 30分钟']);
  });

  it('一个习惯都没打时**不提**习惯（避免"习惯 0/3"的挫败感）', () => {
    const recap = buildDailyRecap({
      ...EMPTY_ARGS,
      tasks: [task(YESTERDAY, true, 'a')],
      habits: [habit('h1')],
    });
    expect(recapLines(recap)).toEqual(['完成 1 / 1 项']);
  });

  it('今天没安排 → 给一句轻的，不留空', () => {
    expect(todayOutlook(buildDailyRecap(EMPTY_ARGS))).toBe('今天还没安排任务');
  });

  it('不评价、不打分（不出现"很棒""加油"这类词）', () => {
    const recap = buildDailyRecap({
      ...EMPTY_ARGS,
      tasks: [task(YESTERDAY, true, 'a')],
      focusSessions: [session(YESTERDAY, 60)],
    });
    const text = [...recapLines(recap), todayOutlook(recap)].join(' ');
    expect(text).not.toMatch(/棒|加油|厉|优秀|失败|可惜/);
  });
});

describe('SET_RECAP_SEEN', () => {
  it('记下"被回顾的那一天"，而不是今天', () => {
    const s0 = createEmptyState();
    const s1 = reducer(s0, { type: 'SET_RECAP_SEEN', date: YESTERDAY });
    expect(s1.settings.lastRecapSeen).toBe(YESTERDAY);
  });

  it('幂等：同一天再看一次不产生新 state', () => {
    const s0 = reducer(createEmptyState(), { type: 'SET_RECAP_SEEN', date: YESTERDAY });
    expect(reducer(s0, { type: 'SET_RECAP_SEEN', date: YESTERDAY })).toBe(s0);
  });

  it('空日期不动', () => {
    const s0 = createEmptyState();
    expect(reducer(s0, { type: 'SET_RECAP_SEEN', date: '' as DateKey })).toBe(s0);
  });
});

describe('shouldShowRecap（唯一的时机判据）', () => {
  const withContent = () =>
    buildDailyRecap({ ...EMPTY_ARGS, tasks: [task(YESTERDAY, true, 'a')] });

  it('没看过 + 有内容 → 显示', () => {
    expect(shouldShowRecap(withContent(), null)).toBe(true);
  });

  it('已经看过这一天 → 不显示（否则每次刷新都弹一遍）', () => {
    expect(shouldShowRecap(withContent(), YESTERDAY)).toBe(false);
  });

  it('跨天后自然重新出现：lastSeen 是昨天，而新回顾的是今天', () => {
    // 第二天：回顾的对象变成"今天"，而那天也有内容
    const nextDay = buildDailyRecap({
      ...EMPTY_ARGS,
      today: '2026-10-31' as DateKey,
      date: TODAY,
      tasks: [task(TODAY, true, 'b')],
    });
    expect(shouldShowRecap(nextDay, YESTERDAY)).toBe(true);
  });

  it('三样全空 → 不显示（"完成 0/0 项"只是提醒人失败）', () => {
    expect(shouldShowRecap(buildDailyRecap(EMPTY_ARGS), null)).toBe(false);
  });
});

/* ============================================================================
   最近 7 天趋势（v0.26）

   两个刻意的取舍，各自对应一个用例：
   ① 没安排任务的那天是**空槽**，不是 0% 的柱子 —— 那天本来就没要求做什么；
   ② 全窗不足两天有任务时**不画** —— 一条全空槽的图既没信息又占地方。
   ========================================================================= */

describe('recapTrend：完成率序列', () => {
  it('长度与顺序：以 endDate 结尾、时间正序', () => {
    const points = recapTrend([], YESTERDAY, 7);
    expect(points).toHaveLength(7);
    expect(points[6]!.date).toBe(YESTERDAY);
    expect(points[0]!.date).toBe('2026-10-23');
  });

  it('完成率算得对：那天 3 项完成 2 项 → 2/3', () => {
    const tasks = [
      task('2026-10-28' as DateKey, true, 'a'),
      task('2026-10-28' as DateKey, true, 'b'),
      task('2026-10-28' as DateKey, false, 'c'),
    ];
    const point = recapTrend(tasks, YESTERDAY, 7).find((item) => item.date === '2026-10-28');
    expect(point).toMatchObject({ done: 2, total: 3 });
    expect(point!.ratio).toBeCloseTo(2 / 3, 5);
  });

  it('没安排任务的那天是空槽：total=0、ratio=0（不是"完成 0%"）', () => {
    const point = recapTrend([], YESTERDAY, 3)[0]!;
    expect(point.total).toBe(0);
    expect(point.ratio).toBe(0);
  });

  it('days 夹在 1–14：0/负数/NaN 都不至于画出空图或超长图', () => {
    expect(recapTrend([], YESTERDAY, 0)).toHaveLength(1);
    expect(recapTrend([], YESTERDAY, -5)).toHaveLength(1);
    expect(recapTrend([], YESTERDAY, 99)).toHaveLength(14);
    expect(recapTrend([], YESTERDAY, Number.NaN)).toHaveLength(7);
  });

  it('跨月跨年交给 addDays：序列不出现 DateKey 破格', () => {
    const points = recapTrend([], '2026-01-02' as DateKey, 7);
    expect(points.map((point) => point.date)).toEqual([
      '2025-12-27',
      '2025-12-28',
      '2025-12-29',
      '2025-12-30',
      '2025-12-31',
      '2026-01-01',
      '2026-01-02',
    ]);
  });

  it('脏入参不炸：tasks 不是数组时当空处理', () => {
    expect(() => recapTrend(null as never, YESTERDAY, 7)).not.toThrow();
    expect(recapTrend(null as never, YESTERDAY, 7)).toHaveLength(7);
  });
});

describe('hasTrend：什么时候值得画', () => {
  it('只有一天有任务 → 不画', () => {
    const tasks = [task('2026-10-29' as DateKey, true, 'a')];
    expect(hasTrend(recapTrend(tasks, YESTERDAY, 7))).toBe(false);
  });

  it('两天及以上有任务 → 画', () => {
    const tasks = [
      task('2026-10-29' as DateKey, true, 'a'),
      task('2026-10-28' as DateKey, false, 'b'),
    ];
    expect(hasTrend(recapTrend(tasks, YESTERDAY, 7))).toBe(true);
  });

  it('完成与否不影响判定（有安排就算，0 完成也是一条信息）', () => {
    const tasks = [
      task('2026-10-29' as DateKey, false, 'a'),
      task('2026-10-28' as DateKey, false, 'b'),
    ];
    expect(hasTrend(recapTrend(tasks, YESTERDAY, 7))).toBe(true);
  });
});
