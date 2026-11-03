import { describe, expect, it } from 'vitest';
import { addMonthsKey, advanceRepeat, nextOccurrence } from '../date';
import { createTask, EmptyTitleError } from '../task';
import { sanitizeTasks } from '../storage';

/* ============================================================================
   重复任务：日期推进 + 老数据兼容

   落点：① 月末推进不能溢出到次月（1/31 + 1 月 = 2/28，不是 3/3）；
   ② 下一次出现的日期不许落在过去（否则"每天"任务三天没碰就生成一堆逾期）；
   ③ 老任务没有 repeat 字段必须兼容，不能因为读旧数据就崩。
   ========================================================================= */

describe('advanceRepeat', () => {
  it('每天 +1 天', () => {
    expect(advanceRepeat('2026-10-24', 'daily')).toBe('2026-10-25');
  });

  it('每周 +7 天（跨月也对）', () => {
    expect(advanceRepeat('2026-10-28', 'weekly')).toBe('2026-11-04');
  });

  it('每月同一天', () => {
    expect(advanceRepeat('2026-10-24', 'monthly')).toBe('2026-11-24');
  });

  it("'none' 与非法值原样返回", () => {
    expect(advanceRepeat('2026-10-24', 'none')).toBe('2026-10-24');
  });
});

describe('addMonthsKey 月末不溢出', () => {
  it('1月31日 + 1月 → 2月28日（不变成 3月3日）', () => {
    expect(addMonthsKey('2026-01-31', 1)).toBe('2026-02-28');
  });

  it('闰年：2028年1月31日 + 1月 → 2月29日', () => {
    expect(addMonthsKey('2028-01-31', 1)).toBe('2028-02-29');
  });

  it('跨年：12月15日 + 1月 → 次年1月15日', () => {
    expect(addMonthsKey('2026-12-15', 1)).toBe('2027-01-15');
  });
});

describe('nextOccurrence 不许落在过去', () => {
  it("'每天'任务落在 3 天前 → 推到今天，而不是生成一份昨天的", () => {
    expect(nextOccurrence('2026-10-21', 'daily', '2026-10-24')).toBe('2026-10-24');
  });

  it("'每周'任务落在上周 → 一路 +7 推到今天之后", () => {
    // 2026-10-18 是周日，+7=10-25（周一）≥ 10-24
    expect(nextOccurrence('2026-10-18', 'weekly', '2026-10-24')).toBe('2026-10-25');
  });

  it("'每月'任务落在上月 → 推到本月", () => {
    expect(nextOccurrence('2026-09-24', 'monthly', '2026-10-24')).toBe('2026-10-24');
  });

  it('本来就在未来 → 只推进一次', () => {
    expect(nextOccurrence('2026-10-24', 'daily', '2026-10-24')).toBe('2026-10-25');
  });

  it("'none' 没有下一次", () => {
    expect(nextOccurrence('2026-10-24', 'none', '2026-10-24')).toBeNull();
  });
});

describe('老任务兼容（repeat 缺省 none）', () => {
  it('sanitizeTasks：没有 repeat 字段的旧任务 → none，不丢其它字段', () => {
    const result = sanitizeTasks([
      {
        id: 'a1',
        title: '旧任务',
        note: '',
        date: '2026-10-24',
        time: null,
        priority: 'high',
        category: '学习',
        done: false,
        doneAt: null,
        createdAt: 'x',
        updatedAt: 'x',
        parentId: null,
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.repeat).toBe('none');
    expect(result[0]?.title).toBe('旧任务');
  });

  it('sanitizeTasks：repeat 是非法值 → 回落 none', () => {
    const result = sanitizeTasks([
      { id: 'a1', title: 'x', note: '', date: '2026-10-24', time: null, repeat: 'yearly', priority: 'medium', category: '学习', done: false, doneAt: null, createdAt: 'x', updatedAt: 'x' },
    ]);
    expect(result[0]?.repeat).toBe('none');
  });

  it('sanitizeTasks：合法的 repeat 原样保留', () => {
    const result = sanitizeTasks([
      { id: 'a1', title: 'x', note: '', date: '2026-10-24', time: null, repeat: 'weekly', priority: 'medium', category: '学习', done: false, doneAt: null, createdAt: 'x', updatedAt: 'x' },
    ]);
    expect(result[0]?.repeat).toBe('weekly');
  });
});

describe('createTask 的 repeat', () => {
  it('不传 → none', () => {
    expect(createTask({ title: 'x' }, '2026-10-24T00:00:00.000Z', '2026-10-24').repeat).toBe('none');
  });

  it('传合法值 → 保留', () => {
    expect(createTask({ title: 'x', repeat: 'monthly' }, '2026-10-24T00:00:00.000Z', '2026-10-24').repeat).toBe('monthly');
  });

  it('传非法值 → 回落 none（不抛）', () => {
    expect(
      createTask({ title: 'x', repeat: 'hourly' as unknown as 'daily' }, '2026-10-24T00:00:00.000Z', '2026-10-24').repeat,
    ).toBe('none');
  });

  it('标题为空仍然抛 EmptyTitleError（repeat 不影响标题校验）', () => {
    expect(() => createTask({ title: '   ', repeat: 'daily' }, '2026-10-24T00:00:00.000Z', '2026-10-24')).toThrow(EmptyTitleError);
  });
});
