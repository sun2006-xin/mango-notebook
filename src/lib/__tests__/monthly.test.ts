import { describe, expect, it } from 'vitest';
import {
  buildMonthlyReport,
  monthComparison,
  monthDateKeys,
  monthKey,
  monthlyHeadline,
} from '../monthly';
import type { DateKey, FocusSession, Task } from '../../types';

/* ============================================================================
   月报（F14）
   口径必须和今日进度 / 热力图 / 周报同源：任务按 `task.date`，专注按 `session.date`。
   ========================================================================= */

const NOWI = '2026-10-30T09:00:00.000Z';

function task(date: DateKey, done: boolean, category = '学习', extra: Partial<Task> = {}): Task {
  return {
    id: `t_${date}_${Math.random().toString(36).slice(2, 8)}`,
    title: 'x',
    note: '',
    date,
    time: null,
    repeat: 'none',
    priority: 'medium',
    category,
    done,
    doneAt: done ? NOWI : null,
    createdAt: NOWI,
    updatedAt: NOWI,
    parentId: null,
    estimatedMinutes: 0,
    ...extra,
  };
}

function session(date: DateKey, minutes: number, id = `s_${date}_${minutes}`): FocusSession {
  const started = new Date(`${date}T09:00:00.000Z`).getTime();
  return {
    id,
    taskId: null,
    date,
    startedAt: new Date(started).toISOString(),
    endedAt: new Date(started + minutes * 60000).toISOString(),
    category: '学习',
  } as FocusSession;
}

describe('monthKey / monthDateKeys', () => {
  it("月份键补零（'2026-01'，不是 '2026-1'）", () => {
    expect(monthKey(2026, 0)).toBe('2026-01');
    expect(monthKey(2026, 9)).toBe('2026-10');
  });

  it('日期键从 1 号到最后一天，闰年 2 月是 29 天', () => {
    expect(monthDateKeys(2026, 9)).toHaveLength(31);
    expect(monthDateKeys(2026, 9)[0]).toBe('2026-10-01');
    expect(monthDateKeys(2026, 9).at(-1)).toBe('2026-10-31');
    expect(monthDateKeys(2024, 1)).toHaveLength(29);
    expect(monthDateKeys(2026, 1)).toHaveLength(28);
  });
});

describe('buildMonthlyReport', () => {
  it('空月份：percent 为 null（不是 0%）、各项为 0、bestDay 为 null', () => {
    const report = buildMonthlyReport([], [], 2026, 9);
    expect(report.tasks).toEqual({ total: 0, done: 0, percent: null });
    expect(report.focus).toEqual({ totalMs: 0, activeDays: 0, averageMs: 0 });
    expect(report.byCategory).toEqual([]);
    expect(report.bestDay).toBeNull();
    expect(report.bestFocusDay).toBeNull();
    expect(report.activeDays).toBe(0);
  });

  it('完成率按当月任务算，上月末 / 下月初的任务不计入', () => {
    const tasks = [
      task('2026-10-01' as DateKey, true),
      task('2026-10-02' as DateKey, false),
      task('2026-09-30' as DateKey, true), // 上月
      task('2026-11-01' as DateKey, false), // 下月
    ];
    const report = buildMonthlyReport(tasks, [], 2026, 9);
    expect(report.tasks).toEqual({ total: 2, done: 1, percent: 50 });
  });

  it('子任务也计入（与今日进度 getDayProgress 同口径）', () => {
    const parent = task('2026-10-05' as DateKey, false, '学习', { id: 'p' });
    const child = task('2026-10-05' as DateKey, true, '学习', { id: 'c', parentId: 'p' });
    expect(buildMonthlyReport([parent, child], [], 2026, 9).tasks.total).toBe(2);
  });

  it('分类分布按完成数降序，计数正确', () => {
    const tasks = [
      task('2026-10-01' as DateKey, true, '高数'),
      task('2026-10-02' as DateKey, true, '高数'),
      task('2026-10-03' as DateKey, false, '高数'),
      task('2026-10-04' as DateKey, true, '英语'),
      task('2026-10-05' as DateKey, false, '英语'),
    ];
    const report = buildMonthlyReport(tasks, [], 2026, 9);
    expect(report.byCategory).toEqual([
      { category: '高数', total: 3, done: 2 },
      { category: '英语', total: 2, done: 1 },
    ]);
  });

  it('专注时长只算当月，日均按"有专注的天数"算（不是自然日）', () => {
    const sessions = [
      session('2026-10-01' as DateKey, 60, 'a'),
      session('2026-10-02' as DateKey, 120, 'b'),
      session('2026-10-02' as DateKey, 60, 'c'),
      session('2026-09-30' as DateKey, 999, 'old'), // 上月
    ];
    const report = buildMonthlyReport([], sessions, 2026, 9);
    expect(report.focus.totalMs).toBe((60 + 120 + 60) * 60000);
    expect(report.focus.activeDays).toBe(2);
    // (60+120+60) / 2 天 = 120 分钟
    expect(report.focus.averageMs).toBe(120 * 60000);
  });

  it('bestDay 取完成数最多的一天，并列取较早的', () => {
    const tasks = [
      task('2026-10-10' as DateKey, true),
      task('2026-10-11' as DateKey, true),
      task('2026-10-11' as DateKey, true),
      task('2026-10-20' as DateKey, true),
      task('2026-10-20' as DateKey, true),
    ];
    const report = buildMonthlyReport(tasks, [], 2026, 9);
    expect(report.bestDay).toEqual({ date: '2026-10-11', done: 2 });
  });

  it('bestFocusDay 取专注最久的一天', () => {
    const sessions = [session('2026-10-03' as DateKey, 30, 'a'), session('2026-10-04' as DateKey, 90, 'b')];
    expect(buildMonthlyReport([], sessions, 2026, 9).bestFocusDay).toEqual({
      date: '2026-10-04',
      ms: 90 * 60000,
    });
  });

  it('activeDays 是"有任务的天数"，不是"有完成的天数"', () => {
    const tasks = [
      task('2026-10-01' as DateKey, false),
      task('2026-10-01' as DateKey, false),
      task('2026-10-02' as DateKey, true),
    ];
    expect(buildMonthlyReport(tasks, [], 2026, 9).activeDays).toBe(2);
  });

  it('脏数据（非数组 / 缺 date）不抛', () => {
    expect(() => buildMonthlyReport(null as unknown as Task[], null as unknown as FocusSession[], 2026, 9)).not.toThrow();
    const broken = [{ id: 'x', title: 'x' }] as unknown as Task[];
    expect(buildMonthlyReport(broken, [], 2026, 9).tasks.total).toBe(0);
  });
});

describe('monthlyHeadline', () => {
  it('空月份只说一句，不评价', () => {
    expect(monthlyHeadline(buildMonthlyReport([], [], 2026, 9))).toEqual(['这个月还没有安排任务']);
  });

  it('有任务时给出完成数 + 百分比；有专注时追加时长与天数', () => {
    const tasks = [task('2026-10-01' as DateKey, true), task('2026-10-02' as DateKey, false)];
    const lines = monthlyHeadline(
      buildMonthlyReport(tasks, [session('2026-10-01' as DateKey, 150, 'a')], 2026, 9),
    );
    expect(lines[0]).toBe('完成 1 / 2 项 · 50%');
    expect(lines[1]).toBe('专注 2 小时 30 分钟 · 有 1 天在学');
  });

  it('没有专注记录就不追加第二句（不写"专注 0 分钟"）', () => {
    const lines = monthlyHeadline(buildMonthlyReport([task('2026-10-01' as DateKey, true)], [], 2026, 9));
    expect(lines).toHaveLength(1);
  });
});

/* ============================================================================
   F17 环比：和上个月比
   ========================================================================= */
describe('previous（上月合计）', () => {
  it('上月有数据 → previous 带上四个数', () => {
    const report = buildMonthlyReport(
      [
        task('2026-09-10' as DateKey, true, '学习'),
        task('2026-09-11' as DateKey, false, '学习'),
      ],
      [session('2026-09-10' as DateKey, 60, 'a')],
      2026,
      9, // 10 月
    );
    expect(report.previous).toEqual({
      key: '2026-09',
      done: 1,
      total: 2,
      focusMs: 60 * 60000,
    });
  });

  it('上月完全空白 → previous 为 null（不拿"无"当"零"）', () => {
    const report = buildMonthlyReport([task('2026-10-01' as DateKey, true)], [], 2026, 9);
    expect(report.previous).toBe(null);
  });

  it('跨年：1 月的上一个月是去年 12 月', () => {
    const report = buildMonthlyReport(
      [task('2026-12-05' as DateKey, true)],
      [],
      2027,
      0, // 2027-01
    );
    expect(report.previous?.key).toBe('2026-12');
  });

  it('上个月只有专注、没有任务 → 仍然算有数据（可以比专注）', () => {
    const report = buildMonthlyReport([], [session('2026-09-20' as DateKey, 30, 'a')], 2026, 9);
    expect(report.previous?.total).toBe(0);
    expect(report.previous?.focusMs).toBe(30 * 60000);
  });
});

describe('monthComparison（环比文案）', () => {
  function reportOf(currentMinutes: number, prevMinutes: number, doneNow = 3, donePrev = 3) {
    const tasks = [
      ...Array.from({ length: doneNow }, (_, i) => task('2026-10-05' as DateKey, true, '学习', { id: `c${i}` })),
      ...Array.from({ length: donePrev }, (_, i) => task('2026-09-05' as DateKey, true, '学习', { id: `p${i}` })),
    ];
    const sessions = [
      ...(currentMinutes > 0 ? [session('2026-10-06' as DateKey, currentMinutes, 'cur')] : []),
      ...(prevMinutes > 0 ? [session('2026-09-06' as DateKey, prevMinutes, 'prev')] : []),
    ];
    return buildMonthlyReport(tasks, sessions, 2026, 9);
  }

  it('多学了 → "专注比上月多 4 小时"', () => {
    const comparison = monthComparison(reportOf(360, 120)); // 6h vs 2h
    expect(comparison.focus).toBe('专注比上月多 4小时');
  });

  it('少学了 → "专注比上月少"', () => {
    const comparison = monthComparison(reportOf(120, 360));
    expect(comparison.focus).toBe('专注比上月少 4小时');
  });

  it('差 5 分钟以内算持平（月度合计是小时量级，差 1 分钟是记账误差）', () => {
    expect(monthComparison(reportOf(120, 121)).focus).toBe('专注和上月持平');
    expect(monthComparison(reportOf(120, 124)).focus).toBe('专注和上月持平');
  });

  it('超过 5 分钟才算真的变了', () => {
    expect(monthComparison(reportOf(150, 120)).focus).toBe('专注比上月多 30分钟');
  });

  it('完成数：多 / 少 / 一样', () => {
    expect(monthComparison(reportOf(60, 60, 5, 2)).done).toBe('完成比上月多 3 项');
    expect(monthComparison(reportOf(60, 60, 2, 5)).done).toBe('完成比上月少 3 项');
    expect(monthComparison(reportOf(60, 60, 4, 4)).done).toBe('完成数和上月一样');
  });

  it('上月空白 → 两段都是空串（不硬算百分比）', () => {
    const report = buildMonthlyReport([task('2026-10-01' as DateKey, true)], [], 2026, 9);
    expect(monthComparison(report)).toEqual({ focus: '', done: '' });
  });

  it('不评价、不打分（不出现"进步""加油"这类词）', () => {
    const text = Object.values(monthComparison(reportOf(360, 120))).join(' ');
    expect(text).not.toMatch(/棒|加油|进步|优秀|退步|失败/);
  });
});
