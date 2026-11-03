import { describe, expect, it } from 'vitest';
import { buildCompletionTrend } from '../task';
import { addDays } from '../date';
import type { Task } from '../../types';

/* ============================================================================
   完成率趋势 + 归档
   ========================================================================= */

const TODAY = '2026-10-24';

function task(id: string, date: string, done: boolean): Task {
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
    doneAt: done ? `${date}T12:00:00.000Z` : null,
    createdAt: 'x',
    updatedAt: 'x',
    parentId: null,
    estimatedMinutes: 0,
  };
}

describe('buildCompletionTrend', () => {
  it('长度等于请求的天数，最后一天是今天', () => {
    const trend = buildCompletionTrend([], TODAY, 14);
    expect(trend).toHaveLength(14);
    expect(trend[13]?.date).toBe(TODAY);
    expect(trend[0]?.date).toBe(addDays(TODAY, -13));
  });

  it('没有任务的日子 percent=null（不是 0%，避免把休息日画成全灭）', () => {
    const trend = buildCompletionTrend([], TODAY, 7);
    expect(trend.every((p) => p.percent === null)).toBe(true);
    expect(trend.every((p) => p.total === 0)).toBe(true);
  });

  it('完成率按当日任务算，四舍五入', () => {
    const tasks = [
      task('a', TODAY, true),
      task('b', TODAY, true),
      task('c', TODAY, false),
      task('d', TODAY, false),
    ];
    const trend = buildCompletionTrend(tasks, TODAY, 1);
    expect(trend[0]?.total).toBe(4);
    expect(trend[0]?.done).toBe(2);
    expect(trend[0]?.percent).toBe(50);
  });

  it('跨月回溯日期正确', () => {
    const trend = buildCompletionTrend([], '2026-03-01', 3);
    expect(trend.map((p) => p.date)).toEqual(['2026-02-27', '2026-02-28', '2026-03-01']);
  });

  it('脏数据兜底：tasks 不是数组 → 空趋势，不抛异常', () => {
    expect(buildCompletionTrend(undefined as unknown as Task[], TODAY, 7)).toEqual([]);
    expect(() => buildCompletionTrend('x' as unknown as Task[], TODAY, 7)).not.toThrow();
  });
});
