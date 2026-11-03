import { describe, expect, it } from 'vitest';
import { SLEEP_LOG_KEEP_DAYS, createDefaultSettings } from '../../constants';
import {
  formatSleepSummary,
  nowTimeKey,
  sanitizeSleepLog,
  upsertSleepLog,
} from '../sleep';
import { reducer } from '../../store/reducer';
import type { AppState, SleepEntry } from '../../types';

/* ============================================================================
   F5 作息打卡

   两条重点：
   ① 脏数据只丢自己（云同步 / 手改 JSON 都可能带进来）；
   ② 载荷不会无限长大 —— 只留最近 90 天，这是它敢放在 settings 里的前提。
   ========================================================================= */

describe('sanitizeSleepLog', () => {
  it('非数组 → []，不抛', () => {
    expect(sanitizeSleepLog(null)).toEqual([]);
    expect(sanitizeSleepLog('x')).toEqual([]);
    expect(sanitizeSleepLog({})).toEqual([]);
  });

  it('非法项只丢自己，合法项全部保留', () => {
    const out = sanitizeSleepLog([
      { date: '2026-10-28', wakeAt: '11:05', sleepAt: '02:10' },
      { date: '不是日期', wakeAt: '09:00' },
      { date: '2026-10-27', wakeAt: '25:99' },
      { date: '2026-10-26', wakeAt: null, sleepAt: null }, // 两项都空：没有信息量
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ date: '2026-10-28', wakeAt: '11:05', sleepAt: '02:10' });
  });

  it('同日期去重（同步合并后可能出现两条）', () => {
    const out = sanitizeSleepLog([
      { date: '2026-10-28', wakeAt: '11:05', sleepAt: null },
      { date: '2026-10-28', wakeAt: '12:00', sleepAt: null },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].wakeAt).toBe('11:05');
  });

  it('按日期倒序，并且只留最近 90 天', () => {
    const many: SleepEntry[] = Array.from({ length: SLEEP_LOG_KEEP_DAYS + 20 }, (_, index) => ({
      date: `2026-${String(Math.floor(index / 28) + 1).padStart(2, '0')}-${String((index % 28) + 1).padStart(2, '0')}`,
      wakeAt: '11:00',
      sleepAt: '02:00',
    }));
    const out = sanitizeSleepLog(many);
    expect(out).toHaveLength(SLEEP_LOG_KEEP_DAYS);
    // 倒序：第一条的日期字符串最大
    expect(out[0].date >= out[out.length - 1].date).toBe(true);
  });
});

describe('upsertSleepLog：只改一项，另一项保持', () => {
  const base: SleepEntry[] = [{ date: '2026-10-28', wakeAt: '11:05', sleepAt: null }];

  it('补睡觉时间时，起床时间不能丢', () => {
    const out = upsertSleepLog(base, { date: '2026-10-28', sleepAt: '02:10' });
    expect(out[0]).toMatchObject({ wakeAt: '11:05', sleepAt: '02:10' });
  });

  it('新的一天单独一条', () => {
    const out = upsertSleepLog(base, { date: '2026-10-29', wakeAt: '10:30' });
    expect(out).toHaveLength(2);
    expect(out.find((item) => item.date === '2026-10-29')?.wakeAt).toBe('10:30');
  });

  it('传 null 可以清除（点错了能撤）', () => {
    const out = upsertSleepLog(base, { date: '2026-10-28', wakeAt: null });
    // 两项都空了 → 这条记录本身没有信息量，被清洗掉
    expect(out).toHaveLength(0);
  });
});

describe('展示与格式化', () => {
  it('摘要只说事实，不带评价', () => {
    expect(formatSleepSummary({ date: '2026-10-28', wakeAt: '11:05', sleepAt: '02:10' })).toBe(
      '睡 02:10 · 起 11:05',
    );
  });

  it('没有记录时摘要为空串', () => {
    expect(formatSleepSummary(null)).toBe('');
  });

  it('nowTimeKey 输出零填充的 HH:mm', () => {
    expect(nowTimeKey(new Date(2026, 9, 29, 2, 5))).toBe('02:05');
    expect(nowTimeKey(new Date(2026, 9, 29, 23, 59))).toBe('23:59');
  });
});

describe('reducer：SLEEP_LOG_SET', () => {
  function state(log: SleepEntry[]): AppState {
    return {
      tasks: [],
      notes: [],
      diary: [],
      tombstones: [],
      focusSessions: [],
      settings: { ...createDefaultSettings('2026-10-29'), sleepLog: log },
      ui: { hydrating: false } as unknown as AppState['ui'],
    } as AppState;
  }

  it('写入后能在 sleepLog 里读到', () => {
    const next = reducer(state([]), { type: 'SLEEP_LOG_SET', date: '2026-10-29', sleepAt: '02:10' });
    expect(next.settings.sleepLog[0]).toMatchObject({ date: '2026-10-29', sleepAt: '02:10' });
  });

  it('同值重复点击 → 返回同一个 state（不白写盘、不触发云推送）', () => {
    const s1 = state([{ date: '2026-10-29', wakeAt: '11:00', sleepAt: null }]);
    expect(reducer(s1, { type: 'SLEEP_LOG_SET', date: '2026-10-29', wakeAt: '11:00' })).toBe(s1);
  });
});
