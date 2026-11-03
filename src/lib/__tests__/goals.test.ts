import { describe, expect, it, vi } from 'vitest';
import { TEXT, createDefaultSettings } from '../../constants';
import { buildBackupPayload, migrate, sanitizeSettings } from '../storage';
import { GOAL_NAME_MAX, formatGoalCountdown, nextGoal, sanitizeGoals } from '../goal';
import { mergeGoals, mergeSnapshots } from '../cloudSync';
import { createEmptyState, reducer } from '../../store/reducer';
import { todayKey } from '../date';
import type { ExamGoal, PersistedPayload } from '../../types';
import { backupSource } from './support/backupSource';

/* ============================================================================
   F2 · 目标倒计时（多目标）

   四条必须守住的线：
   ① `sanitizeGoals` 逐项丢弃（一个坏目标不该让其它目标一起消失）；
   ② `mergeGoals` **按 id 取并集**（否则较旧一方新加的目标在首次合并时凭空消失）；
   ③ `nextGoal` 只挑未过期的最近目标，`days === 0` 说"就是今天"；
   ④ 日界口径：`today` 必须是 `todayKey(dayStartHour)`，与今日视图同源。
   ========================================================================= */

const TODAY = '2026-10-24';

function goal(overrides: Partial<ExamGoal> = {}): ExamGoal {
  return { id: 'g1', name: '考研初试', date: '2026-12-20', ...overrides };
}

describe('sanitizeGoals：逐项兜底，不整条清空', () => {
  it('合法目标保留，并按日期升序（列表 / 横幅都按日期读）', () => {
    const list = sanitizeGoals([
      goal({ id: 'late', date: '2027-06-07' }),
      goal({ id: 'early', date: '2026-11-01' }),
    ]);
    expect(list.map((item) => item.id)).toEqual(['early', 'late']);
  });

  it('非法项只丢自己，其它目标照旧保留', () => {
    const list = sanitizeGoals([
      goal({ id: 'ok1' }),
      { id: '', name: '没有 id', date: '2026-11-01' },
      { id: 'no-date', name: '没有日期' },
      { id: 'bad-date', name: '不存在的日期', date: '2026-02-30' },
      { id: 'no-name', name: '   ', date: '2026-11-02' },
      'not-an-object',
      goal({ id: 'ok2', date: '2026-11-05' }),
    ]);
    expect(list.map((item) => item.id)).toEqual(['ok2', 'ok1']);
  });

  it('非数组（缺失 / 老数据 / 手改成对象）→ []', () => {
    expect(sanitizeGoals(undefined)).toEqual([]);
    expect(sanitizeGoals(null)).toEqual([]);
    expect(sanitizeGoals({ id: 'g1' })).toEqual([]);
    expect(sanitizeGoals('goals')).toEqual([]);
  });

  it('同 id 去重（保留先出现的那条）', () => {
    const list = sanitizeGoals([goal({ name: '第一个' }), goal({ name: '第二个' })]);
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe('第一个');
  });

  it('名字 trim + 截断到上限', () => {
    const list = sanitizeGoals([goal({ name: `  ${'长'.repeat(80)}  ` })]);
    expect(list[0]?.name).toHaveLength(GOAL_NAME_MAX);
  });
});

describe('sanitizeSettings：goals 字段显式重建（逐字段重建最容易漏的一处）', () => {
  it('合法 goals 保真', () => {
    const settings = sanitizeSettings({ goals: [goal({ id: 'g1', name: '考研', date: '2026-12-20' })] });
    expect(settings.goals).toEqual([{ id: 'g1', name: '考研', date: '2026-12-20' }]);
  });

  it('缺字段 → []（老数据没有 goals，不该崩也不该凭空造目标）', () => {
    expect(sanitizeSettings({ theme: 'dark' }).goals).toEqual([]);
    expect(sanitizeSettings(null).goals).toEqual([]);
  });

  it('非法项丢弃但其它目标保留', () => {
    const settings = sanitizeSettings({
      goals: [goal({ id: 'ok' }), { id: 'bad' }, { id: 'ok2', name: '期末', date: 'x' }],
    });
    expect(settings.goals.map((item) => item.id)).toEqual(['ok']);
  });

  it('createDefaultSettings 的 goals 恒为 []（不是 undefined）', () => {
    expect(createDefaultSettings(TODAY).goals).toEqual([]);
  });
});

describe('mergeGoals：按 id 取并集（锁住"目标凭空消失"）', () => {
  it('两边各有不同 id → 并集', () => {
    const merged = mergeGoals([goal({ id: 'a', date: '2026-11-01' })], [goal({ id: 'b', date: '2026-12-01' })]);
    expect(merged.map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('同 id 保留 base（较新一方）的版本', () => {
    const merged = mergeGoals(
      [goal({ id: 'a', name: '新名字' })],
      [goal({ id: 'a', name: '旧名字' })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.name).toBe('新名字');
  });

  it('一边空 → 完整保留另一边（本条最重要）', () => {
    const remoteOnly = mergeGoals([], [goal({ id: 'b' })]);
    expect(remoteOnly.map((item) => item.id)).toEqual(['b']);
    const localOnly = mergeGoals([goal({ id: 'a' })], []);
    expect(localOnly.map((item) => item.id)).toEqual(['a']);
    expect(mergeGoals([], [])).toEqual([]);
  });

  it('脏数据不抛：非数组一律当空', () => {
    expect(
      mergeGoals(null as unknown as ExamGoal[], [goal({ id: 'b' })]).map((item) => item.id),
    ).toEqual(['b']);
    expect(mergeGoals([goal({ id: 'a' })], undefined as unknown as ExamGoal[])).toHaveLength(1);
  });
});

describe('mergeSnapshots：较旧一方新加的目标不会消失', () => {
  function payload(savedAt: string, goals: ExamGoal[]): PersistedPayload {
    const base = createEmptyState();
    return {
      schemaVersion: 5,
      savedAt,
      tasks: [],
      settings: { ...base.settings, goals },
      diary: [],
      tombstones: [],
      focusSessions: [],
      notes: [],
    };
  }

  it('本机较新、云端较旧：云端独有的目标必须活下来', () => {
    const local = payload('2026-10-24T10:00:00.000Z', [goal({ id: 'local', date: '2026-12-20' })]);
    const remote = payload('2026-10-24T09:00:00.000Z', [goal({ id: 'remote', date: '2026-11-01' })]);
    const merged = mergeSnapshots(local, remote);
    expect(merged.settings.goals.map((item) => item.id).sort()).toEqual(['local', 'remote']);
  });

  it('云端较新、本机较旧：本机独有的目标同样活下来', () => {
    const local = payload('2026-10-24T08:00:00.000Z', [goal({ id: 'local', date: '2026-12-20' })]);
    const remote = payload('2026-10-24T10:00:00.000Z', [goal({ id: 'remote', date: '2026-11-01' })]);
    const merged = mergeSnapshots(local, remote);
    expect(merged.settings.goals.map((item) => item.id).sort()).toEqual(['local', 'remote']);
  });
});

describe('nextGoal / formatGoalCountdown：最近一个未过期目标', () => {
  it('多目标取最近未过期的那个', () => {
    const goals = [
      goal({ id: 'a', name: '期末', date: '2027-01-10' }),
      goal({ id: 'b', name: '考研初试', date: '2026-11-01' }),
    ];
    const found = nextGoal(goals, TODAY);
    expect(found?.goal.id).toBe('b');
    expect(found?.days).toBe(8);
    expect(formatGoalCountdown(found)).toBe(`${TEXT.goalCountdownPrefix} 考研初试 ${TEXT.goalCountdownMiddle} 8 ${TEXT.goalCountdownSuffix}`);
  });

  it('N = 0 → "就是今天"（不说"还有 0 天"）', () => {
    const found = nextGoal([goal({ name: '考研初试', date: TODAY })], TODAY);
    expect(found?.days).toBe(0);
    expect(formatGoalCountdown(found)).toBe(`考研初试 ${TEXT.goalTodaySuffix}`);
  });

  it('全部已过期 → null，且文案为空串（整行不渲染）', () => {
    const goals = [
      goal({ id: 'a', date: '2026-10-01' }),
      goal({ id: 'b', date: '2026-10-23' }),
    ];
    expect(nextGoal(goals, TODAY)).toBeNull();
    expect(formatGoalCountdown(null)).toBe('');
  });

  it('空列表 / 脏数据 → null（不抛）', () => {
    expect(nextGoal([], TODAY)).toBeNull();
    expect(nextGoal(undefined, TODAY)).toBeNull();
    expect(nextGoal(null, TODAY)).toBeNull();
    expect(nextGoal([goal({ date: '2026-02-30' })], TODAY)).toBeNull();
    expect(nextGoal([goal()], 'not-a-date')).toBeNull();
  });

  it('同一天多个目标时按 id 取较小者（渲染稳定，不闪烁）', () => {
    const found = nextGoal(
      [goal({ id: 'z', name: 'B', date: '2026-11-01' }), goal({ id: 'a', name: 'A', date: '2026-11-01' })],
      TODAY,
    );
    expect(found?.goal.id).toBe('a');
  });

  it('日界 4 点：凌晨 1 点仍算前一天，倒计时与今日视图同源', () => {
    vi.useFakeTimers();
    // 本地时间 2026-10-24 01:00
    vi.setSystemTime(new Date(2026, 9, 24, 1, 0, 0));
    try {
      expect(todayKey(0)).toBe('2026-10-24');
      expect(todayKey(4)).toBe('2026-10-23');

      const goals = [goal({ date: '2026-10-24' })];
      // 按日界口径（今日视图传下来的 today）：还有 1 天
      expect(nextGoal(goals, todayKey(4))?.days).toBe(1);
      // 若有人图省事用自然日，就会算成 0 天（"就是今天"）—— 差一天正是这条要防的
      expect(nextGoal(goals, todayKey(0))?.days).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('持久化贯穿：SET_GOALS + 备份往返', () => {
  it('SET_GOALS 走 sanitizeGoals，非法项被丢弃且排序稳定', () => {
    const s0 = createEmptyState();
    const s1 = reducer(s0, {
      type: 'SET_GOALS',
      goals: [
        goal({ id: 'late', date: '2027-06-07' }),
        { id: '', name: 'x', date: '2026-11-01' },
        goal({ id: 'early', date: '2026-11-01' }),
      ],
    });
    expect(s1.settings.goals.map((item) => item.id)).toEqual(['early', 'late']);
  });

  it('内容没变时返回同一个 state（省掉一次无谓写盘）', () => {
    const s0 = reducer(createEmptyState(), { type: 'SET_GOALS', goals: [goal()] });
    const s1 = reducer(s0, { type: 'SET_GOALS', goals: [goal()] });
    expect(s1).toBe(s0);
  });

  it('清空全部数据会把 goals 一起清掉（settings 回落默认）', () => {
    const s0 = reducer(createEmptyState(), { type: 'SET_GOALS', goals: [goal()] });
    const cleared = reducer(s0, { type: 'DATA_CLEAR_ALL' });
    expect(cleared.settings.goals).toEqual([]);
  });

  it('buildBackupPayload → JSON → migrate 往返保真', () => {
    const settings = { ...createDefaultSettings(TODAY), goals: [goal({ id: 'g1', name: '考研初试', date: '2026-12-20' })] };
    const payload = buildBackupPayload(backupSource({ settings }));
    const roundTrip = migrate(JSON.parse(JSON.stringify(payload)));
    expect(roundTrip?.settings.goals).toEqual([
      { id: 'g1', name: '考研初试', date: '2026-12-20' },
    ]);
  });

  it('goals 仍在 settings 内部：载荷顶层键没有变化', () => {
    const payload = buildBackupPayload(backupSource({ settings: createDefaultSettings(TODAY) }));
    expect(Object.keys(payload).sort()).toEqual([
      'diary',
      'focusSessions',
      'notes',
      'savedAt',
      'schemaVersion',
      'settings',
      'tasks',
      'tombstones',
    ]);
    expect(Object.keys(payload.settings)).toContain('goals');
  });
});
