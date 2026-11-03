import { useEffect, useMemo, useState } from 'react';
import { Segmented } from '../components/common/Segmented';
import { PomodoroPanelInner, ReminderPanel, StopwatchPanel } from '../components/focus/TimerPanels';
import { SessionRow, StatCard } from '../components/focus/FocusStats';
import { useToast } from '../hooks/useToast';
import { useAppDispatch, useAppState } from '../store/StoreContext';
import { addDays, formatDateTitle, startOfWeek } from '../lib/date';
import {
  buildFocusHeatmap,
  computeFocusStreak,
  focusByCategory,
  focusGoalHint,
  focusGoalProgress,
  formatFocusDuration,
  focusByTask,
  sumFocusMs,
  weeklyFocusMs,
} from '../lib/focus';
import type { TimerMode } from '../lib/timer';
import { loadFocusPrefs, loadRunningTimer, saveFocusPrefs, saveRunningTimer } from '../lib/storage';
import type { DateKey } from '../types';

export interface FocusViewProps {
  /** 当前真实今天（App 统一传入，视图自己不读时钟） */
  today: DateKey;
  /**
   * 从任务行 / 抽屉「开始专注」带过来的任务 id（F2 方案 B）。
   *
   * 它只是**一次性的启动意图**，不是"当前专注的任务"（那个真相在
   * FOCUS_RUNNING_KEY 里，由 useFocusTimer 自己读）。消费后必须由
   * `onAutoStartConsumed` 清掉，否则切走再切回来会重复开局。
   */
  pendingFocusTaskId?: string | null;
  /** 启动意图已消费（App 清掉 pending，防止重复 start） */
  onAutoStartConsumed?: () => void;
}

export function FocusView({
  today,
  pendingFocusTaskId = null,
  onAutoStartConsumed,
}: FocusViewProps) {
  const { focusSessions, settings, tasks } = useAppState();
  const dispatch = useAppDispatch();
  const toast = useToast();

  const [mode, setMode] = useState<TimerMode>(() => loadFocusPrefs().mode);

  /**
   * 带着"要专注的任务"进来时强制切到番茄钟（F2）。
   *
   * 只在真的带了任务 id 时动模式：普通点侧栏进专注页不该改变用户上次选的模式。
   * 切之前先清掉别的模式的运行态 —— 判定口径与 onModeChange **完全一致**
   * （模式不一致就清，不附加"只有在跑才清"的条件，理由见 onModeChange 的注释）。
   */
  useEffect(() => {
    if (!pendingFocusTaskId) return;
    if (mode === 'pomodoro') return;
    saveRunningTimer(null);
    setMode('pomodoro');
    saveFocusPrefs({ mode: 'pomodoro', reminderPresets: loadFocusPrefs().reminderPresets });
  }, [pendingFocusTaskId, mode]);

  /**
   * 切模式：只要残留的运行态**不是下一个模式**，就干净地清掉（杜绝静默丢失 / 串台）。
   *
   * ⚠️ 清理口径必须是"模式不一致"，不能再附加"只有在跑才清"一类的额外条件：
   * 暂停中的秒表只留在磁盘上（它的 running 为假），附加条件刚好把它漏掉，
   * 于是切到番茄钟后它被 useFocusTimer 当成番茄钟的 focus 段接走：
   * 面板直接显示"专注中"、倒计时 = focusMinutes − 秒表已走时间，点「结束并记录」
   * 还会用秒表的 id 写一条伪造的 FOCUS_LOG，并把秒表累计值连着抹掉。
   * 所以这里一个例外都不留，保留 toast 让用户知道上一个计时被停掉了。
   */
  const onModeChange = (next: TimerMode): void => {
    const current = loadRunningTimer();
    if (current && current.mode !== next) {
      saveRunningTimer(null);
      toast.show('已停止上一个计时');
    }
    setMode(next);
    saveFocusPrefs({ mode: next, reminderPresets: loadFocusPrefs().reminderPresets });
  };

  const weekStart = startOfWeek(today, settings.weekStart);
  const todayMs = useMemo(
    () => sumFocusMs(focusSessions.filter((s) => s.date === today)),
    [focusSessions, today],
  );
  const weekMs = useMemo(
    () => weeklyFocusMs(focusSessions, weekStart),
    [focusSessions, weekStart],
  );
  const streak = useMemo(() => computeFocusStreak(focusSessions, today), [focusSessions, today]);
  /**
   * 每日专注目标进度。
   * `goalMinutes === 0` 时整块不渲染 —— 不设目标就是不设，
   * 常驻一条"目标 0 分钟"只是噪音。
   */
  const goal = useMemo(
    () => focusGoalProgress(focusSessions, today, settings.dailyFocusGoalMinutes),
    [focusSessions, today, settings.dailyFocusGoalMinutes],
  );
  /**
   * 科目分布（F2）：最近 7 天各科目花了多少。
   * 数据来自 `session.category`（写入时冗余的），任务删了也不影响历史投入。
   */
  const byCategory = useMemo(
    () => focusByCategory(focusSessions, { from: addDays(today, -6), to: today }),
    [focusSessions, today],
  );
  const heatmap = useMemo(
    () => buildFocusHeatmap(focusSessions, today, 35),
    [focusSessions, today],
  );

  /** 今天的记录，新的在上 */
  const todaySessions = useMemo(
    () =>
      focusSessions
        .filter((s) => s.date === today)
        .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)),
    [focusSessions, today],
  );

  /** 时间都花在哪些任务上（本周口径，看趋势更准） */
  const byTask = useMemo(() => {
    const inWeek = focusSessions.filter((s) => s.date >= weekStart && s.date <= today);
    const rows = focusByTask(inWeek).slice(0, 5);
    return rows.map((row) => {
      const task = row.taskId ? tasks.find((t) => t.id === row.taskId) : null;
      return { ...row, title: task?.title ?? '自由专注', category: task?.category ?? null };
    });
  }, [focusSessions, weekStart, today, tasks]);

  const titleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const task of tasks) map.set(task.id, task.title);
    return map;
  }, [tasks]);

  const onDeleteSession = (id: string): void => {
    dispatch({ type: 'FOCUS_DELETE', id });
  };

  /** 热力图首行要空几格（让第一列恒为 weekStart 那天） */
  const padStart = heatmap.length === 0 ? 0 : (heatmap[0]!.weekday - settings.weekStart + 7) % 7;

  // 番茄钟面板需要 useFocusTimer；它只在 mode==='pomodoro' 时挂载，
  // 因此切走即卸载、切回即重新从设备本地接回（refresh 可恢复由此保证）
  const pomodoro =
    mode === 'pomodoro' ? (
      <PomodoroPanelInner
        focusMinutes={settings.focusMinutes}
        breakMinutes={settings.breakMinutes}
        autoStartTaskId={pendingFocusTaskId}
        onAutoStartConsumed={onAutoStartConsumed}
      />
    ) : null;

  return (
    <section aria-labelledby="focusTitle" className="flex flex-col">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 id="focusTitle" className="text-h1 font-bold leading-h1 tracking-[-0.02em]">
          专注
        </h1>
        <span className="text-label text-ink-2">{formatDateTitle(today)}</span>
      </div>

      {/* ---------- 模式切换 ---------- */}
      <div className="mt-4 flex justify-center">
        <Segmented<TimerMode>
          ariaLabel="切换计时模式"
          value={mode}
          onChange={onModeChange}
          options={[
            { value: 'pomodoro', label: '番茄钟' },
            { value: 'stopwatch', label: '秒表' },
            { value: 'reminder', label: '提醒' },
          ]}
        />
      </div>

      {/* ---------- 计时器面板（按模式） ---------- */}
      {pomodoro}
      {mode === 'stopwatch' ? <StopwatchPanel /> : null}
      {mode === 'reminder' ? <ReminderPanel /> : null}

      {/* ---------- 统计仪表盘：提醒模式不展示 ---------- */}
      {mode !== 'reminder' ? (
        <>
          {/* ---------- 三块指标 ---------- */}
          <div className="mt-6 grid grid-cols-3 gap-2">
            <StatCard label="今日" value={formatFocusDuration(todayMs)} testId="focus-today" />
            <StatCard label="本周" value={formatFocusDuration(weekMs)} testId="focus-week" />
            <StatCard
              label="连续"
              value={streak === 0 ? '—' : `${streak} 天`}
              testId="focus-streak"
              icon={streak > 0 ? 'flame' : undefined}
            />
          </div>

          {/* ---------- 每日专注目标（F11） ---------- */}
          {/*
            目标只在设了之后才出现。三件事一次说清：
            达成没有（文案 + 是否加勾）、还差多少（剩余分钟）、进度条。
            超额时百分比照实显示 130% —— 封顶成 100% 等于抹掉了"今天多学了一小时"。
          */}
          {goal.percent === null ? null : (
            <div className="mt-4 card px-4 py-3" data-testid="focus-goal">
              <div className="flex items-baseline gap-2">
                <span className="text-label text-ink-2">今日目标</span>
                <span className="tnum text-body-sm font-semibold text-ink">
                  {formatFocusDuration(goal.goalMinutes * 60000)}
                </span>
                <span
                  data-testid="focus-goal-percent"
                  className={`tnum ml-auto text-body-sm font-semibold ${
                    goal.reached ? 'text-accent' : 'text-ink-2'
                  }`}
                >
                  {goal.percent}%
                </span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-sunk">
                <span
                  className={`block h-full rounded-full ${goal.reached ? 'bg-accent' : 'bg-highlight'}`}
                  style={{ width: `${Math.min(100, Math.max(0, goal.percent))}%` }}
                />
              </div>
              <p className="mt-1.5 text-label text-ink-3" data-testid="focus-goal-hint">
                {focusGoalHint(goal)}
              </p>
            </div>
          )}

          {/* ---------- 科目分布（F2）：多线并行时看清时间去哪了 ---------- */}
          {byCategory.length > 0 ? (
            <div className="mt-6" data-testid="focus-by-category">
              <div className="flex items-baseline justify-between">
                <h2 className="text-body font-semibold">最近 7 天 · 各科目</h2>
                <span className="text-label text-ink-2">按任务分类汇总</span>
              </div>
              <ul className="mt-2 flex flex-col gap-2">
                {byCategory.slice(0, 5).map((item) => (
                  <li key={item.category} className="flex items-center gap-3">
                    <span className="w-16 shrink-0 truncate text-label text-ink">{item.category}</span>
                    <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-sunk">
                      <span
                        className="block h-full rounded-full bg-accent"
                        style={{ width: `${Math.round(item.ratio * 100)}%` }}
                      />
                    </span>
                    <span className="tnum w-16 shrink-0 text-right text-label text-ink-2">
                      {formatFocusDuration(item.ms)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* ---------- 热力图 ---------- */}
          <div className="mt-6">
            <div className="flex items-baseline justify-between">
              <h2 className="text-body font-semibold">最近 35 天</h2>
              <span className="text-label text-ink-2">颜色越深，学得越久</span>
            </div>
            <div className="mt-2 grid w-fit grid-cols-7 gap-1" data-testid="focus-heatmap">
              {Array.from({ length: padStart }).map((_, index) => (
                <span key={`pad-${index}`} aria-hidden="true" className="h-6 w-6" />
              ))}
              {heatmap.map((cell) => (
                <span
                  key={cell.date}
                  title={`${cell.date} · ${formatFocusDuration(cell.ms)}`}
                  aria-label={`${cell.date} 专注 ${formatFocusDuration(cell.ms)}`}
                  className={`h-6 w-6 rounded-sm ${
                    cell.level === 0
                      ? 'bg-surface-sunk'
                      : cell.level === 1
                        ? 'bg-accent/20'
                        : cell.level === 2
                          ? 'bg-accent/40'
                          : cell.level === 3
                            ? 'bg-accent/65'
                            : 'bg-accent'
                  }`}
                />
              ))}
            </div>
            <div className="mt-2 flex items-center gap-1 text-label text-ink-3">
              <span>少</span>
              <span className="h-3 w-3 rounded-sm bg-surface-sunk" />
              <span className="h-3 w-3 rounded-sm bg-accent/20" />
              <span className="h-3 w-3 rounded-sm bg-accent/40" />
              <span className="h-3 w-3 rounded-sm bg-accent/65" />
              <span className="h-3 w-3 rounded-sm bg-accent" />
              <span>多</span>
            </div>
          </div>

          {/* ---------- 本周时间去向 ---------- */}
          {byTask.length > 0 ? (
            <div className="mt-6">
              <h2 className="text-body font-semibold">本周时间去向</h2>
              <ul className="mt-2 flex flex-col gap-2">
                {byTask.map((row) => {
                  const percent = weekMs === 0 ? 0 : Math.round((row.ms / weekMs) * 100);
                  return (
                    <li key={row.taskId ?? 'free'} className="flex flex-col gap-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="min-w-0 truncate text-body-sm text-ink">{row.title}</span>
                        <span className="tnum shrink-0 text-label text-ink-2">
                          {formatFocusDuration(row.ms)}
                        </span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-sunk">
                        <div
                          className="h-full rounded-full bg-accent"
                          style={{ width: `${Math.max(2, percent)}%` }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          {/* ---------- 今日明细 ---------- */}
          <div className="mt-6">
            <div className="flex items-baseline justify-between">
              <h2 className="text-body font-semibold">今天的记录</h2>
              <span className="tnum text-label text-ink-2">{todaySessions.length} 段</span>
            </div>
            {todaySessions.length === 0 ? (
              <p className="mt-2 text-label text-ink-2">还没有记录。点上面的「开始专注」吧。</p>
            ) : (
              <ul className="mt-2 flex flex-col divide-y divide-line field">
 {todaySessions.map((session) => (
 <SessionRow
 key={session.id}
 session={session}
 title={
 session.taskId ? (titleById.get(session.taskId) ?? '已删除的任务') : '自由专注'
 }
 onDelete={() => onDeleteSession(session.id)}
 />
 ))}
 </ul>
 )}
 </div>
 </>
 ) : null}
 </section>
 );
}
