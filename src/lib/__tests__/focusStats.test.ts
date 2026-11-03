import { describe, expect, it } from 'vitest';
import {
  focusMsByCategory,
  focusStatsByTask,
  peakFocusDay,
  peakFocusHour,
} from '../focus';
import type { FocusSession, Task } from '../../types';

/* ============================================================================
   任务 ↔ 专注 / 周报 用的四个聚合函数

   共同的验收点：**脏数据不抛**。focusSessions 会经云同步从别的设备过来
   （老版本、手改过的 JSON），一条 startedAt: 'x' 不该让整页统计崩掉。
   ========================================================================= */

function session(
  id: string,
  startedAt: string,
  endedAt: string,
  taskId: string | null = null,
  date = startedAt.slice(0, 10),
): FocusSession {
  return { id, taskId, date, startedAt, endedAt, durationMs: 0 };
}

const task = (id: string, category: string): Task => ({
  id,
  title: id,
  note: '',
  date: '2026-10-24',
  time: null,
  repeat: 'none',
  priority: 'medium',
  category,
  done: false,
  doneAt: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  parentId: null,
  estimatedMinutes: 0,
});

describe('focusStatsByTask', () => {
  it('按 taskId 聚合次数与总时长，自由专注归 null 键', () => {
    const map = focusStatsByTask([
      session('s1', '2026-10-24T09:00:00.000Z', '2026-10-24T09:25:00.000Z', 't1'),
      session('s2', '2026-10-24T10:00:00.000Z', '2026-10-24T10:10:00.000Z', 't1'),
      session('s3', '2026-10-24T11:00:00.000Z', '2026-10-24T11:30:00.000Z', null),
    ]);
    expect(map.get('t1')).toEqual({ taskId: 't1', count: 2, ms: 35 * 60_000 });
    expect(map.get(null)).toEqual({ taskId: null, count: 1, ms: 30 * 60_000 });
  });

  it('0 毫秒的脏记录不计次数（否则任务行会出现「专注 1 次 · 0 分钟」）', () => {
    const map = focusStatsByTask([
      session('bad', '2026-10-24T09:00:00.000Z', '2026-10-24T09:00:00.000Z', 't1'),
    ]);
    expect(map.get('t1')).toBeUndefined();
  });

  it('空数组 / 非数组不抛', () => {
    expect(focusStatsByTask([]).size).toBe(0);
    expect(focusStatsByTask(null as unknown as FocusSession[]).size).toBe(0);
  });
});

describe('peakFocusDay', () => {
  const sessions = [
    session('a', '2026-10-20T09:00:00.000Z', '2026-10-20T10:00:00.000Z'),
    session('b', '2026-10-21T09:00:00.000Z', '2026-10-21T12:00:00.000Z'),
    session('c', '2026-10-22T09:00:00.000Z', '2026-10-22T09:30:00.000Z'),
  ];

  it('取区间内时长最高的一天', () => {
    expect(peakFocusDay(sessions, '2026-10-19', '2026-10-25')).toEqual({
      date: '2026-10-21',
      ms: 3 * 60 * 60_000,
    });
  });

  it('区间外的高峰不算（周报只看本周）', () => {
    expect(peakFocusDay(sessions, '2026-10-22', '2026-10-25')).toEqual({
      date: '2026-10-22',
      ms: 30 * 60_000,
    });
  });

  it('区间内没有记录 → null（不是 0 分钟的假结论）', () => {
    expect(peakFocusDay(sessions, '2026-11-01', '2026-11-07')).toBeNull();
  });

  it('区间非法 / 脏数据不抛', () => {
    expect(peakFocusDay(sessions, '2026-13-01', '2026-11-07')).toBeNull();
    expect(peakFocusDay(sessions, '2026-11-07', '2026-11-01')).toBeNull();
    expect(peakFocusDay(null as unknown as FocusSession[], '2026-10-19', '2026-10-25')).toBeNull();
  });
});

describe('peakFocusHour', () => {
  it('取开始时间所在小时的时长之和最高者', () => {
    const sessions = [
      session('a', '2026-10-20T21:00:00.000Z', '2026-10-20T21:30:00.000Z'),
      session('b', '2026-10-21T21:15:00.000Z', '2026-10-21T22:15:00.000Z'),
      session('c', '2026-10-22T08:00:00.000Z', '2026-10-22T08:15:00.000Z'),
    ];
    const peak = peakFocusHour(sessions, '2026-10-19', '2026-10-25');
    expect(peak?.hour).toBe(new Date('2026-10-20T21:00:00.000Z').getHours());
    expect(peak?.ms).toBe(90 * 60_000);
  });

  it('没有记录 → null', () => {
    expect(peakFocusHour([], '2026-10-19', '2026-10-25')).toBeNull();
  });
});

describe('focusMsByCategory', () => {
  it('按任务分类聚合；已删任务与自由专注归「未分类」（空串）', () => {
    const tasks = [task('t1', '学习'), task('t2', '工作')];
    const rows = focusMsByCategory(
      [
        session('s1', '2026-10-24T09:00:00.000Z', '2026-10-24T10:00:00.000Z', 't1'),
        session('s2', '2026-10-24T11:00:00.000Z', '2026-10-24T11:30:00.000Z', 't2'),
        session('s3', '2026-10-24T12:00:00.000Z', '2026-10-24T13:00:00.000Z', 'gone'),
        session('s4', '2026-10-24T14:00:00.000Z', '2026-10-24T14:20:00.000Z', null),
      ],
      tasks,
    );
    // 按 ms 降序：未分类（已删任务 60 + 自由专注 20 = 80）> 学习 60 > 工作 30
    expect(rows).toEqual([
      { category: '', ms: 80 * 60_000 },
      { category: '学习', ms: 60 * 60_000 },
      { category: '工作', ms: 30 * 60_000 },
    ]);
  });

  it('空数据不抛', () => {
    expect(focusMsByCategory([], [])).toEqual([]);
    expect(focusMsByCategory(null as unknown as FocusSession[], null as unknown as Task[])).toEqual([]);
  });
});

/* ============================================================================
   v0.12 修正：跨久恢复的专注不能把统计污染成"一整天"
   ========================================================================= */
import { focusEndAt, isAbandonedFocus } from '../focus';

describe('focusEndAt：结束时间必须是开始 + 实际时长', () => {
  it('25 分钟专注 → endedAt - startedAt 正好 25 分钟（不取"现在"）', () => {
    const startedAt = '2026-10-28T06:00:00.000Z';
    const endedAt = focusEndAt(startedAt, 25 * 60_000);
    expect(Date.parse(endedAt) - Date.parse(startedAt)).toBe(25 * 60_000);
  });

  it('负数 / NaN 时长按 0 处理，不产生"结束早于开始"的记录', () => {
    const startedAt = '2026-10-28T06:00:00.000Z';
    expect(Date.parse(focusEndAt(startedAt, -5000))).toBe(Date.parse(startedAt));
    expect(Date.parse(focusEndAt(startedAt, Number.NaN))).toBe(Date.parse(startedAt));
  });

  it('开始时间非法时退回"现在"，绝不抛', () => {
    const out = focusEndAt('不是时间', 60_000);
    expect(Number.isFinite(Date.parse(out))).toBe(true);
  });
});

describe('isAbandonedFocus：忘了结束的幽灵记录', () => {
  it('25 分钟番茄放了 8 小时 → 判为幽灵（不记录）', () => {
    expect(isAbandonedFocus(8 * 3_600_000, 25 * 60_000)).toBe(true);
  });

  it('5 分钟番茄实际跑了 20 分钟 → 正常走神，仍然记录', () => {
    expect(isAbandonedFocus(20 * 60_000, 5 * 60_000)).toBe(false);
  });

  it('只有"超计划 3 倍"或只有"超一小时"都不算幽灵（两道同时满足才算）', () => {
    // 超计划 3 倍（46 > 15×3）但没到一小时 → 不算幽灵
    expect(isAbandonedFocus(46 * 60_000, 15 * 60_000)).toBe(false);
    // 超过一小时但没超计划 3 倍：90 分钟 vs 60 分钟
    expect(isAbandonedFocus(90 * 60_000, 60 * 60_000)).toBe(false);
  });

  it('计划时长非法 → 不判幽灵（宁多记不误杀）', () => {
    expect(isAbandonedFocus(8 * 3_600_000, 0)).toBe(false);
  });
});

/* ============================================================================
   F2：科目维度专注统计
   ========================================================================= */
import { focusByCategory } from '../focus';
import { sanitizeFocusSessions } from '../storage';

function sess(id: string, date: string, minutes: number, category?: string): FocusSession {
  const start = `${date}T06:00:00.000Z`;
  const end = new Date(Date.parse(start) + minutes * 60_000).toISOString();
  return { id, taskId: 't1', date, startedAt: start, endedAt: end, durationMs: minutes * 60_000, ...(category ? { category } : {}) };
}

describe('focusByCategory：按科目聚合', () => {
  it('同一科目累加、按占比降序、ratio 合计为 1', () => {
    const list = [
      sess('1', '2026-10-28', 30, '高数'),
      sess('2', '2026-10-28', 30, '高数'),
      sess('3', '2026-10-28', 40, 'STM32'),
    ];
    const out = focusByCategory(list);
    expect(out[0]).toMatchObject({ category: '高数', ms: 60 * 60_000 });
    expect(out[1]).toMatchObject({ category: 'STM32', ms: 40 * 60_000 });
    expect(out.reduce((sum, item) => sum + item.ratio, 0)).toBeCloseTo(1, 5);
  });

  it('老记录没有 category → 归入未分类，不丢', () => {
    const out = focusByCategory([sess('1', '2026-10-28', 25)]);
    expect(out[0].category).toBe('未分类');
  });

  it('时间区间过滤生效（最近 7 天之外的记录不算）', () => {
    const list = [sess('old', '2026-10-01', 30, '高数'), sess('new', '2026-10-28', 20, '高数')];
    const out = focusByCategory(list, { from: '2026-10-22', to: '2026-10-29' });
    expect(out[0].ms).toBe(20 * 60_000);
  });

  it('空数组 / 脏数据不抛', () => {
    expect(focusByCategory([])).toEqual([]);
    expect(focusByCategory(null as unknown as FocusSession[])).toEqual([]);
  });
});

describe('sanitizeFocusSessions：category 必须活过冷启动', () => {
  it('保留 category', () => {
    const out = sanitizeFocusSessions([
      { id: 'a', taskId: null, date: '2026-10-28', startedAt: '2026-10-28T06:00:00.000Z', endedAt: '2026-10-28T06:25:00.000Z', durationMs: 0, category: '高数' },
    ]);
    expect(out[0].category).toBe('高数');
  });

  it('没有 category 时不凭空造字段', () => {
    const out = sanitizeFocusSessions([
      { id: 'b', taskId: null, date: '2026-10-28', startedAt: '2026-10-28T06:00:00.000Z', endedAt: '2026-10-28T06:25:00.000Z', durationMs: 0 },
    ]);
    expect(out[0]).not.toHaveProperty('category');
  });
});
