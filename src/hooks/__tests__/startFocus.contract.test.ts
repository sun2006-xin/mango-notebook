import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadRunningTimer, saveRunningTimer } from '../../lib/storage';
import { reducer, createEmptyState } from '../../store/reducer';
import type { FocusSession } from '../../types';

/* ============================================================================
   F2 任务 ↔ 专注一键闭环（方案 B：pendingFocusTaskId + 切视图）

   方案 B 的全部安全性押在一件事上：**并发防护的判据是磁盘上的单 key**
   （`loadRunningTimer()` → FOCUS_RUNNING_KEY）。三套计时器共用它，
   所以它天然互斥、也天然是"当前有没有人在计时"的唯一真相。
   本文件两头都验：
   - 源码级：三个分支的判定顺序与副作用边界（③ 分支不许写磁盘 / 不许切视图）；
   - 行为级：单 key 的互斥性真的成立（写第二个就覆盖第一个 → 不可能是"两段同时跑"）。
   ========================================================================= */

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '');
}

function read(rel: string): string {
  return stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'));
}

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
}

let store: MemoryStorage;

beforeEach(() => {
  store = new MemoryStorage();
  vi.stubGlobal('localStorage', store);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('startFocus：三个分支', () => {
  const src = read('../../hooks/useTaskActions.ts');

  it('用磁盘运行态做判据（loadRunningTimer），不是内存里的某个 state', () => {
    expect(src).toContain('const running = loadRunningTimer();');
  });

  it('① 已在专注同一项 → 只切视图 + 提示"继续专注中"，不重复 start', () => {
    expect(src).toContain("running.mode === 'pomodoro' && running.taskId === taskId");
    expect(src).toContain('TEXT.focusContinuing');
  });

  it('② 正在专注别的 → 只提示，不切视图、不写磁盘、不覆盖', () => {
    const busyIdx = src.indexOf('TEXT.focusBusy');
    expect(busyIdx).toBeGreaterThan(-1);
    // 取 busy 分支到它的 return 之间这段，确认没有任何副作用
    const tail = src.slice(busyIdx, src.indexOf('return;', busyIdx));
    expect(tail).not.toContain('SET_VIEW');
    expect(tail).not.toContain('saveRunningTimer');
    expect(tail).not.toContain('start(');
  });

  it('③ 什么都没跑 → 交意图给 App 并切到专注页', () => {
    expect(src).toContain('onRequestFocusRef.current?.(taskId)');
    expect(src).toContain("dispatch({ type: 'SET_VIEW', view: 'focus' })");
  });

  it('hook 不自己造计时器（useFocusTimer 的实例化位置不动）', () => {
    expect(src).not.toContain('useFocusTimer');
  });
});

describe('单 key = 唯一真相：互斥性来自磁盘', () => {
  const running = (taskId: string | null) => ({
    mode: 'pomodoro' as const,
    id: `id-${taskId ?? 'free'}`,
    taskId,
    startedAt: '2026-10-24T09:00:00.000Z',
    phase: 'focus' as const,
    accumulatedMs: 0,
    running: true,
    durationMs: 0,
  });

  it('写入第二条就覆盖第一条（不可能出现"两段同时跑"）', () => {
    saveRunningTimer(running('t1'));
    expect(loadRunningTimer()?.taskId).toBe('t1');
    saveRunningTimer(running('t2'));
    expect(loadRunningTimer()?.taskId).toBe('t2');
  });

  it('clear 之后读回 null（切模式 / 结束时的清理口径）', () => {
    saveRunningTimer(running('t1'));
    saveRunningTimer(null);
    expect(loadRunningTimer()).toBeNull();
  });

  it('已有别的模式在跑时，番茄钟不会把它接走（apply 判据是 mode）', () => {
    saveRunningTimer({ ...running('t1'), mode: 'stopwatch', phase: 'focus' });
    const loaded = loadRunningTimer();
    expect(loaded?.mode).toBe('stopwatch');
    // startFocus 的判定：mode 不是 pomodoro → 走"正在专注另一项"分支
    expect(loaded && loaded.mode === 'pomodoro').toBe(false);
  });
});

describe('结束时的记录必须挂在该任务上', () => {
  it('FOCUS_LOG 保留 taskId（否则任务行上的「专注 N 次」永远是 0）', () => {
    const session: FocusSession = {
      id: 'f1',
      taskId: 't1',
      date: '2026-10-24',
      startedAt: '2026-10-24T09:00:00.000Z',
      endedAt: '2026-10-24T09:25:00.000Z',
      durationMs: 25 * 60_000,
    };
    const state = reducer(createEmptyState(), { type: 'FOCUS_LOG', session });
    expect(state.focusSessions[0]?.taskId).toBe('t1');
  });
});

describe('任务行 / 列表 / 抽屉的渲染条件', () => {
  const rowSrc = read('../../components/task/TaskRow.tsx');

  it('▷ 只在"顶层 + 未完成 + default 密度 + 有 handler"时出现', () => {
    expect(rowSrc).toContain('const focusable = Boolean(onStartFocus) && !task.parentId && !done && !compact;');
  });

  it('▷ 位置在「…」左侧（right-11），hover 浮现', () => {
    expect(rowSrc).toContain('right-11');
    expect(rowSrc).toContain('group-hover:opacity-100');
    expect(rowSrc).toContain('data-testid={`task-focus-${task.id}`}');
  });

  /**
   * v1.0（任务估时）口径变更：行内摘要从「专注 N 次 · X 分钟」改成
   * `专注 50min · 预计 30min`（用户裁决：统一走「分钟」）。
   * 这条断言跟着改，但守的还是同一个底线：**两段都按条件出现，且不挤行**。
   * 次数没有丢 —— 它被搬进 `title` / `aria-label`（看得到、不占行宽）。
   */
  it('「专注 50min · 预计 30min」两段按条件出现，且不在移动端挤行', () => {
    // 专注段：只有真专注过（count > 0）才出现
    expect(rowSrc).toContain('focusSummary && focusSummary.count > 0');
    // 预计段：只有 estimatedMinutes > 0 才出现（0 = 未估时）
    expect(rowSrc).toContain('task.estimatedMinutes > 0');
    // 两段用 ' · ' 连接；compact（周视图列）整段不显示
    expect(rowSrc).toContain("const summaryText = compact ? '' : summaryParts.join(' · ');");
    // 都没有 → 整段不渲染（不占位）
    expect(rowSrc).toContain('{summaryText ? (');
    expect(rowSrc).toContain('md:inline');
  });

  const listSrc = read('../../components/task/TaskList.tsx');

  it('TaskList 用 useCallback 稳住 handler（TaskRow 是 memo），移动端直接不传', () => {
    expect(listSrc).toContain('const handleStartFocus = useCallback(');
    expect(listSrc).toContain('onStartFocus && !isMobile ? handleStartFocus : undefined');
  });

  const drawerSrc = read('../../components/task/TaskDrawer.tsx');

  it('抽屉底部有「开始专注」（移动端入口）+ 摘要', () => {
    expect(drawerSrc).toContain('data-testid="drawer-start-focus"');
    expect(drawerSrc).toContain('TEXT.startFocus');
    expect(drawerSrc).toContain('focusSummary');
  });
});

describe('App / FocusView 的接线', () => {
  const appSrc = read('../../App.tsx');

  it('App 持有 pendingFocusTaskId，并在切视图时清掉', () => {
    expect(appSrc).toContain('const [pendingFocusTaskId, setPendingFocusTaskId] = useState<string | null>(null);');
    expect(appSrc).toContain('useTaskActions(today, { onRequestFocus: requestFocus })');
    const onViewChangeIdx = appSrc.indexOf('const onViewChange = useCallback(');
    const block = appSrc.slice(onViewChangeIdx, onViewChangeIdx + 400);
    expect(block).toContain('setPendingFocusTaskId(null)');
  });

  it('FocusView 收到 pendingFocusTaskId 与 onAutoStartConsumed', () => {
    expect(appSrc).toContain('pendingFocusTaskId={pendingFocusTaskId}');
    expect(appSrc).toContain('onAutoStartConsumed={clearPendingFocus}');
  });

  const focusSrc = read('../../views/FocusView.tsx');

  it('带着任务进来时强制切番茄钟，且先清掉别的模式的运行态', () => {
    expect(focusSrc).toContain('if (mode === \'pomodoro\') return;');
    expect(focusSrc).toContain('saveRunningTimer(null)');
    expect(focusSrc).toContain("setMode('pomodoro')");
  });

  /**
   * 消费点（`timer.start(autoStartTaskId)`）在 v0.29.6 跟着 `PomodoroPanelInner`
   * 一起搬到了 `components/focus/TimerPanels.tsx`（FocusView 746 行拆成三个文件）。
   * 断言内容不变，只换扫描目标 —— 搬家最容易丢的就是这类契约。
   */
  const panelsSrc = read('../../components/focus/TimerPanels.tsx');

  it('自动开局**只在 PomodoroPanelInner 消费一次**', () => {
    const hits = panelsSrc.split('timer.start(autoStartTaskId)').length - 1;
    expect(hits).toBe(1);
    expect(panelsSrc).toContain('consumedRef.current === autoStartTaskId');
    expect(panelsSrc).toContain('onAutoStartConsumed?.()');
    // 外壳里不许再出现第二个消费点
    expect(focusSrc).not.toContain('timer.start(autoStartTaskId)');
  });
});
