import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/* ============================================================================
   P1-3：列表行的 memo 必须真的能生效

   当时病症：任何一次全局 dispatch（包括 v0.11.0 新增的 60 秒一次后台同步
   HYDRATE）都会让整列任务重渲。根因不在 TaskRow 自己，而在它的父级
   `RowWithChildren` 收到了**整个 DayGroup** —— 那对象由 TodayView 的 useMemo
   产出，依赖 tasks/date/mode/category/stickyDoneIds 五个值，任一变化都重建。

   现在：RowWithChildren 自己 memo 化，props 只保留这一行真正用到的
   （task / children / isSticky / 三个稳定回调），空子任务用模块级常量。
   ========================================================================= */

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '');
}

const src = stripComments(readFileSync(new URL('../TaskList.tsx', import.meta.url), 'utf8'));

describe('列表行 memo（P1-3）', () => {
  it('RowWithChildren 被 memo 包裹', () => {
    expect(src).toContain('const RowWithChildren = memo(function RowWithChildren({');
  });

  it('行组件的 props 里不再有整个 group（那会让 memo 形同虚设）', () => {
    // 只看 RowWithChildrenProps 自己的声明块：TaskListProps 里当然还要 group
    const start = src.indexOf('interface RowWithChildrenProps');
    const block = src.slice(start, src.indexOf('}', start));
    expect(start).toBeGreaterThan(-1);
    expect(block).not.toContain('group');
    expect(src).not.toMatch(/group=\{group\}/);
    expect(src).toContain('children={group.childrenByParent[task.id] ?? NO_CHILDREN}');
  });

  it('空子任务数组用模块级常量（`?? []` 每次都是新引用，浅比较会失败）', () => {
    expect(src).toContain('const NO_CHILDREN: Task[] = [];');
    expect(src).not.toContain('?? []');
  });

  it('task 的类型不再借道 DayGroup["open"][number]（同义但更脆）', () => {
    expect(src).toContain('task: Task;');
  });
});
