import { FALLBACK_CATEGORY_NAME } from '../constants';
import { isValidDateKey } from './date';
import { clampEstimateMinutes } from './task';
import type { DateKey, Task, TimeKey, WeekPlanItem, WeekPlanTemplate } from '../types';

/* ============================================================================
   周计划模板（F3）
   ----------------------------------------------------------------------------
   用户场景：周日花 5 分钟把下周的骨架排好（"周一高数第三章、周二 STM32 中断…"），
   之后每天照单执行，而不是每天早上现想。

   幂等是这里的第一原则：**套用两次不能生成两份**。
   判据用「同一天 + 同标题 + 同分类」，而不是靠用户记住"我套过了吗"。
   ========================================================================= */

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const WEEK_LENGTH = 7;
/** 每天最多 12 条模板项：再多就不叫"骨架"了 */
export const WEEK_PLAN_MAX_PER_DAY = 12;
/** 标题上限（与任务标题一致的一档，短于任务是为了逼人写清一件事） */
export const WEEK_PLAN_TITLE_MAX = 60;

export function emptyWeekPlan(): WeekPlanTemplate {
  return { days: [[], [], [], [], [], [], []] };
}

function sanitizeItem(raw: unknown): WeekPlanItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const title = typeof rec.title === 'string' ? rec.title.trim() : '';
  if (!title) return null;
  const category =
    typeof rec.category === 'string' && rec.category.trim()
      ? rec.category.trim()
      : FALLBACK_CATEGORY_NAME;
  const time = typeof rec.time === 'string' && TIME_RE.test(rec.time) ? (rec.time as TimeKey) : null;
  return {
    title: title.slice(0, WEEK_PLAN_TITLE_MAX),
    category,
    time,
    estimatedMinutes: clampEstimateMinutes(rec.estimatedMinutes),
  };
}

/**
 * 清洗模板。非法项只丢自己、每天最多 12 条、星期下标越界的一律丢弃。
 * 返回 null 表示"没有模板"（与"有模板但某天为空"区分开）。
 */
export function sanitizeWeekPlanTemplate(raw: unknown): WeekPlanTemplate | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  if (!Array.isArray(rec.days)) return null;
  const days: WeekPlanItem[][] = [];
  for (let index = 0; index < WEEK_LENGTH; index += 1) {
    const list = rec.days[index];
    if (!Array.isArray(list)) {
      days.push([]);
      continue;
    }
    const items: WeekPlanItem[] = [];
    for (const item of list) {
      const clean = sanitizeItem(item);
      if (!clean) continue;
      items.push(clean);
      if (items.length >= WEEK_PLAN_MAX_PER_DAY) break;
    }
    days.push(items);
  }
  // 七天全空 = 没有模板（省掉一个空壳，也让 UI 判断更简单）
  if (days.every((list) => list.length === 0)) return null;
  return { days };
}

/** 模板里一共有多少条（用于 UI 摘要「共 8 条」） */
export function countWeekPlanItems(template: WeekPlanTemplate | null): number {
  if (!template) return 0;
  return template.days.reduce((sum, list) => sum + list.length, 0);
}

export interface WeekPlanTaskInput {
  title: string;
  date: DateKey;
  category: string;
  time: TimeKey | null;
  estimatedMinutes: number;
}

function weekdayOf(date: DateKey): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  return new Date(year, month - 1, day).getDay();
}

/**
 * 把模板展开成"要新建的任务"。
 *
 * @param days 要套用的那几天（周视图给出的 7 个 dateKey）
 * @param existing 现有任务（用来跳过已经存在的，保证幂等）
 *
 * 为什么在这里判重而不是生成后再删：重复生成会让「撤销」和「归档」都失真，
 * 而且用户看到的是"套一次冒出来两份"。判重必须在**生成之前**。
 */
export function weekPlanToTasks(
  template: WeekPlanTemplate | null,
  days: DateKey[],
  existing: Task[],
): WeekPlanTaskInput[] {
  if (!template || !Array.isArray(days)) return [];
  const taken = new Set<string>();
  for (const task of Array.isArray(existing) ? existing : []) {
    if (!task || typeof task !== 'object') continue;
    // 只把顶层任务算作"已存在"：子任务是步骤，不该挡住模板展开
    if (task.parentId) continue;
    taken.add(`${task.date}|${task.title}|${task.category ?? ''}`);
  }

  const out: WeekPlanTaskInput[] = [];
  for (const date of days) {
    if (!isValidDateKey(date)) continue;
    const items = template.days[weekdayOf(date)] ?? [];
    for (const item of items) {
      const key = `${date}|${item.title}|${item.category}`;
      if (taken.has(key)) continue;
      taken.add(key); // 同一天模板里若有两条一模一样，也只生成一条
      out.push({
        title: item.title,
        date,
        category: item.category,
        time: item.time,
        estimatedMinutes: item.estimatedMinutes,
      });
    }
  }
  return out;
}
