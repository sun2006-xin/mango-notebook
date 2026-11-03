import { describe, expect, it } from 'vitest';
import {
  applyTaskToggle,
  getChildTasks,
  getSubtaskProgress,
  getTopLevelTasks,
  groupDayTasks,
  normalizeParentId,
} from '../task';
import type { Task } from '../../types';

/* ============================================================================
   子任务（父子两层）

   守的是两件互相打架的事：
   ① 勾父 → 子必须跟着变（否则"父已完成、子还绿着"）；
   ② 子全勾完 → 父必须自动完成（否则进度说 5/5、父还站在待办区）。
   两条都不能松，否则界面上的数字和状态会互相打脸。
   ========================================================================= */

const TODAY = '2026-10-26';
const NOW = '2026-10-26T10:00:00.000Z';

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
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
    createdAt: '2026-10-26T01:00:00.000Z',
    updatedAt: '2026-10-26T01:00:00.000Z',
    ...overrides,
  };
}

const parent = (overrides: Partial<Task> = {}) => task('p', overrides);
const child = (id: string, overrides: Partial<Task> = {}) =>
  task(id, { parentId: 'p', ...overrides });

describe('getChildTasks / getSubtaskProgress / getTopLevelTasks', () => {
  const list = [parent(), child('c1'), child('c2', { done: true })];

  it('只取直接子任务', () => {
    expect(getChildTasks(list, 'p').map((t) => t.id).sort()).toEqual(['c1', 'c2']);
    expect(getChildTasks(list, 'nope')).toEqual([]);
  });

  it('父行进度 1/2', () => {
    expect(getSubtaskProgress(list, 'p')).toEqual({ done: 1, total: 2 });
    expect(getSubtaskProgress(list, 'c1')).toEqual({ done: 0, total: 0 });
  });

  it('顶层不含子任务', () => {
    expect(getTopLevelTasks(list).map((t) => t.id)).toEqual(['p']);
  });
});

describe('normalizeParentId：只准一层', () => {
  it('指向顶层任务 → 原样', () => {
    expect(normalizeParentId([parent()], 'p')).toBe('p');
  });

  it('指向子任务 → 升级到祖父（与自己同级），不让它变三层', () => {
    expect(normalizeParentId([parent(), child('c1')], 'c1')).toBe('p');
  });

  it('祖父不存在（父是孤儿）→ 退化顶层', () => {
    const orphan = task('c1', { parentId: 'ghost' });
    expect(normalizeParentId([orphan], 'c1')).toBeNull();
  });

  it('空 / 不存在的 id → null', () => {
    expect(normalizeParentId([parent()], null)).toBeNull();
    expect(normalizeParentId([parent()], '')).toBeNull();
    expect(normalizeParentId([parent()], 'ghost')).toBeNull();
  });
});

describe('applyTaskToggle：向下级联', () => {
  it('勾父 → 所有子一起勾，并写 doneAt', () => {
    const next = applyTaskToggle([parent(), child('c1'), child('c2')], 'p', NOW);
    expect(next.every((t) => t.done)).toBe(true);
    expect(next.filter((t) => t.parentId === 'p').every((t) => t.doneAt === NOW)).toBe(true);
  });

  it('取消父 → 所有子一起取消', () => {
    const done = [parent({ done: true }), child('c1', { done: true }), child('c2', { done: true })];
    const next = applyTaskToggle(done, 'p', NOW);
    expect(next.every((t) => !t.done)).toBe(true);
    expect(next.every((t) => t.doneAt === null)).toBe(true);
  });

  it('返回值必须是新数组（不可变更新）', () => {
    const list = [parent()];
    expect(applyTaskToggle(list, 'p', NOW)).not.toBe(list);
  });

  it('id 不存在 → 原样返回同一数组（不制造无谓的保存）', () => {
    const list = [parent()];
    expect(applyTaskToggle(list, 'ghost', NOW)).toBe(list);
  });

  it('只影响自己的子树，不误伤别的父任务', () => {
    const other = task('p2');
    const otherChild = task('d1', { parentId: 'p2' });
    const next = applyTaskToggle([parent(), child('c1'), other, otherChild], 'p', NOW);
    const byId = new Map(next.map((t) => [t.id, t]));
    expect(byId.get('p2')?.done).toBe(false);
    expect(byId.get('d1')?.done).toBe(false);
  });
});

describe('applyTaskToggle：向上汇总', () => {
  it('最后一个子任务勾完 → 父自动完成', () => {
    const list = [parent(), child('c1', { done: true }), child('c2')];
    const next = applyTaskToggle(list, 'c2', NOW);
    const byId = new Map(next.map((t) => [t.id, t]));
    expect(byId.get('p')?.done).toBe(true);
    expect(byId.get('p')?.doneAt).toBe(NOW);
  });

  it('只勾了一部分 → 父仍未完成', () => {
    const list = [parent(), child('c1'), child('c2')];
    const next = applyTaskToggle(list, 'c1', NOW);
    expect(next.find((t) => t.id === 'p')?.done).toBe(false);
  });

  it('已完成状态下取消任一子任务 → 父退回未完成（否则数字和状态会打脸）', () => {
    const list = [
      parent({ done: true, doneAt: NOW }),
      child('c1', { done: true }),
      child('c2', { done: true }),
    ];
    const next = applyTaskToggle(list, 'c2', NOW);
    const byId = new Map(next.map((t) => [t.id, t]));
    expect(byId.get('c2')?.done).toBe(false);
    expect(byId.get('p')?.done).toBe(false);
    expect(byId.get('p')?.doneAt).toBeNull();
  });

  it('子任务没全勾完时不动父任务（避免 updatedAt 无意义抖动）', () => {
    const list = [parent(), child('c1'), child('c2')];
    const next = applyTaskToggle(list, 'c1', NOW);
    const p = next.find((t) => t.id === 'p');
    expect(p?.done).toBe(false);
    expect(p?.updatedAt).toBe('2026-10-26T01:00:00.000Z');
  });
});

describe('groupDayTasks：子任务不重复出现在顶层', () => {
  function build(list: Task[]) {
    return groupDayTasks({
      tasks: list,
      date: TODAY,
      today: TODAY,
      mode: 'all',
      category: null,
      stickyDoneIds: [],
      includeOverdue: false,
    });
  }

  it('顶层只有父任务，子任务进 childrenByParent', () => {
    const group = build([parent(), child('c1'), child('c2')]);
    expect(group.open.map((t) => t.id)).toEqual(['p']);
    expect(group.childrenByParent.p?.map((t) => t.id).sort()).toEqual(['c1', 'c2']);
  });

  it('分类筛选不会把改过分类的子任务弄丢（分类是父任务的属性）', () => {
    const group = groupDayTasks({
      tasks: [parent(), child('c1', { category: '技术' })],
      date: TODAY,
      today: TODAY,
      mode: 'all',
      category: '学习',
      stickyDoneIds: [],
      includeOverdue: false,
    });
    expect(group.open).toHaveLength(1);
    // 父任务被保留 → 它的子任务必须跟着出现，而不是凭分类被丢掉
    expect(group.childrenByParent.p).toHaveLength(1);
  });

  it('mode=open 时已完成的子任务不出现', () => {
    const group = groupDayTasks({
      tasks: [parent(), child('c1', { done: true }), child('c2')],
      date: TODAY,
      today: TODAY,
      mode: 'open',
      category: null,
      stickyDoneIds: [],
      includeOverdue: false,
    });
    expect(group.childrenByParent.p?.map((t) => t.id)).toEqual(['c2']);
  });

  it('没有子任务时 childrenByParent 是空对象（不是 undefined）', () => {
    const group = build([parent()]);
    expect(group.childrenByParent).toEqual({});
  });
});
