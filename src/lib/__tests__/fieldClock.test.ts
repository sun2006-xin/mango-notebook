import { describe, expect, it } from 'vitest';
import {
  TASK_SYNC_FIELDS,
  fieldClockOf,
  fullFieldClock,
  sanitizeFieldAt,
  stampChangedFields,
  toMillis,
} from '../fieldClock';
import type { Task } from '../../types';

/* ============================================================================
   字段级时钟：纯函数
   ----------------------------------------------------------------------------
   这些函数是"两台设备改同一条任务的不同字段、两边的改动都保留"的地基。
   任何一条走偏，症状都是**静默丢改动**（不报错、界面上看不出来），
   所以逐条钉死，包括脏数据与回落行为。
   ========================================================================= */

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: '数学真题',
    note: '',
    date: '2026-10-24',
    time: null,
    repeat: 'none',
    priority: 'medium',
    category: '学习',
    done: false,
    doneAt: null,
    parentId: null,
    estimatedMinutes: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('toMillis', () => {
  it('合法 ISO → 毫秒', () => {
    expect(toMillis('2026-10-24T10:00:00.000Z')).toBe(Date.parse('2026-10-24T10:00:00.000Z'));
  });

  it('非法 / 缺失 / 空串一律 0（NaN 绝不能漏进比较）', () => {
    expect(toMillis('')).toBe(0);
    expect(toMillis(null)).toBe(0);
    expect(toMillis(undefined)).toBe(0);
    expect(toMillis('不是时间')).toBe(0);
  });
});

describe('fieldClockOf', () => {
  it('有该字段的时钟 → 用它', () => {
    const t = task({ updatedAt: '2026-10-05T00:00:00.000Z', fieldAt: { title: '2026-10-03T00:00:00.000Z' } });
    expect(fieldClockOf(t, 'title')).toBe('2026-10-03T00:00:00.000Z');
  });

  it('没有该字段的时钟 → 回落到 createdAt（不是 updatedAt）', () => {
    const t = task({ updatedAt: '2026-10-05T00:00:00.000Z' });
    expect(fieldClockOf(t, 'title')).toBe('2026-10-01T00:00:00.000Z');
    expect(fieldClockOf(t, 'note')).toBe('2026-10-01T00:00:00.000Z');
  });

  it('时钟是脏值（非法 ISO）→ 同样回落，不吃脏值', () => {
    const t = task({ updatedAt: '2026-10-05T00:00:00.000Z', fieldAt: { title: '昨天' } });
    expect(fieldClockOf(t, 'title')).toBe('2026-10-01T00:00:00.000Z');
  });
});

describe('fullFieldClock', () => {
  it('把清单里每个字段都打上同一个时间', () => {
    const clock = fullFieldClock('2026-10-05T00:00:00.000Z');
    expect(Object.keys(clock).sort()).toEqual([...TASK_SYNC_FIELDS].sort());
    expect(new Set(Object.values(clock))).toEqual(new Set(['2026-10-05T00:00:00.000Z']));
  });
});

describe('stampChangedFields', () => {
  const NOW = '2026-10-24T10:00:00.000Z';

  it('改了标题 → 只给 title 打点', () => {
    const stamps = stampChangedFields(task(), task({ title: '英语真题', updatedAt: NOW }));
    expect(stamps).toEqual({ title: NOW });
  });

  it('同时改多个字段 → 每个都打点', () => {
    const stamps = stampChangedFields(
      task(),
      task({ title: '英语真题', note: '带解析', updatedAt: NOW }),
    );
    expect(stamps).toEqual({ title: NOW, note: NOW });
  });

  it('什么都没变 → null（绝不写时钟）', () => {
    expect(stampChangedFields(task(), task({ updatedAt: NOW }))).toBeNull();
  });

  it('endDate 的 undefined 与 null 视为同一态 → 不算改动', () => {
    const before = task();
    const after = { ...task({ updatedAt: NOW }), endDate: null };
    expect(stampChangedFields(before, after)).toBeNull();
  });

  it('勾选完成 → done 打点；doneAt 不在清单里（跟随 done，不单独打）', () => {
    const stamps = stampChangedFields(task(), task({ done: true, doneAt: NOW, updatedAt: NOW }));
    expect(stamps).toEqual({ done: NOW });
    expect(stamps).not.toHaveProperty('doneAt');
  });

  it('拖拽换日期 + 重排 → date 与 order 都打点', () => {
    const stamps = stampChangedFields(
      task({ order: 0 }),
      task({ date: '2026-10-25', order: 2, updatedAt: NOW }),
    );
    expect(stamps).toEqual({ date: NOW, order: NOW });
  });

  it('入参缺失（防御）→ null，不抛异常', () => {
    expect(stampChangedFields(null as unknown as Task, task())).toBeNull();
  });
});

describe('sanitizeFieldAt', () => {
  const OK = '2026-10-24T10:00:00.000Z';

  it('合法时钟原样保留（只留清单内的字段）', () => {
    expect(sanitizeFieldAt({ title: OK, note: OK })).toEqual({ title: OK, note: OK });
  });

  it('清单外的键丢弃（云端 / 手改备份可能带任意键）', () => {
    expect(sanitizeFieldAt({ title: OK, '<script>': OK, doneAt: OK })).toEqual({ title: OK });
  });

  it('非字符串 / 非法时间的项丢弃', () => {
    expect(sanitizeFieldAt({ title: 123, note: '不是时间', date: OK })).toEqual({ date: OK });
  });

  it('不是对象 / 全脏 → undefined（不写空对象，避免无意义 diff）', () => {
    expect(sanitizeFieldAt(null)).toBeUndefined();
    expect(sanitizeFieldAt('nope')).toBeUndefined();
    expect(sanitizeFieldAt([])).toBeUndefined();
    expect(sanitizeFieldAt({ title: 123 })).toBeUndefined();
  });
});
