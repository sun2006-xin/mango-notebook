import { describe, expect, it } from 'vitest';
import {
  buildFocusHeatmap,
  computeFocusStreak,
  dailyFocusMs,
  focusByTask,
  focusDateKey,
  focusMsByDate,
  formatFocusDuration,
  pruneFocusSessions,
  sessionMs,
  sumFocusMs,
  weeklyFocusMs,
} from '../focus';
import type { FocusSession } from '../../types';

/* ============================================================================
   专注统计：所有函数都必须对脏数据免疫
   —— focusSessions 会经云同步从别的设备过来，旧版本的、被改过的都要能扛
   ========================================================================= */

/** 2026-10-26 09:00 本地时间（用本地构造，避免时区把测试拖到下一天） */
function at(day: string, hour: number, minute = 0): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y as number, (m as number) - 1, d as number, hour, minute, 0).toISOString();
}

function session(id: string, day: string, startHour: number, minutes: number, taskId: string | null = 't1'): FocusSession {
  return {
    id,
    taskId,
    date: day,
    startedAt: at(day, startHour),
    endedAt: at(day, startHour, minutes),
    durationMs: minutes * 60000,
  };
}

describe('sessionMs：时长按起止重算，不信 durationMs', () => {
  it('正常记录 = 起止差', () => {
    expect(sessionMs(session('a', '2026-10-26', 9, 25))).toBe(25 * 60000);
  });

  it('durationMs 被篡改成 99 小时也不采信', () => {
    const tampered: FocusSession = {
      ...session('a', '2026-10-26', 9, 25),
      durationMs: 99 * 3600 * 1000,
    };
    expect(sessionMs(tampered)).toBe(25 * 60000);
  });

  it('结束早于开始 / 时间不可解析 / 超过 24 小时 → 一律记 0', () => {
    const backwards: FocusSession = {
      id: 'a', taskId: null, date: '2026-10-26',
      startedAt: at('2026-10-26', 10), endedAt: at('2026-10-26', 9), durationMs: 1,
    };
    expect(sessionMs(backwards)).toBe(0);
    expect(sessionMs({ id: 'b', startedAt: 'x', endedAt: 'y' } as FocusSession)).toBe(0);
    expect(
      sessionMs({
        id: 'c', taskId: null, date: '2026-10-26',
        startedAt: at('2026-10-24', 9), endedAt: at('2026-10-26', 9), durationMs: 1,
      }),
    ).toBe(0);
  });

  it('null / 非对象不抛异常', () => {
    expect(sessionMs(null as unknown as FocusSession)).toBe(0);
    expect(sessionMs('nope' as unknown as FocusSession)).toBe(0);
  });
});

describe('sumFocusMs / dailyFocusMs / weeklyFocusMs', () => {
  const list = [
    session('a', '2026-10-26', 9, 25),
    session('b', '2026-10-26', 10, 30),
    session('c', '2026-10-25', 9, 60),
    session('d', '2026-10-19', 9, 45),
    session('e', '2026-10-18', 9, 15),
  ];

  it('总量 = 每段之和', () => {
    expect(sumFocusMs(list)).toBe((25 + 30 + 60 + 45 + 15) * 60000);
  });

  it('按日聚合', () => {
    expect(dailyFocusMs(list, '2026-10-26')).toBe(55 * 60000);
    expect(dailyFocusMs(list, '2026-10-24')).toBe(0);
  });

  it('按周聚合：只算 [start, start+6]，不多不少', () => {
    // 2026-10-19 是周一 → 该周 = 10-19..10-25，不含 10-26
    expect(weeklyFocusMs(list, '2026-10-19')).toBe((60 + 45) * 60000);
    // 10-26 自己那周只有 10-25 的两段
    expect(weeklyFocusMs(list, '2026-10-26')).toBe((25 + 30) * 60000);
    expect(weeklyFocusMs(list, '2026-10-12')).toBe(15 * 60000);
  });

  it('非数组入参 → 0（云端字段缺失时的兜底）', () => {
    expect(sumFocusMs(undefined as unknown as FocusSession[])).toBe(0);
    expect(focusMsByDate(null as unknown as FocusSession[]).size).toBe(0);
  });
});

describe('focusDateKey：日界换算', () => {
  it('日界 0：凌晨 1 点算当天', () => {
    expect(focusDateKey(at('2026-10-26', 1), 0)).toBe('2026-10-26');
  });

  it('日界 4：凌晨 1 点退到前一天（熬夜党的核心诉求）', () => {
    expect(focusDateKey(at('2026-10-26', 1), 4)).toBe('2026-10-25');
  });

  it('日界 4：早上 8 点仍是当天', () => {
    expect(focusDateKey(at('2026-10-26', 8), 4)).toBe('2026-10-26');
  });

  it('越界日界被夹到 0–6，不产生荒诞结果', () => {
    expect(focusDateKey(at('2026-10-26', 12), 99)).toBe('2026-10-26');
    expect(focusDateKey(at('2026-10-26', 12), -5)).toBe('2026-10-26');
  });

  it('时间戳不可解析也不抛，回落今天', () => {
    expect(typeof focusDateKey('not-a-date', 0)).toBe('string');
  });
});

describe('formatFocusDuration', () => {
  it('0 / 负数 → 未开始', () => {
    expect(formatFocusDuration(0)).toBe('未开始');
    expect(formatFocusDuration(-1)).toBe('未开始');
    expect(formatFocusDuration(Number.NaN)).toBe('未开始');
  });

  it('不足 1 分钟按 1 分钟算（否则点了立刻停会显示 0 分钟，像坏了）', () => {
    expect(formatFocusDuration(8_000)).toBe('1分钟');
  });

  it('整小时不带 0 分钟', () => {
    expect(formatFocusDuration(2 * 3600_000)).toBe('2小时');
  });

  it('时分混合', () => {
    expect(formatFocusDuration((1 * 60 + 30) * 60000)).toBe('1小时30分钟');
  });
});

describe('computeFocusStreak：连续打卡', () => {
  it('今天有记录 → 含今天往前数', () => {
    const list = [
      session('a', '2026-10-26', 9, 25),
      session('b', '2026-10-25', 9, 25),
      session('c', '2026-10-24', 9, 25),
    ];
    expect(computeFocusStreak(list, '2026-10-26')).toBe(3);
  });

  it('今天还没学但昨天学了 → 从昨天起算，不立刻归零', () => {
    const list = [
      session('b', '2026-10-25', 9, 25),
      session('c', '2026-10-24', 9, 25),
    ];
    expect(computeFocusStreak(list, '2026-10-26')).toBe(2);
  });

  it('中间断一天 → 只数到断点', () => {
    const list = [
      session('a', '2026-10-26', 9, 25),
      // 10-25 缺
      session('c', '2026-10-24', 9, 25),
    ];
    expect(computeFocusStreak(list, '2026-10-26')).toBe(1);
  });

  it('今天和昨天都没有 → 0', () => {
    const list = [session('c', '2026-10-24', 9, 25)];
    expect(computeFocusStreak(list, '2026-10-26')).toBe(0);
  });

  it('空数据 → 0', () => {
    expect(computeFocusStreak([], '2026-10-26')).toBe(0);
  });
});

describe('buildFocusHeatmap：分档用相对当日上限', () => {
  const list = [
    session('a', '2026-10-26', 9, 120), // 最大
    session('b', '2026-10-25', 9, 60),  // 50%
    session('c', '2026-10-24', 9, 24),  // 20%
    session('d', '2026-10-23', 9, 6),   // 5%
  ];

  it('长度 = days，从旧到新，末位是今天', () => {
    const cells = buildFocusHeatmap(list, '2026-10-26', 7);
    expect(cells).toHaveLength(7);
    expect(cells[6]?.date).toBe('2026-10-26');
    expect(cells[0]?.date).toBe('2026-10-20');
  });

  it('分档：0 / ≤25% / ≤50% / ≤75% / >75%', () => {
    const cells = buildFocusHeatmap(list, '2026-10-26', 7);
    const byDate = new Map(cells.map((c) => [c.date, c.level]));
    expect(byDate.get('2026-10-26')).toBe(4); // 100%
    expect(byDate.get('2026-10-25')).toBe(2); // 50%
    expect(byDate.get('2026-10-24')).toBe(1); // 20%
    expect(byDate.get('2026-10-23')).toBe(1); // 5%
    expect(byDate.get('2026-10-22')).toBe(0); // 无记录
  });

  it('全空时全是 0 档，不会因为除以 0 变成 NaN', () => {
    const cells = buildFocusHeatmap([], '2026-10-26', 5);
    expect(cells.every((c) => c.level === 0)).toBe(true);
  });
});

describe('focusByTask：时间花在哪', () => {
  it('按任务聚合并降序', () => {
    const list = [
      session('a', '2026-10-26', 9, 30, 't1'),
      session('b', '2026-10-26', 10, 60, 't2'),
      session('c', '2026-10-26', 11, 10, 't1'),
    ];
    const rows = focusByTask(list);
    expect(rows[0]).toEqual({ taskId: 't2', ms: 60 * 60000 });
    expect(rows[1]).toEqual({ taskId: 't1', ms: 40 * 60000 });
  });

  it('没有 taskId 的归到 null（自由专注）', () => {
    expect(focusByTask([session('a', '2026-10-26', 9, 25, null)])[0]?.taskId).toBeNull();
  });
});

describe('pruneFocusSessions：只留最近 N 天', () => {
  it('超期丢弃，保留期内原样', () => {
    const list = [
      session('a', '2026-10-26', 9, 25),
      session('b', '2026-07-01', 9, 25),
    ];
    const kept = pruneFocusSessions(list, '2026-10-26', 90);
    expect(kept.map((s) => s.id)).toEqual(['a']);
  });

  it('date 非法的条目直接丢掉（不能让它参与任何统计）', () => {
    const kept = pruneFocusSessions(
      [{ id: 'x', taskId: null, date: 'oops', startedAt: 'x', endedAt: 'y', durationMs: 1 }],
      '2026-10-26',
      90,
    );
    expect(kept).toEqual([]);
  });
});
