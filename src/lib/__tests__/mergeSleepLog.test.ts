import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, createDefaultSettings } from '../../constants';
import { mergeSleepLog } from '../sleep';
import { mergeSnapshots } from '../cloudSync';
import type { PersistedPayload, Settings } from '../../types';

/* ============================================================================
   作息打卡的跨端合并（审查发现的 P1）

   背景：settings 合并是 `...base` 整包 + 少数几项做并集。
   `sleepLog` 曾**不在并集清单里**，于是：
     手机记了今天的起床（savedAt T1）→ 电脑稍后同步（savedAt T2 > T1，
     电脑那份里没有这条）→ base 取电脑 → 这条作息消失 → 结果还会被推上云端，
     手机下次同步也找不回来。
   habitChecks 早就是并集待遇，两条同级流水口径不一致 = bug。

   这里守两件事：
   ① mergeSleepLog 本身按日期取并集、同一天按**字段**补空；
   ② mergeSnapshots 真的把它接进了 settings 合并（而不是只在工具函数里对）。
   ========================================================================= */

function settings(patch: Partial<Settings> = {}): Settings {
  return { ...createDefaultSettings('2026-10-28'), ...patch };
}

function payload(savedAt: string, patch: Partial<Settings> = {}): PersistedPayload {
  return {
    schemaVersion: SCHEMA_VERSION,
    savedAt,
    tasks: [],
    settings: settings(patch),
    diary: [],
    tombstones: [],
    focusSessions: [],
    notes: [],
  };
}

describe('mergeSleepLog · 按日期取并集', () => {
  it('一方为空 → 取另一方（"空"是危险状态，不能把有数据的一方盖没）', () => {
    const a = [{ date: '2026-10-28', wakeAt: '11:00', sleepAt: null }];
    expect(mergeSleepLog(a, [])).toEqual(a);
    expect(mergeSleepLog([], a)).toEqual(a);
    expect(mergeSleepLog(null, undefined)).toEqual([]);
  });

  it('不同日期互不覆盖', () => {
    const merged = mergeSleepLog(
      [{ date: '2026-10-28', wakeAt: '11:00', sleepAt: null }],
      [{ date: '2026-10-27', wakeAt: null, sleepAt: '02:00' }],
    );
    expect(merged).toHaveLength(2);
    expect(merged.map((e) => e.date).sort()).toEqual(['2026-10-27', '2026-10-28']);
  });

  it('同一天：起床与睡觉是两个独立动作，各自补空而不是整条覆盖', () => {
    // 典型场景：手机记起床、电脑记睡觉，同一天
    const merged = mergeSleepLog(
      [{ date: '2026-10-28', wakeAt: '11:00', sleepAt: null }],
      [{ date: '2026-10-28', wakeAt: null, sleepAt: '02:00' }],
    );
    expect(merged).toEqual([{ date: '2026-10-28', wakeAt: '11:00', sleepAt: '02:00' }]);
  });

  it('同一字段两边都有值 → 取 base（savedAt 较新的一方）', () => {
    expect(
      mergeSleepLog(
        [{ date: '2026-10-28', wakeAt: '11:00', sleepAt: null }],
        [{ date: '2026-10-28', wakeAt: '07:30', sleepAt: null }],
      ),
    ).toEqual([{ date: '2026-10-28', wakeAt: '11:00', sleepAt: null }]);
  });

  it('脏数据只丢自己，不抛、不牵连其它日期', () => {
    const merged = mergeSleepLog(
      [{ date: '2026-10-28', wakeAt: '11:00', sleepAt: null }],
      [null, { date: 'bad' }, { date: '2026-10-27', wakeAt: '99:99', sleepAt: null }],
    );
    expect(merged).toEqual([{ date: '2026-10-28', wakeAt: '11:00', sleepAt: null }]);
  });
});

describe('mergeSnapshots · sleepLog 真的进了并集清单', () => {
  it('本机较新（没有那条作息）+ 对端有 → 结果里必须还在', () => {
    // 复现路径：手机记了作息（旧），电脑（新、没有这条）来同步
    const local = payload('2026-10-28T12:00:00.000Z', { sleepLog: [] });
    const remote = payload('2026-10-28T10:00:00.000Z', {
      sleepLog: [{ date: '2026-10-28', wakeAt: '11:00', sleepAt: '02:00' }],
    });

    const merged = mergeSnapshots(local, remote);
    expect(merged.settings.sleepLog).toEqual([
      { date: '2026-10-28', wakeAt: '11:00', sleepAt: '02:00' },
    ]);
  });

  it('反过来（本机有、对端较新且没有）同样不能丢', () => {
    const local = payload('2026-10-28T10:00:00.000Z', {
      sleepLog: [{ date: '2026-10-28', wakeAt: '11:00', sleepAt: null }],
    });
    const remote = payload('2026-10-28T12:00:00.000Z', { sleepLog: [] });

    const merged = mergeSnapshots(local, remote);
    expect(merged.settings.sleepLog).toEqual([
      { date: '2026-10-28', wakeAt: '11:00', sleepAt: null },
    ]);
  });

  it('两边同一天各记了一项 → 合并出完整的两天字段', () => {
    const local = payload('2026-10-28T12:00:00.000Z', {
      sleepLog: [{ date: '2026-10-28', wakeAt: null, sleepAt: '02:00' }],
    });
    const remote = payload('2026-10-28T10:00:00.000Z', {
      sleepLog: [{ date: '2026-10-28', wakeAt: '11:00', sleepAt: null }],
    });

    const merged = mergeSnapshots(local, remote);
    expect(merged.settings.sleepLog).toEqual([
      { date: '2026-10-28', wakeAt: '11:00', sleepAt: '02:00' },
    ]);
  });
});
