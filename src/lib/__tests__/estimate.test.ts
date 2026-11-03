import { describe, expect, it } from 'vitest';
import { ESTIMATE_MINUTES_MAX, createDefaultSettings } from '../../constants';
import { buildBackupPayload, migrate, sanitizeTasks } from '../storage';
import { clampEstimateMinutes, createTask } from '../task';
import { createEmptyState, reducer } from '../../store/reducer';
import type { Task } from '../../types';
import { backupSource } from './support/backupSource';

/* ============================================================================
   F1 · 任务估时（分钟）—— 贯穿点守卫

   `Task.estimatedMinutes` 是「现有实体加字段」，所以它有**四条**数据入口：
   ① 表单新建（createTask） ② 抽屉 patch（reducer.normalizePatch）
   ③ 本地 / 云端载荷（storage.sanitizeTasks） ④ 备份往返（buildBackupPayload → migrate）
   四条各写一套 clamp 就会漂移（"能存 9999、改一下变 100000"）。
   这一组测试把四条钉在同一个口径上：**非有限 → 0；有限 → 截断 + 夹紧 [0, 9999]**。
   ========================================================================= */

const NOW = '2026-10-24T10:00:00.000Z';
const TODAY = '2026-10-24';

function rawTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 't1',
    title: '数学真题',
    note: '',
    date: TODAY,
    time: '09:00',
    repeat: 'none',
    priority: 'high',
    category: '学习',
    done: false,
    doneAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    parentId: null,
    ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: '数学真题',
    note: '',
    date: TODAY,
    time: '09:00',
    repeat: 'none',
    priority: 'high',
    category: '学习',
    done: false,
    doneAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    parentId: null,
    estimatedMinutes: 0,
    ...overrides,
  };
}

describe('clampEstimateMinutes：唯一的收敛口径', () => {
  it('0–9999 原样保留（截断小数）', () => {
    expect(clampEstimateMinutes(0)).toBe(0);
    expect(clampEstimateMinutes(30)).toBe(30);
    expect(clampEstimateMinutes(30.9)).toBe(30);
    expect(clampEstimateMinutes(ESTIMATE_MINUTES_MAX)).toBe(9999);
  });

  it('负数 / NaN / Infinity / undefined / 非数字文本 → 0', () => {
    expect(clampEstimateMinutes(-1)).toBe(0);
    expect(clampEstimateMinutes(-9999)).toBe(0);
    expect(clampEstimateMinutes(Number.NaN)).toBe(0);
    expect(clampEstimateMinutes(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampEstimateMinutes(undefined)).toBe(0);
    expect(clampEstimateMinutes(null)).toBe(0);
    expect(clampEstimateMinutes('abc')).toBe(0);
  });

  it('超大值夹到上限（不允许 1e9 变成天文数字）', () => {
    expect(clampEstimateMinutes(1e9)).toBe(ESTIMATE_MINUTES_MAX);
    expect(clampEstimateMinutes(Number.MAX_SAFE_INTEGER)).toBe(ESTIMATE_MINUTES_MAX);
  });
});

describe('① createTask：默认 0，非法值夹紧', () => {
  it('不传 estimatedMinutes → 0（留空 = 未估时）', () => {
    const created = createTask({ title: '看书' }, NOW, TODAY);
    expect(created.estimatedMinutes).toBe(0);
  });

  it('传了就保留，越界就夹紧', () => {
    expect(createTask({ title: '看书', estimatedMinutes: 45 }, NOW, TODAY).estimatedMinutes).toBe(45);
    expect(createTask({ title: '看书', estimatedMinutes: -10 }, NOW, TODAY).estimatedMinutes).toBe(0);
    expect(createTask({ title: '看书', estimatedMinutes: 1e9 }, NOW, TODAY).estimatedMinutes).toBe(
      ESTIMATE_MINUTES_MAX,
    );
  });
});

describe('③ sanitizeTasks：字段在载荷里保真（逐字段重建，最容易漏的一处）', () => {
  it('合法值保留', () => {
    const [parsed] = sanitizeTasks([rawTask({ estimatedMinutes: 120 })]);
    expect(parsed?.estimatedMinutes).toBe(120);
  });

  it('缺失 → 0（老数据没有这个字段）', () => {
    const [parsed] = sanitizeTasks([rawTask()]);
    expect(parsed?.estimatedMinutes).toBe(0);
  });

  it('负数 / NaN / 非数字文本 → 0', () => {
    const list = sanitizeTasks([
      rawTask({ id: 'a', estimatedMinutes: -30 }),
      rawTask({ id: 'b', estimatedMinutes: Number.NaN }),
      rawTask({ id: 'c', estimatedMinutes: 'abc' }),
    ]);
    expect(list.map((item) => item.estimatedMinutes)).toEqual([0, 0, 0]);
  });

  it('超大值夹到 9999，数字字符串可用', () => {
    const list = sanitizeTasks([
      rawTask({ id: 'a', estimatedMinutes: 123456 }),
      rawTask({ id: 'b', estimatedMinutes: '90' }),
    ]);
    expect(list.map((item) => item.estimatedMinutes)).toEqual([ESTIMATE_MINUTES_MAX, 90]);
  });
});

describe('② reducer TASK_PATCH：抽屉改估时同样夹紧', () => {
  const base = createEmptyState();

  it('正常值直接落到任务上，并刷新 updatedAt', () => {
    const s0 = { ...base, tasks: [task({ estimatedMinutes: 0 })] };
    const s1 = reducer(s0, { type: 'TASK_PATCH', id: 't1', patch: { estimatedMinutes: 40 }, now: NOW });
    expect(s1.tasks[0]?.estimatedMinutes).toBe(40);
    expect(s1.tasks[0]?.updatedAt).toBe(NOW);
  });

  it('负数 → 0；超大 → 9999', () => {
    const s0 = { ...base, tasks: [task()] };
    const negative = reducer(s0, {
      type: 'TASK_PATCH',
      id: 't1',
      patch: { estimatedMinutes: -5 },
      now: NOW,
    });
    expect(negative.tasks[0]?.estimatedMinutes).toBe(0);

    const huge = reducer(s0, {
      type: 'TASK_PATCH',
      id: 't1',
      patch: { estimatedMinutes: 1e9 },
      now: NOW,
    });
    expect(huge.tasks[0]?.estimatedMinutes).toBe(ESTIMATE_MINUTES_MAX);
  });
});

describe('④ 备份往返：buildBackupPayload → JSON → migrate 保真', () => {
  it('estimatedMinutes 一圈回来还在', () => {
    const payload = buildBackupPayload(
      backupSource({ tasks: [task({ estimatedMinutes: 150 })], settings: createDefaultSettings(TODAY) }),
    );
    const roundTrip = migrate(JSON.parse(JSON.stringify(payload)));
    expect(roundTrip?.tasks[0]?.estimatedMinutes).toBe(150);
  });
});

describe('⑥ 墓碑限制（已知取舍，锁住行为）', () => {
  it('回收站恢复的任务 estimatedMinutes 为 0（与 priority/repeat/note 同样不保留）', () => {
    const state = reducer(createEmptyState(), {
      type: 'TASK_DELETE',
      id: 'gone',
      now: NOW,
    });
    // 直接构造一条墓碑：模拟"删了一条估时 90 分钟的任务"
    const withStone = reducer(
      { ...state, tombstones: [{ id: 'gone', deletedAt: NOW, title: '英语听力', date: TODAY, index: 0 }] },
      { type: 'TOMBSTONE_RESTORE', id: 'gone', now: NOW },
    );
    const restored = withStone.tasks.find((item) => item.id === 'gone');
    expect(restored?.title).toBe('英语听力');
    expect(restored?.estimatedMinutes).toBe(0);
  });
});
