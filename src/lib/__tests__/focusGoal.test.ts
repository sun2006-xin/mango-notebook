import { describe, expect, it } from 'vitest';
import { createEmptyState, reducer } from '../../store/reducer';
import { FOCUS_GOAL_MAX_MINUTES, focusGoalHint, focusGoalProgress } from '../focus';
import type { AppState, DateKey, FocusSession } from '../../types';

/* ============================================================================
   每日专注目标（F11）

   三件事都必须钉住：
   ① 没设目标（0）时 percent 为 null —— 不是 0，UI 要靠它决定"整块不渲染"；
   ② 超额不封顶 —— 封成 100% 等于抹掉"今天多学了一小时"；
   ③ 不足 1 分钟不计 —— 点一下又停掉不该让进度条动一下。
   ========================================================================= */

const D1 = '2026-10-30' as DateKey;
const D2 = '2026-10-31' as DateKey;

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

describe('focusGoalProgress', () => {
  it('没设目标 → percent 为 null（不是 0），reached 为 false', () => {
    const result = focusGoalProgress([session(D1, 30)], D1, 0);
    expect(result).toEqual({ goalMinutes: 0, focusedMinutes: 30, percent: null, reached: false });
  });

  it('正常进度按比例算', () => {
    const result = focusGoalProgress([session(D1, 60, 'a'), session(D1, 30, 'b')], D1, 180);
    expect(result.focusedMinutes).toBe(90);
    expect(result.percent).toBe(50);
    expect(result.reached).toBe(false);
  });

  it('超额不封顶（130%）—— 多学的那部分要看得见', () => {
    const result = focusGoalProgress([session(D1, 130)], D1, 100);
    expect(result.percent).toBe(130);
    expect(result.reached).toBe(true);
  });

  it('刚好达成 → 100% 且 reached', () => {
    expect(focusGoalProgress([session(D1, 120)], D1, 120)).toMatchObject({
      percent: 100,
      reached: true,
    });
  });

  it('不足 1 分钟不计（点一下又停掉不该让进度动）', () => {
    const started = new Date(`${D1}T09:00:00.000Z`).getTime();
    const tiny = {
      id: 'tiny',
      taskId: null,
      date: D1,
      startedAt: new Date(started).toISOString(),
      endedAt: new Date(started + 20_000).toISOString(),
      category: '学习',
    } as FocusSession;
    expect(focusGoalProgress([tiny], D1, 120).focusedMinutes).toBe(0);
  });

  it('只看当天，别的日子的专注不算进来', () => {
    const result = focusGoalProgress([session(D1, 60, 'a'), session(D2, 60, 'b')], D1, 120);
    expect(result.focusedMinutes).toBe(60);
  });

  it('目标是脏数据（NaN / 负数 / 超 24 小时）→ 收敛，不抛', () => {
    expect(focusGoalProgress([], D1, Number.NaN).percent).toBeNull();
    expect(focusGoalProgress([], D1, -30).goalMinutes).toBe(0);
    expect(focusGoalProgress([], D1, 99999).goalMinutes).toBe(FOCUS_GOAL_MAX_MINUTES);
  });
});

describe('SET_DAILY_FOCUS_GOAL', () => {
  function state(): AppState {
    return createEmptyState();
  }

  it('写入并夹紧到 0–24 小时', () => {
    const s1 = reducer(state(), { type: 'SET_DAILY_FOCUS_GOAL', minutes: 180 });
    expect(s1.settings.dailyFocusGoalMinutes).toBe(180);

    const s2 = reducer(s1, { type: 'SET_DAILY_FOCUS_GOAL', minutes: 99999 });
    expect(s2.settings.dailyFocusGoalMinutes).toBe(FOCUS_GOAL_MAX_MINUTES);

    const s3 = reducer(s2, { type: 'SET_DAILY_FOCUS_GOAL', minutes: -10 });
    expect(s3.settings.dailyFocusGoalMinutes).toBe(0);
  });

  it('值没变 → 返回同一个 state（settings 会触发写盘 + 云推送）', () => {
    const s0 = reducer(state(), { type: 'SET_DAILY_FOCUS_GOAL', minutes: 120 });
    const s1 = reducer(s0, { type: 'SET_DAILY_FOCUS_GOAL', minutes: 120 });
    expect(s1).toBe(s0);
  });

  it('NaN 不覆盖已有值（脏数据不该把目标清零）', () => {
    const s0 = reducer(state(), { type: 'SET_DAILY_FOCUS_GOAL', minutes: 120 });
    const s1 = reducer(s0, { type: 'SET_DAILY_FOCUS_GOAL', minutes: Number.NaN });
    expect(s1.settings.dailyFocusGoalMinutes).toBe(120);
  });
});

describe('focusGoalHint（文案）', () => {
  it('没设目标 → 空串（整块不渲染，不留半句话）', () => {
    expect(focusGoalHint(focusGoalProgress([], D1, 0))).toBe('');
  });

  it('刚起床还没开始 → "还没开始，目标是 3小时"（不是"已专注 未开始"）', () => {
    const hint = focusGoalHint(focusGoalProgress([], D1, 180));
    expect(hint).toBe('还没开始，目标是 3小时');
    expect(hint).not.toContain('未开始，还差');
  });

  it('进行中 → 报还差多少', () => {
    expect(focusGoalHint(focusGoalProgress([session(D1, 45)], D1, 180))).toBe(
      '已专注 45分钟，还差 135 分钟',
    );
  });

  it('达成 → 不再催（"今天够了"）', () => {
    expect(focusGoalHint(focusGoalProgress([session(D1, 200)], D1, 180))).toBe(
      '已专注 3小时20分钟，今天够了',
    );
  });
});
