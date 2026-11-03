import { describe, expect, it } from 'vitest';
import { tasksDueForReminder } from '../task';
import type { Task } from '../../types';

/* ============================================================================
   到期提醒的候选集
   ========================================================================= */

const TODAY = '2026-10-24';

function task(overrides: Partial<Task>): Task {
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
    parentId: null,
    estimatedMinutes: 0,
    createdAt: 'x',
    updatedAt: 'x',
    ...overrides,
  };
}

describe('tasksDueForReminder', () => {
  it('今天已到点且未完成 → 该提醒', () => {
    const list = [task({ id: 'a', time: '09:00' }), task({ id: 'b', time: '14:30' })];
    expect(tasksDueForReminder(list, TODAY, '15:00').map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('已完成的不提醒（哪怕早就到点）', () => {
    const list = [task({ id: 'a', time: '08:00', done: true, doneAt: 'x' })];
    expect(tasksDueForReminder(list, TODAY, '23:00')).toEqual([]);
  });

  it('不是今天的不提醒', () => {
    const list = [task({ id: 'a', time: '09:00', date: '2026-10-23' })];
    expect(tasksDueForReminder(list, TODAY, '15:00')).toEqual([]);
  });

  it('没设时间的不提醒', () => {
    const list = [task({ id: 'a', time: null })];
    expect(tasksDueForReminder(list, TODAY, '23:00')).toEqual([]);
  });

  it('还没到点的不提醒', () => {
    const list = [task({ id: 'a', time: '20:00' })];
    expect(tasksDueForReminder(list, TODAY, '15:00')).toEqual([]);
  });

  it('刚好等于当前分钟算到点', () => {
    const list = [task({ id: 'a', time: '15:00' })];
    expect(tasksDueForReminder(list, TODAY, '15:00').map((t) => t.id)).toEqual(['a']);
  });

  it('字符串比较跨小时正确（09:00 不小于 15:00）', () => {
    const list = [task({ id: 'a', time: '09:00' }), task({ id: 'b', time: '16:00' })];
    expect(tasksDueForReminder(list, TODAY, '15:00').map((t) => t.id)).toEqual(['a']);
  });

  it('脏数据兜底：tasks 不是数组不抛异常', () => {
    expect(tasksDueForReminder(undefined as unknown as Task[], TODAY, '15:00')).toEqual([]);
  });
});
