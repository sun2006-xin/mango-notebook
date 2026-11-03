import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/* ============================================================================
   长期迭代的**接线**契约（⑧ 周报自动生成 / ⑨ 任务拆解 / ⑩ 习惯与任务联动）

   三件事各自的逻辑都有单测（lib / store / hooks）。这里只钉"**有没有接上**"：
   功能写好但忘了挂载 / 忘了传 props，是最常见也最不报错的失败方式 ——
   代码全绿、测试全过，用户那边就是"点了没反应 / 从来没生成过"。

   用源码契约而不是渲染测试：这几个接线点分别在 App / 视图 / 组件三层，
   真的把它们渲染起来要拖进整个 store + 云同步 + 提醒调度，成本远大于收益。
   ========================================================================= */

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '');
}

function read(rel: string): string {
  return stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'));
}

const appSrc = read('../../App.tsx');
const diarySrc = read('../DiaryView.tsx');
const actionsSrc = read('../../hooks/useTaskActions.ts');
const drawerSrc = read('../../components/task/TaskDrawer.tsx');
const habitsSrc = read('../../components/settings/HabitsEditor.tsx');

describe('⑩ 习惯与任务联动', () => {
  it('App 挂载了 useHabitAutoTask（不挂 = 永远不会自动生成）', () => {
    expect(appSrc).toContain('useHabitAutoTask(today)');
  });

  it('设置页的习惯编辑器有「每天生成任务」开关', () => {
    expect(habitsSrc).toContain('data-testid="habit-auto-task"');
    // 整表替换：走 onChange 算新数组，不新造 action
    expect(habitsSrc).toContain('autoTask: value');
  });
});

describe('⑧ 周报自动生成', () => {
  it('App 挂载了 useWeeklyAutoReport', () => {
    expect(appSrc).toContain('useWeeklyAutoReport(today)');
  });

  it('日记页有自动生成开关，且接的是 SET_WEEKLY_AUTO_REPORT', () => {
    expect(diarySrc).toContain('data-testid="weekly-auto"');
    expect(diarySrc).toContain("type: 'SET_WEEKLY_AUTO_REPORT'");
  });

  /**
   * 手动写入那条路仍是唯一入口：自动生成只多一个触发点，
   * 不能把「写入本周日记」按钮挤掉（用户要补写历史周只能靠它）。
   */
  it('手动写入按钮仍然在', () => {
    expect(diarySrc).toContain('data-testid="weekly-write"');
  });
});

describe('⑨ 任务拆解', () => {
  it('动作层用 lib 的规则拆解（不在 hook 里另写一套）', () => {
    expect(actionsSrc).toContain('planBreakdown(');
    expect(actionsSrc).toContain('BreakdownResult');
  });

  it('App 把 breakdownTask 接到了抽屉的 onBreakdown', () => {
    expect(appSrc).toContain('actions.breakdownTask(');
    expect(appSrc).toContain('onBreakdown={onBreakdown}');
  });

  it('抽屉里按钮存在，且只在顶层任务上出现（子任务不能再拆）', () => {
    expect(drawerSrc).toContain('data-testid="subtask-breakdown"');
    const section = drawerSrc.slice(drawerSrc.indexOf('onAddSubtask && !task.parentId'));
    expect(section).toContain('SubtaskSection');
  });
});
