import { describe, expect, it } from 'vitest';
import { budgetSegments, dayBudget, formatMinutesText } from '../budget';
import { TEXT } from '../../constants';
import type { FocusSession, Task } from '../../types';

/* ============================================================================
   F1 · 今日时间预算

   口径（三条，都有对应断言）：
   1. 只算**未完成**任务 —— 做完的事不该继续占着今天的预计；
   2. 只算**顶层**任务 —— 子任务是父任务的步骤，父子都填了就重复计一次；
   3. 三段（预计 / 已专注 / N 项未估时）**各段为 0 就不出现**，
      全空时返回空数组 → 视图整行不渲染（不占位）。
   ========================================================================= */

const TODAY = '2026-10-24';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: '任务',
    note: '',
    date: TODAY,
    time: null,
    repeat: 'none',
    priority: 'medium',
    category: '学习',
    done: false,
    doneAt: null,
    createdAt: '2026-10-24T01:00:00.000Z',
    updatedAt: '2026-10-24T01:00:00.000Z',
    parentId: null,
    estimatedMinutes: 0,
    ...overrides,
  };
}

function session(overrides: Partial<FocusSession> = {}): FocusSession {
  return {
    id: 'f1',
    taskId: null,
    date: TODAY,
    startedAt: '2026-10-24T09:00:00.000Z',
    endedAt: '2026-10-24T09:50:00.000Z',
    durationMs: 50 * 60_000,
    ...overrides,
  };
}

describe('formatMinutesText：读起来和 formatFocusDuration 一致', () => {
  it('不足一小时只写分钟', () => {
    expect(formatMinutesText(45)).toBe('45分钟');
  });

  it('整小时不写 0 分钟', () => {
    expect(formatMinutesText(120)).toBe('2小时');
  });

  it('有零有整', () => {
    expect(formatMinutesText(150)).toBe('2小时30分钟');
    expect(formatMinutesText(65)).toBe('1小时5分钟');
  });

  it('0 / 非法 → 空串（调用方据此整段不渲染）', () => {
    expect(formatMinutesText(0)).toBe('');
    expect(formatMinutesText(-10)).toBe('');
    expect(formatMinutesText(Number.NaN)).toBe('');
  });
});

describe('dayBudget：只算未完成 + 顶层', () => {
  it('今天没有任务 → 三段全 0，视图不渲染', () => {
    const budget = dayBudget([], TODAY, []);
    expect(budget).toEqual({
      estimatedMinutes: 0,
      focusedMs: 0,
      unestimatedCount: 0,
      openCount: 0,
    });
    expect(budgetSegments(budget)).toEqual([]);
  });

  it('估时求和正确（30 + 120 = 150）', () => {
    const tasks = [
      task({ id: 'a', estimatedMinutes: 30 }),
      task({ id: 'b', estimatedMinutes: 120 }),
    ];
    const budget = dayBudget(tasks, TODAY, []);
    expect(budget.estimatedMinutes).toBe(150);
    expect(budget.unestimatedCount).toBe(0);
    expect(budgetSegments(budget)).toEqual([`${TEXT.budgetEstimatedPrefix} 2小时30分钟`]);
  });

  it('未估时计数正确，并且单独成段', () => {
    const tasks = [
      task({ id: 'a', estimatedMinutes: 30 }),
      task({ id: 'b', estimatedMinutes: 0 }),
      task({ id: 'c', estimatedMinutes: 0 }),
    ];
    const budget = dayBudget(tasks, TODAY, []);
    expect(budget.unestimatedCount).toBe(2);
    expect(budgetSegments(budget)).toEqual([
      `${TEXT.budgetEstimatedPrefix} 30分钟`,
      `2 ${TEXT.budgetUnestimatedSuffix}`,
    ]);
  });

  it('全部未估时 → 只有「N 项未估时」一段（不写"预计 0分钟"）', () => {
    const budget = dayBudget([task({ estimatedMinutes: 0 })], TODAY, []);
    expect(budgetSegments(budget)).toEqual([`1 ${TEXT.budgetUnestimatedSuffix}`]);
  });

  it('已完成的任务不进预算（预计要能降下来）', () => {
    const tasks = [
      task({ id: 'a', estimatedMinutes: 60 }),
      task({ id: 'b', estimatedMinutes: 90, done: true, doneAt: '2026-10-24T09:00:00.000Z' }),
    ];
    expect(dayBudget(tasks, TODAY, []).estimatedMinutes).toBe(60);
  });

  it('子任务不重复计（父 60 + 子 30 → 只算父的 60）', () => {
    const tasks = [
      task({ id: 'p', estimatedMinutes: 60 }),
      task({ id: 'c1', parentId: 'p', estimatedMinutes: 30 }),
      task({ id: 'c2', parentId: 'p', estimatedMinutes: 30 }),
    ];
    const budget = dayBudget(tasks, TODAY, []);
    expect(budget.estimatedMinutes).toBe(60);
    // 子任务也不算"未估时"（它们不参与预算口径，否则数字会翻倍）
    expect(budget.unestimatedCount).toBe(0);
    expect(budget.openCount).toBe(1);
  });

  it('别的日期的任务不进今天的预算', () => {
    const tasks = [
      task({ id: 'a', estimatedMinutes: 30 }),
      task({ id: 'b', date: '2026-10-25', estimatedMinutes: 300 }),
    ];
    expect(dayBudget(tasks, TODAY, []).estimatedMinutes).toBe(30);
  });

  it('已专注时长来自当天 focusSessions（与自习室同源，按 date 过滤）', () => {
    const sessions = [
      session({ id: 'f1' }),
      session({
        id: 'f2',
        startedAt: '2026-10-24T10:00:00.000Z',
        endedAt: '2026-10-24T10:15:00.000Z',
      }),
      // 昨天的那一段不该算进今天
      session({
        id: 'f3',
        date: '2026-10-23',
        startedAt: '2026-10-23T10:00:00.000Z',
        endedAt: '2026-10-23T12:00:00.000Z',
      }),
    ];
    const budget = dayBudget([task({ estimatedMinutes: 30 })], TODAY, sessions);
    expect(budget.focusedMs).toBe(65 * 60_000);
    expect(budgetSegments(budget)).toEqual([
      `${TEXT.budgetEstimatedPrefix} 30分钟`,
      `${TEXT.budgetFocusedPrefix} 1小时5分钟`,
    ]);
  });

  it('脏数据不抛：非数组 / null 项 / 非法估时一律按 0 处理', () => {
    const dirty = [
      null as unknown as Task,
      task({ id: 'a', estimatedMinutes: Number.NaN }),
      task({ id: 'b', estimatedMinutes: -20 }),
    ];
    const budget = dayBudget(dirty, TODAY, [null as unknown as FocusSession]);
    expect(budget.estimatedMinutes).toBe(0);
    expect(budget.unestimatedCount).toBe(2);
    expect(budget.focusedMs).toBe(0);
    // 非数组入参也不抛
    expect(dayBudget(null as unknown as Task[], TODAY, null as unknown as FocusSession[])).toEqual({
      estimatedMinutes: 0,
      focusedMs: 0,
      unestimatedCount: 0,
      openCount: 0,
    });
  });
});
