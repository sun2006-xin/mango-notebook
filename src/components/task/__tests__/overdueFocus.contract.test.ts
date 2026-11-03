import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/* ============================================================================
   v0.9 议题 2 / 4：逾期区的 ▷ + 移动端不损失功能

   一、逾期区也要能起番茄
      逾期行是**未完成 + 顶层**的真实任务，"从昨天没做完的事直接开一个番茄钟"
      是最自然的路径。实现上必须与 TaskList **完全同款**，不允许另发明一套：
      - `useCallback` 稳住 handler（TaskRow 是 memo 的）；
      - 移动端（<640）不传（触屏没有 hover，那个悬浮按钮点不到）。

   二、移动端不损失功能（主理人裁定第 4 条）
      `TaskList` 在移动端不传 `onStartFocus` 是**故意的、要保留的**；
      功能没有丢，入口改走任务抽屉底部的「开始专注」。
      这里证明两条路径最终落到**同一个** `useTaskActions.startFocus`。
   ========================================================================= */

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '');
}

function read(rel: string): string {
  return stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'));
}

describe('逾期区 ▷：与 TaskRow / TaskList 同款机制', () => {
  const overdueSrc = read('../OverdueSection.tsx');
  const rowSrc = read('../TaskRow.tsx');
  const listSrc = read('../TaskList.tsx');
  const todaySrc = read('../../../views/TodayView.tsx');

  it('props 接口：onStartFocus 与 focusStats 都透传（与 TaskList 同名同形）', () => {
    expect(overdueSrc).toContain('onStartFocus?: (taskId: string) => void;');
    expect(overdueSrc).toContain('focusStats?: Map<string | null, TaskFocusStat>');
    // 与 TaskList 的签名逐字一致
    expect(listSrc).toContain('onStartFocus?: (id: string) => void;');
  });

  it('handler 用 useCallback 稳住引用 + 移动端不传（两条都必须，缺一不可）', () => {
    expect(overdueSrc).toContain('const handleStartFocus = useCallback(');
    expect(overdueSrc).toContain('onStartFocus && !isMobile ? handleStartFocus : undefined');
    // 与 TaskList 的写法完全同款（复制过来比对，防止有人"优化"掉其中一条）
    expect(listSrc).toContain('const handleStartFocus = useCallback(');
    expect(listSrc).toContain('onStartFocus && !isMobile ? handleStartFocus : undefined');
  });

  it('行内 ▷ 的最终判定仍然由 TaskRow 独占（未完成 + 顶层 + default 密度）', () => {
    expect(rowSrc).toContain('const focusable = Boolean(onStartFocus) && !task.parentId && !done && !compact;');
    // 逾期区用 default 密度（不传 density），所以 compact 那一条天然满足
    expect(overdueSrc).not.toContain("density=\"compact\"");
  });

  it('focusSummary 按 taskId 取（「专注 N 次 · X分钟」与待办行同源）', () => {
    expect(overdueSrc).toContain('focusSummary={focusStats?.get(task.id)}');
    expect(listSrc).toContain('focusSummary={focusStats?.get(task.id)}');
  });

  it('TodayView 真的把两者接下去了（否则组件写得再对也不生效）', () => {
    expect(todaySrc).toContain('onStartFocus={onRequestFocus ? actions.startFocus : undefined}');
    expect(todaySrc).toContain('focusStats={focusStats}');
    // OverdueSection 与 TaskList 拿到的是同一个 onStartFocus 表达式（两条入口一个实现）
    const hits = todaySrc.split('onStartFocus={onRequestFocus ? actions.startFocus : undefined}').length - 1;
    expect(hits).toBe(2);
  });

  it('逾期区拿到的必然都是未完成任务（▷ 不会出现在已完成行上）', () => {
    /**
     * 数据源头：getOverdueTasks 只取"最后一天已过 && 未完成"。
     * v0.22 起判据从 `t.date` 换成 `taskLastDate(t)` —— 多天任务按**结束日**逾期，
     * 否则一个 30 天的任务从第 2 天起就挂在逾期区，等于逼人拆任务。
     */
    const taskSrc = read('../../../lib/task.ts');
    expect(taskSrc).toContain('.filter((t) => taskLastDate(t) < today && !t.done)');
    // 且逾期区只收顶层任务
    expect(taskSrc).toContain('getOverdueTasks(tasks, today).filter((t) => !t.parentId');
  });
});

describe('移动端不损失功能：抽屉里的「开始专注」走同一条路径', () => {
  const appSrc = read('../../../App.tsx');
  const drawerSrc = read('../TaskDrawer.tsx');
  const actionsSrc = read('../../../hooks/useTaskActions.ts');

  it('抽屉底部有「开始专注」按钮（移动端的唯一入口）', () => {
    expect(drawerSrc).toContain('data-testid="drawer-start-focus"');
    expect(drawerSrc).toContain('onClick={onStartFocus}');
    expect(drawerSrc).toContain('{TEXT.startFocus}');
  });

  it('App 的抽屉 handler = 关抽屉 + actions.startFocus（与行内 ▷ 同一个函数）', () => {
    const start = appSrc.indexOf('const onDrawerStartFocus = useCallback(');
    expect(start).toBeGreaterThan(-1);
    const block = appSrc.slice(start, appSrc.indexOf('}, [actions, drawerTask]);', start));
    expect(block).toContain('actions.closeDrawer();');
    expect(block).toContain('actions.startFocus(drawerTask.id);');
    // 抽屉拿到的就是这条 handler
    expect(appSrc).toContain('onStartFocus={drawerTask ? onDrawerStartFocus : undefined}');
  });

  it('两条入口只有一个 startFocus 实现（不是各写一套）', () => {
    const hits = actionsSrc.split('const startFocus = useCallback(').length - 1;
    expect(hits).toBe(1);
    // 行内 ▷ → actions.startFocus；抽屉 → onDrawerStartFocus → actions.startFocus
    expect(appSrc).toContain('useTaskActions(today, { onRequestFocus: requestFocus })');
    expect(actionsSrc).toContain('onRequestFocusRef.current?.(taskId)');
    expect(actionsSrc).toContain("dispatch({ type: 'SET_VIEW', view: 'focus' })");
  });

  it('移动端隐藏 ▷ 不影响抽屉入口：TaskList 的裁剪只发生在 ▷ 这一条路径上', () => {
    // 唯一一处 isMobile 判定，且只用于 startFocusHandler
    const hits = (read('../TaskList.tsx').match(/isMobile/g) ?? []).length;
    expect(hits).toBe(2); // 解构一次 + 三元里用一次
    // 抽屉里没有"移动端才显示"的分支：按钮在两端都在
    expect(drawerSrc).not.toContain('isMobile');
  });

  it('抽屉的「专注 N 次」摘要也接上了（与行内同源：同一份 focusSessions）', () => {
    /**
     * v0.25 起抽屉**只算一条**：`focusStatsForTask(state.focusSessions, id)`，
     * 不再为一次抽屉去建 `focusStatsByTask` 的整张 Map（40 天会话 × 每次开抽屉）。
     * 数据源仍是同一份 focusSessions、聚合口径仍与行内一致 —— 这是"同源"的实质，
     * 否则抽屉会显示和待办行不一样的数字。
     */
    expect(appSrc).toContain('focusSummary={drawerFocusSummary}');
    expect(appSrc).toMatch(
      /const drawerFocusSummary = useMemo\([\s\S]{0,200}focusStatsForTask\(state\.focusSessions, drawerTask\.id\)/,
    );
    // 两个聚合函数同居 lib/focus，口径一处定义（不允许抽屉里另写一套统计）
    const focusSrc = read('../../../lib/focus.ts');
    expect(focusSrc).toContain('export function focusStatsByTask(');
    expect(focusSrc).toContain('export function focusStatsForTask(');
    // 且抽屉那条不能是全量 Map 的倒退
    expect(appSrc).not.toContain('focusStatsByTask');
  });
});
