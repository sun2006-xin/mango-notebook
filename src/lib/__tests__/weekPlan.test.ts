import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../../constants';
import { sanitizeSettings } from '../storage';
import {
  WEEK_PLAN_MAX_PER_DAY,
  countWeekPlanItems,
  sanitizeWeekPlanTemplate,
  weekPlanToTasks,
} from '../weekPlan';
import { reducer } from '../../store/reducer';
import type { AppState, Task, WeekPlanItem, WeekPlanTemplate } from '../../types';

/* ============================================================================
   F3 周计划模板

   第一原则是**幂等**：套用两次不能生成两份。
   判据「同一天 + 同标题 + 同分类」—— 用户不该需要记住"我套过了吗"。
   ========================================================================= */

const MONDAY = '2026-10-26'; // 2026-10-29 是周四，所以 26 号是周一
const WEEK = [
  '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29',
  '2026-10-30', '2026-10-31', '2026-11-01',
];

function item(title: string, over: Partial<WeekPlanItem> = {}): WeekPlanItem {
  return { title, category: '学习', time: null, estimatedMinutes: 30, ...over };
}

/** days[0]=周日 … days[1]=周一 */
function template(byWeekday: Record<number, WeekPlanItem[]>): WeekPlanTemplate {
  const days: WeekPlanItem[][] = [[], [], [], [], [], [], []];
  for (const [key, items] of Object.entries(byWeekday)) days[Number(key)] = items;
  return { days };
}

function task(id: string, date: string, title: string, category = '学习', parentId: string | null = null): Task {
  return {
    id, title, note: '', date, time: null, repeat: 'none', priority: 'medium',
    category, done: false, doneAt: null,
    createdAt: `${date}T00:00:00.000Z`, updatedAt: `${date}T00:00:00.000Z`, parentId,
  } as Task;
}

function state(over: Partial<AppState['settings']> = {}, tasks: Task[] = []): AppState {
  return {
    tasks, notes: [], diary: [], tombstones: [], focusSessions: [],
    settings: { ...createDefaultSettings('2026-10-29'), ...over },
    ui: { hydrating: false } as unknown as AppState['ui'],
  } as AppState;
}

describe('sanitizeWeekPlanTemplate', () => {
  it('非对象 / 缺 days → null（= 没配过）', () => {
    expect(sanitizeWeekPlanTemplate(null)).toBeNull();
    expect(sanitizeWeekPlanTemplate({})).toBeNull();
  });

  it('七天全空 → null（不留空壳）', () => {
    expect(sanitizeWeekPlanTemplate({ days: [[], [], [], [], [], [], []] })).toBeNull();
  });

  it('非法项只丢自己；空标题的直接丢', () => {
    const out = sanitizeWeekPlanTemplate({
      days: [[item('有效')], [{ title: '   ' }, { title: null }], [], [], [], [], []],
    });
    expect(countWeekPlanItems(out)).toBe(1);
  });

  it('每天最多 12 条（再多就不叫"骨架"了）', () => {
    const many = Array.from({ length: 30 }, (_, index) => item(`t${index}`));
    const out = sanitizeWeekPlanTemplate({ days: [many, [], [], [], [], [], []] });
    expect(out?.days[0]).toHaveLength(WEEK_PLAN_MAX_PER_DAY);
  });

  it('非法时间被清成 null，分类为空时回落兜底分类', () => {
    const out = sanitizeWeekPlanTemplate({
      days: [[{ title: 'a', category: '', time: '25:99', estimatedMinutes: -5 }], [], [], [], [], [], []],
    });
    expect(out?.days[0][0].time).toBeNull();
    expect(out?.days[0][0].category).toBeTruthy();
    expect(out?.days[0][0].estimatedMinutes).toBe(0);
  });
});

describe('weekPlanToTasks：按星期落到对应日期', () => {
  it('周一的条目只落在周一', () => {
    const out = weekPlanToTasks(template({ 1: [item('高数')] }), WEEK, []);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ title: '高数', date: MONDAY });
  });

  it('周日（day 0）落在周末最后一天', () => {
    const out = weekPlanToTasks(template({ 0: [item('复盘')] }), WEEK, []);
    expect(out[0].date).toBe('2026-11-01');
  });

  it('幂等：同一天已有同标题同分类 → 不再生成', () => {
    const tpl = template({ 1: [item('高数')] });
    const existing = [task('t1', MONDAY, '高数', '学习')];
    expect(weekPlanToTasks(tpl, WEEK, existing)).toEqual([]);
  });

  it('同标题不同分类视为不同条目（用户可能上午学、下午复）', () => {
    const tpl = template({ 1: [item('高数', { category: '复习' })] });
    const existing = [task('t1', MONDAY, '高数', '学习')];
    expect(weekPlanToTasks(tpl, WEEK, existing)).toHaveLength(1);
  });

  it('子任务不参与判重（子任务是步骤，不该挡住模板展开）', () => {
    const tpl = template({ 1: [item('高数')] });
    const existing = [task('child', MONDAY, '高数', '学习', 'parent')];
    expect(weekPlanToTasks(tpl, WEEK, existing)).toHaveLength(1);
  });

  it('没有模板 → 空数组', () => {
    expect(weekPlanToTasks(null, WEEK, [])).toEqual([]);
  });
});

describe('reducer：模板增删与套用', () => {
  it('WEEK_PLAN_ADD 往指定星期追加', () => {
    const s1 = reducer(state(), { type: 'WEEK_PLAN_ADD', weekday: 2, item: item('STM32') });
    expect(s1.settings.weekPlanTemplate?.days[2]).toHaveLength(1);
  });

  it('WEEK_PLAN_REMOVE 删到空 → 模板变 null', () => {
    const s0 = state({ weekPlanTemplate: template({ 1: [item('高数')] }) });
    const s1 = reducer(s0, { type: 'WEEK_PLAN_REMOVE', weekday: 1, index: 0 });
    expect(s1.settings.weekPlanTemplate).toBeNull();
  });

  it('WEEK_PLAN_APPLY 生成任务，第二次调用返回同一个 state（幂等）', () => {
    const s0 = state({ weekPlanTemplate: template({ 1: [item('高数')], 3: [item('优题库')] }) });
    const s1 = reducer(s0, { type: 'WEEK_PLAN_APPLY', days: WEEK, now: '2026-10-29T10:00:00.000Z' });
    expect(s1.tasks).toHaveLength(2);

    const s2 = reducer(s1, { type: 'WEEK_PLAN_APPLY', days: WEEK, now: '2026-10-29T10:01:00.000Z' });
    expect(s2).toBe(s1); // 一条都没加 → 原样返回，不写盘不推送
  });
});

describe('sanitizeSettings：模板能活过冷启动', () => {
  it('模板原样保留', () => {
    const out = sanitizeSettings({ weekPlanTemplate: template({ 1: [item('高数')] }) });
    expect(countWeekPlanItems(out.weekPlanTemplate)).toBe(1);
  });

  it('缺失 → null', () => {
    expect(sanitizeSettings({}).weekPlanTemplate).toBeNull();
  });
});
