import { useMemo, useState } from 'react';
import { WEEK_PLAN_MAX_PER_DAY, WEEK_PLAN_TITLE_MAX, countWeekPlanItems } from '../../lib/weekPlan';
import { clampEstimateMinutes } from '../../lib/task';
import type { Category, WeekPlanItem, WeekPlanTemplate } from '../../types';

/* ============================================================================
   周计划模板编辑器（F3）

   设计取舍：**一次只编辑一天**。
   七天摊开成一屏会让「周日花 5 分钟排下周」变成"面对一大张表"，反而更慢。
   选一天 → 加几条 → 切下一天，节奏像写清单而不是填表单。
   ========================================================================= */

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

export interface WeekPlanEditorProps {
  template: WeekPlanTemplate | null;
  categories: Category[];
  onAdd: (weekday: number, item: WeekPlanItem) => void;
  onRemove: (weekday: number, index: number) => void;
}

export function WeekPlanEditor({ template, categories, onAdd, onRemove }: WeekPlanEditorProps) {
  /** 默认停周一：用户排的是"下周的工作日"，从周一开刀最自然 */
  const [weekday, setWeekday] = useState(1);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState(categories[0]?.name ?? '');
  const [time, setTime] = useState('');
  const [minutes, setMinutes] = useState('');

  const items = useMemo(() => template?.days[weekday] ?? [], [template, weekday]);
  const total = useMemo(() => countWeekPlanItems(template), [template]);
  const dayCount = (index: number): number => template?.days[index]?.length ?? 0;

  const submit = (): void => {
    const trimmed = title.trim();
    if (!trimmed || items.length >= WEEK_PLAN_MAX_PER_DAY) return;
    onAdd(weekday, {
      title: trimmed.slice(0, WEEK_PLAN_TITLE_MAX),
      category: category || (categories[0]?.name ?? ''),
      time: /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : null,
      estimatedMinutes: clampEstimateMinutes(minutes ? Number(minutes) : 0),
    });
    setTitle('');
    setTime('');
    setMinutes('');
  };

  return (
    <div data-testid="week-plan-editor">
      <div className="flex flex-wrap items-baseline gap-2">
        <div className="text-body font-semibold">周计划模板</div>
        <span className="text-label text-ink-2">
          {total === 0 ? '还没配置 · 配好之后在周视图一键展开' : `共 ${total} 条 · 周视图可一键套用`}
        </span>
      </div>

      {/* 星期选择：带条数角标，一眼看出哪天还没排 */}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {WEEKDAY_LABELS.map((label, index) => {
          const active = index === weekday;
          const count = dayCount(index);
          return (
            <button
              key={label}
              type="button"
              data-testid={`week-plan-day-${index}`}
              aria-pressed={active}
              onClick={() => setWeekday(index)}
              className={`btn h-9 min-w-11 shrink-0 px-2 text-label ${
                active ? 'btn-primary' : 'btn-outlined'
              }`}
            >
              周{label}
              {count > 0 ? <span className="tnum ml-1 opacity-70">{count}</span> : null}
            </button>
          );
        })}
      </div>

      {/* 当前天的条目 */}
      {items.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-1.5">
          {items.map((item, index) => (
            <li
              key={`${item.title}-${index}`}
              className="flex items-center gap-2 field bg-surface-sunk px-3 py-2"
 >
 <span className="min-w-0 flex-1 truncate text-body-sm text-ink">{item.title}</span>
              <span className="shrink-0 text-label text-ink-3">
                {[item.category, item.time, item.estimatedMinutes > 0 ? `${item.estimatedMinutes}min` : '']
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              <button
                type="button"
                aria-label={`删除 周${WEEKDAY_LABELS[weekday]} 的 ${item.title}`}
                onClick={() => onRemove(weekday, index)}
                className="grid h-11 w-11 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-danger/10 hover:text-danger"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-label text-ink-3">周{WEEKDAY_LABELS[weekday]}还没有条目</p>
      )}

      {/* 添加一行 */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          data-testid="week-plan-title"
          value={title}
          maxLength={WEEK_PLAN_TITLE_MAX}
          placeholder={`周${WEEKDAY_LABELS[weekday]}要固定做什么`}
          aria-label="模板条目标题"
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submit();
            }
          }}
          className="h-10 min-w-0 flex-1 field px-3 text-body-sm text-ink"
 />
 <select
 value={category}
 aria-label="模板条目分类"
 onChange={(event) => setCategory(event.target.value)}
 className="h-10 shrink-0 field px-2 text-body-sm text-ink"
 >
 {categories.map((item) => (
 <option key={item.id} value={item.name}>
 {item.name}
 </option>
 ))}
 </select>
 <input
 type="time"
 value={time}
 aria-label="模板条目时间"
 onChange={(event) => setTime(event.target.value)}
 className="h-10 w-28 shrink-0 field px-2 text-body-sm text-ink"
 />
 <input
 type="number"
 min={0}
 max={9999}
 value={minutes}
 placeholder="分钟"
 aria-label="模板条目预计用时"
 onChange={(event) => setMinutes(event.target.value)}
 className="tnum h-10 w-20 shrink-0 field px-2 text-body-sm text-ink"
 />
 <button
 type="button"
 data-testid="week-plan-add"
 onClick={submit}
 disabled={!title.trim() || items.length >= WEEK_PLAN_MAX_PER_DAY}
 className="btn btn-outlined h-10 shrink-0 disabled:opacity-40"
        >
          添加
        </button>
      </div>
    </div>
  );
}
