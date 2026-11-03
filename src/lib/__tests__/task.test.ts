import { describe, expect, it } from 'vitest';
import type { Task } from '../../types';
import {
  EmptyTitleError,
  applyFilter,
  buildWeekColumns,
  compareDoneTasks,
  compareOpenTasks,
  compareWeekColumnTasks,
  countByCategory,
  countDoneInView,
  createTask,
  isSameRepeatOccurrence,
  estimateStorageKb,
  getDayProgress,
  getDayStatus,
  getMonthStatusMap,
  getOverdueTasks,
  getTasksForDate,
  groupDayTasks,
  indexByDate,
} from '../task';
import { buildMonthGrid, buildWeekDays } from '../date';

/* ============================================================================
   §4.2 任务纯函数
   ========================================================================= */

let seq = 0;
function mk(overrides: Partial<Task> = {}): Task {
  seq += 1;
  const base: Task = {
    id: `t${String(seq).padStart(3, '0')}`,
    title: `任务${seq}`,
    note: '',
    date: '2026-10-24',
    time: null,
    repeat: 'none',
    priority: 'medium',
    category: '学习',
    done: false,
    doneAt: null,
    createdAt: `2026-01-01T00:00:${String(seq).padStart(2, '0')}.000Z`,
    updatedAt: '2026-01-01T00:00:00.000Z',
    parentId: null,
    estimatedMinutes: 0,
  };
  return { ...base, ...overrides };
}

describe('createTask', () => {
  it('空标题抛 EmptyTitleError', () => {
    expect(() => createTask({ title: '   ' }, 'now', '2026-10-24')).toThrow(EmptyTitleError);
  });

  it('补齐默认值并把非法字段兜底', () => {
    const task = createTask(
      { title: '  写周报  ', time: '25:99', date: '2026-02-30', priority: 'low', category: '' },
      '2026-10-24T00:00:00.000Z',
      '2026-10-20',
    );
    expect(task.title).toBe('写周报');
    expect(task.time).toBeNull();
    expect(task.date).toBe('2026-10-20'); // 非法日期回落 fallbackDate
    expect(task.priority).toBe('low');
    expect(task.category).toBe('学习');
    expect(task.done).toBe(false);
    expect(task.doneAt).toBeNull();
    expect(task.id).toBeTruthy();
  });

  it('标题超 120 截断、note 超 500 截断', () => {
    const task = createTask(
      { title: 'x'.repeat(200), note: 'y'.repeat(600) },
      '2026-10-24T00:00:00.000Z',
      '2026-10-24',
    );
    expect(task.title).toHaveLength(120);
    expect(task.note).toHaveLength(500);
  });
});

describe('compareOpenTasks（五级稳定排序）', () => {
  it('有时间者一律在无时间者之前', () => {
    const timed = mk({ id: 'a', time: '23:00' });
    const untimed = mk({ id: 'b', time: null, priority: 'high' });
    expect(compareOpenTasks(timed, untimed)).toBeLessThan(0);
  });

  it('都有时间 → time 升序', () => {
    const a = mk({ id: 'a', time: '09:00' });
    const b = mk({ id: 'b', time: '10:00' });
    expect(compareOpenTasks(a, b)).toBeLessThan(0);
    expect(compareOpenTasks(b, a)).toBeGreaterThan(0);
  });

  it('都无时间 → 优先级 高 > 中 > 低', () => {
    const high = mk({ id: 'a', priority: 'high' });
    const mid = mk({ id: 'b', priority: 'medium' });
    const low = mk({ id: 'c', priority: 'low' });
    expect(compareOpenTasks(high, mid)).toBeLessThan(0);
    expect(compareOpenTasks(mid, low)).toBeLessThan(0);
    expect(compareOpenTasks(low, high)).toBeGreaterThan(0);
  });

  it('仍并列 → createdAt 升序', () => {
    const a = mk({ id: 'z', createdAt: '2026-01-01T00:00:01.000Z' });
    const b = mk({ id: 'a', createdAt: '2026-01-01T00:00:02.000Z' });
    expect(compareOpenTasks(a, b)).toBeLessThan(0);
  });

  it('最终兜底 id 升序（排序稳定）', () => {
    const a = mk({ id: 'aaa', createdAt: 'same' });
    const b = mk({ id: 'bbb', createdAt: 'same' });
    expect(compareOpenTasks(a, b)).toBeLessThan(0);
    expect(compareOpenTasks(b, a)).toBeGreaterThan(0);
  });

  it('不读 done 字段：勾选前后比较键完全相同（U6 混排不跳位）', () => {
    const before = mk({ id: 'a', time: '09:00' });
    const after = { ...before, done: true, doneAt: '2026-10-24T10:00:00.000Z' };
    const other = mk({ id: 'b', time: '10:00' });
    expect(compareOpenTasks(before, other)).toBe(compareOpenTasks(after, other));
  });

  it('同输入两次排序结果完全一致', () => {
    const list = [
      mk({ id: 'c', time: null, priority: 'low' }),
      mk({ id: 'a', time: '08:00' }),
      mk({ id: 'b', time: null, priority: 'high' }),
      mk({ id: 'd', time: '08:00' }),
    ];
    const first = [...list].sort(compareOpenTasks).map((t) => t.id);
    const second = [...list].sort(compareOpenTasks).map((t) => t.id);
    expect(first).toEqual(second);
    expect(first).toEqual(['a', 'd', 'b', 'c']);
  });
});

describe('compareDoneTasks（doneAt 降序，null 最旧）', () => {
  it('刚完成的在上', () => {
    const older = { ...mk({ id: 'a' }), doneAt: '2026-10-24T09:00:00.000Z' };
    const newer = { ...mk({ id: 'b' }), doneAt: '2026-10-24T10:00:00.000Z' };
    expect(compareDoneTasks(newer, older)).toBeLessThan(0);
  });

  it('null 视为最旧（排在后面）', () => {
    const withAt = { ...mk({ id: 'a' }), doneAt: '2026-10-24T09:00:00.000Z' };
    const withoutAt = { ...mk({ id: 'b' }), doneAt: null };
    expect(compareDoneTasks(withAt, withoutAt)).toBeLessThan(0);
    expect(compareDoneTasks(withoutAt, withAt)).toBeGreaterThan(0);
  });
});

describe('getTasksForDate / getOverdueTasks', () => {
  const tasks = [
    mk({ id: 'a', date: '2026-10-22', done: true }),
    mk({ id: 'b', date: '2026-10-22', done: false }),
    mk({ id: 'c', date: '2026-10-24', done: false }),
    mk({ id: 'd', date: '2026-10-26', done: false }),
  ];

  it('按日过滤且不排序', () => {
    expect(getTasksForDate(tasks, '2026-10-22').map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('逾期 = date < today && !done，最老的在上', () => {
    const overdue = getOverdueTasks(tasks, '2026-10-24');
    expect(overdue.map((t) => t.id)).toEqual(['b']);
    expect(overdue.some((t) => t.id === 'a')).toBe(false); // 已完成
    expect(overdue.some((t) => t.id === 'c')).toBe(false); // 当天不算逾期
    expect(overdue.some((t) => t.id === 'd')).toBe(false); // 未来不算逾期
  });

  it('多条逾期按 date 升序', () => {
    const many = [
      mk({ id: 'x', date: '2026-10-23' }),
      mk({ id: 'y', date: '2026-10-20' }),
      mk({ id: 'z', date: '2026-10-21' }),
    ];
    expect(getOverdueTasks(many, '2026-10-24').map((t) => t.id)).toEqual(['y', 'z', 'x']);
  });
});

describe('applyFilter', () => {
  const tasks = [mk({ id: 'a', done: true }), mk({ id: 'b', done: false, category: '工作' })];

  it('mode 与 category 独立生效', () => {
    expect(applyFilter(tasks, 'all', null).map((t) => t.id)).toEqual(['a', 'b']);
    expect(applyFilter(tasks, 'open', null).map((t) => t.id)).toEqual(['b']);
    expect(applyFilter(tasks, 'done', null).map((t) => t.id)).toEqual(['a']);
    expect(applyFilter(tasks, 'all', '工作').map((t) => t.id)).toEqual(['b']);
  });
});

describe('groupDayTasks（sticky 混排 + 逾期口径）', () => {
  it('sticky 项与未完成项一起混排，位置不跳到末尾', () => {
    const a = mk({ id: 'a', time: '08:00' });
    const b = mk({ id: 'b', time: '09:00' });
    const c = mk({ id: 'c', time: '10:00' });
    const tasks = [a, b, c];

    const before = groupDayTasks({
      tasks,
      date: '2026-10-24',
      today: '2026-10-24',
      mode: 'all',
      category: null,
      stickyDoneIds: [],
      includeOverdue: true,
    });
    expect(before.open.map((t) => t.id)).toEqual(['a', 'b', 'c']);

    const after = groupDayTasks({
      tasks: [a, { ...b, done: true, doneAt: '2026-10-24T09:30:00.000Z' }, c],
      date: '2026-10-24',
      today: '2026-10-24',
      mode: 'all',
      category: null,
      stickyDoneIds: ['b'],
      includeOverdue: true,
    });
    // 勾选后仍在第 2 位（不是被挪到末尾）
    expect(after.open.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    expect(after.sticky.map((t) => t.id)).toEqual(['b']);
    expect(after.done).toHaveLength(0);
  });

  it('mode=open 时 sticky 也不显示；mode=done 时 sticky 归入 done', () => {
    const doneTask = { ...mk({ id: 'a', time: '09:00' }), done: true, doneAt: '2026-10-24T09:00:00.000Z' };
    const base = {
      tasks: [doneTask, mk({ id: 'b', time: '10:00' })],
      date: '2026-10-24',
      today: '2026-10-24',
      category: null,
      stickyDoneIds: ['a'],
      includeOverdue: true,
    };
    expect(groupDayTasks({ ...base, mode: 'open' }).open.map((t) => t.id)).toEqual(['b']);
    const doneMode = groupDayTasks({ ...base, mode: 'done' });
    expect(doneMode.open).toHaveLength(0);
    expect(doneMode.done.map((t) => t.id)).toEqual(['a']);
  });

  it('overdue 仅在 includeOverdue && date===today && mode!==done 时非空', () => {
    const tasks = [mk({ id: 'p', date: '2026-10-23' })];
    const args = {
      tasks,
      date: '2026-10-24',
      today: '2026-10-24',
      mode: 'all' as const,
      category: null,
      stickyDoneIds: [],
      includeOverdue: true,
    };
    expect(groupDayTasks(args).overdue).toHaveLength(1);
    expect(groupDayTasks({ ...args, includeOverdue: false }).overdue).toHaveLength(0);
    expect(groupDayTasks({ ...args, date: '2026-10-25' }).overdue).toHaveLength(0);
    expect(groupDayTasks({ ...args, mode: 'done' }).overdue).toHaveLength(0);
  });

  it('逾期区跟着分类筛选走', () => {
    const tasks = [mk({ id: 'p', date: '2026-10-23', category: '工作' })];
    const group = groupDayTasks({
      tasks,
      date: '2026-10-24',
      today: '2026-10-24',
      mode: 'all',
      category: '学习',
      stickyDoneIds: [],
      includeOverdue: true,
    });
    expect(group.overdue).toHaveLength(0);
  });
});

describe('countDoneInView 与 getDayProgress 恒等（U7）', () => {
  it('含 sticky 场景也恒等', () => {
    const a = { ...mk({ id: 'a', time: '08:00' }), done: true, doneAt: '2026-10-24T08:30:00.000Z' };
    const b = { ...mk({ id: 'b', time: '09:00' }), done: true, doneAt: '2026-10-24T09:30:00.000Z' };
    const c = mk({ id: 'c', time: '10:00' });
    const d = mk({ id: 'd', time: '11:00' });
    const tasks = [a, b, c, d];

    const group = groupDayTasks({
      tasks,
      date: '2026-10-24',
      today: '2026-10-24',
      mode: 'all',
      category: null,
      stickyDoneIds: ['b'],
      includeOverdue: true,
    });

    expect(countDoneInView(group)).toBe(2);
    expect(countDoneInView(group)).toBe(getDayProgress(tasks, '2026-10-24').done);
    // a 已完成但不在 sticky（直接归入 done 组）；b 是 sticky，仍留在待办区第 2 位
    expect(group.open.map((t) => t.id)).toEqual(['b', 'c', 'd']);
    expect(group.done.map((t) => t.id)).toEqual(['a']);
  });

  it('全部完成时同样恒等', () => {
    const tasks = [
      { ...mk({ id: 'a' }), done: true, doneAt: '2026-10-24T08:00:00.000Z' },
      { ...mk({ id: 'b' }), done: true, doneAt: '2026-10-24T09:00:00.000Z' },
    ];
    const group = groupDayTasks({
      tasks,
      date: '2026-10-24',
      today: '2026-10-24',
      mode: 'all',
      category: null,
      stickyDoneIds: [],
      includeOverdue: true,
    });
    expect(countDoneInView(group)).toBe(getDayProgress(tasks, '2026-10-24').done);
  });
});

describe('getDayProgress / getDayStatus', () => {
  it('空任务 percent 为 null', () => {
    expect(getDayProgress([], '2026-10-24')).toEqual({ done: 0, total: 0, percent: null });
  });

  it('percent 四舍五入', () => {
    const tasks = [mk({ id: 'a' }), mk({ id: 'b' }), mk({ id: 'c', done: true, doneAt: 'x' })];
    expect(getDayProgress(tasks, '2026-10-24')).toEqual({ done: 1, total: 3, percent: 33 });
  });

  it('四态覆盖', () => {
    expect(getDayStatus([], '2026-10-24')).toBe('empty');
    expect(getDayStatus([mk({ id: 'a' })], '2026-10-24')).toBe('none-done');
    expect(
      getDayStatus([mk({ id: 'a' }), mk({ id: 'b', done: true, doneAt: 'x' })], '2026-10-24'),
    ).toBe('partial');
    expect(getDayStatus([mk({ id: 'a', done: true, doneAt: 'x' })], '2026-10-24')).toBe('all-done');
  });
});

describe('周视图数据（compareWeekColumnTasks / buildWeekColumns）', () => {
  it('已完成置底', () => {
    const open = mk({ id: 'a', time: '10:00' });
    const done = { ...mk({ id: 'b', time: '08:00' }), done: true, doneAt: 'x' };
    expect(compareWeekColumnTasks(open, done)).toBeLessThan(0);
    expect(compareWeekColumnTasks(done, open)).toBeGreaterThan(0);
  });

  it('每天最多 maxRows 条，overflow 正确，progress 与 getDayProgress 同源', () => {
    const days = buildWeekDays('2026-10-24', 1);
    const today = '2026-10-24';
    const tasks = [
      mk({ id: 'a', date: today, time: '08:00' }),
      mk({ id: 'b', date: today, time: '09:00' }),
      mk({ id: 'c', date: today, time: '10:00' }),
      mk({ id: 'd', date: today, time: '11:00' }),
      mk({ id: 'e', date: today, time: '12:00' }),
      mk({ id: 'f', date: today, time: '13:00', done: true, doneAt: 'x' }),
    ];
    const columns = buildWeekColumns(tasks, days, today, today, 4);
    expect(columns).toHaveLength(7);

    const col = columns.find((c) => c.key === today);
    expect(col).toBeDefined();
    expect(col?.tasks).toHaveLength(4);
    expect(col?.overflow).toBe(2);
    expect(col?.isEmpty).toBe(false);
    expect(col?.isToday).toBe(true);
    expect(col?.isSelected).toBe(true);
    expect(col?.progress).toEqual(getDayProgress(tasks, today));
  });

  it('空日 isEmpty=true 且 progress.total=0', () => {
    const days = buildWeekDays('2026-10-24', 1);
    const columns = buildWeekColumns([], days, '2026-10-24', '2026-10-24', 4);
    expect(columns.every((c) => c.isEmpty)).toBe(true);
    expect(columns[0]?.progress).toEqual({ done: 0, total: 0, percent: null });
  });

  it('day 取日期里的日号（跨月列不裁剪）', () => {
    const days = buildWeekDays('2026-10-28', 1);
    const columns = buildWeekColumns([], days, '2026-10-24', '2026-10-24', 4);
    expect(columns.map((c) => c.day)).toEqual([26, 27, 28, 29, 30, 31, 1]);
  });
});

describe('indexByDate / getMonthStatusMap', () => {
  const tasks = [
    mk({ id: 'a', date: '2026-10-24' }),
    mk({ id: 'b', date: '2026-10-24', done: true, doneAt: 'x' }),
    mk({ id: 'c', date: '2026-10-25', done: true, doneAt: 'x' }),
  ];

  it('一次遍历分组', () => {
    const index = indexByDate(tasks);
    expect(index.get('2026-10-24')?.map((t) => t.id)).toEqual(['a', 'b']);
    expect(index.get('2026-10-26')).toBeUndefined();
  });

  it('42 格四态：无 key 视为 empty', () => {
    const cells = buildMonthGrid(2026, 9, 1, '2026-10-24');
    const map = getMonthStatusMap(indexByDate(tasks), cells);
    expect(map.get('2026-10-24')).toBe('partial');
    expect(map.get('2026-10-25')).toBe('all-done');
    expect(map.get('2026-10-26')).toBe('empty');
    expect(map.size).toBe(42);
  });
});

describe('性能（500 条任务，node 真实时间）', () => {
  it('indexByDate + 42 格四态统计 < 5ms', () => {
    const tasks: Task[] = [];
    for (let i = 0; i < 500; i += 1) {
      const day = (i % 28) + 1;
      const month = i % 12;
      tasks.push(
        mk({
          id: `perf${i}`,
          date: `2026-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
          done: i % 3 === 0,
          doneAt: i % 3 === 0 ? '2026-10-24T10:00:00.000Z' : null,
        }),
      );
    }
    const cells = buildMonthGrid(2026, 9, 1, '2026-10-24');

    const started = performance.now();
    for (let round = 0; round < 10; round += 1) {
      const index = indexByDate(tasks);
      getMonthStatusMap(index, cells);
    }
    const perRound = (performance.now() - started) / 10;

    // 10 轮取均值，避免单次抖动；单轮是"一次切月"的数据成本
    expect(perRound).toBeLessThan(5);
    // 把实测值写进断言消息，方便在 CI 日志里看到
    expect(`单轮 ${perRound.toFixed(2)}ms`).toBeTruthy();
  });
});

describe('countByCategory / estimateStorageKb', () => {
  const tasks = [
    mk({ id: 'a', category: '学习' }),
    mk({ id: 'b', category: '学习' }),
    mk({ id: 'c', category: '生活' }),
  ];
  const categories = [{ name: '学习' }, { name: '工作' }, { name: '生活' }, { name: '其他' }];

  it('按预设顺序输出，空分类保留 0', () => {
    expect(countByCategory(tasks, null, categories)).toEqual([
      { name: '学习', count: 2 },
      { name: '工作', count: 0 },
      { name: '生活', count: 1 },
      { name: '其他', count: 0 },
    ]);
  });

  it('限定日期时只统计该日', () => {
    expect(countByCategory(tasks, '2026-10-24', categories)[0]?.count).toBe(2);
    expect(countByCategory(tasks, '2026-10-25', categories)[0]?.count).toBe(0);
  });

  it('KB 换算保留 1 位小数', () => {
    expect(estimateStorageKb('a'.repeat(1024))).toBe(1);
    expect(estimateStorageKb('a'.repeat(1536))).toBe(1.5);
    expect(estimateStorageKb('')).toBe(0);
  });
});

/* ============================================================================
   重复任务判重（v0.29.2）
   ----------------------------------------------------------------------------
   勾完一条重复任务会生成下一周期的那一份。判"要不要生成"用
   `isSameRepeatOccurrence` —— 它必须把时间/分类/优先级算进去。

   只比标题时的真实后果：同一天有两条同名重复任务（07:00 跑步 + 20:00 跑步），
   勾完 07:00 那条后生成的明天 07:00 那份，会被 20:00 那条的判重命中 →
   20:00 这条链**静默断掉**，之后再也不出现，用户只能每周自己补建。
   ========================================================================= */
describe('isSameRepeatOccurrence', () => {
  const base = {
    id: 't1', title: '跑步', note: '', date: '2026-10-31',
    time: '07:00', repeat: 'daily', priority: 'mid', category: '锻炼',
    done: false, doneAt: null,
    createdAt: '2026-10-31T07:00:00.000Z', updatedAt: '2026-10-31T07:00:00.000Z',
    parentId: null,
  } as unknown as Task;

  it('同标题不同时间 → 不是同一次（同一件事的早晚两档）', () => {
    expect(isSameRepeatOccurrence(base, { ...base, time: '20:00' })).toBe(false);
  });

  it('同标题不同分类 / 优先级 → 不是同一次', () => {
    expect(isSameRepeatOccurrence(base, { ...base, category: '学习' })).toBe(false);
    expect(isSameRepeatOccurrence(base, { ...base, priority: 'high' })).toBe(false);
  });

  it('日期不同 → 不是同一次（跨天就是下一次）', () => {
    expect(isSameRepeatOccurrence(base, { ...base, date: '2026-11-01' })).toBe(false);
  });

  it('全同（含 id 不同）→ 是同一次：这正是"已经生成过了"的判据', () => {
    expect(isSameRepeatOccurrence(base, { ...base, id: 't2' })).toBe(true);
  });

  it('时间为空 / undefined 混用 → 仍算同一次（老数据没有 time 字段）', () => {
    const noTime = { ...base, time: '' } as unknown as Task;
    const undef = { ...base, time: undefined } as unknown as Task;
    expect(isSameRepeatOccurrence(noTime, undef)).toBe(true);
  });
});
