import { useCallback, useRef } from 'react';
import { TEXT, TOAST_TIMEOUT } from '../constants';
import { planBreakdown } from '../lib/breakdown';
import type { BreakdownResult } from '../lib/breakdown';
import { formatDateTitle, nextOccurrence, nowIso } from '../lib/date';
import { createTask, getOverdueTasks, isSameRepeatOccurrence, normalizeParentId } from '../lib/task';
import { loadRunningTimer } from '../lib/storage';
import { useAppDispatch, useAppState } from '../store/StoreContext';
import type { DateKey, Task } from '../types';
import { useToast } from './useToast';

/* ============================================================================
   任务动作编排（App / TodayView / 后续 WeekView 共用同一套实现）

   为什么是 hook 而不是从 App 往下传 props：
   - 视图按 §5.3 不接收业务 props；而这几个动作（创建/勾选/删除/移动）在
     今日视图、逾期区、全局键盘三处都要用，靠 props 透传会穿透 3 层；
   - Toast 的**渲染与撤销执行**仍在 App（它挂唯一一条 <Toast> 并处理 onAction），
     这里只负责"构造 undoPayload 并 show"，职责不冲突。
   ========================================================================= */

export interface TaskActions {
  /**
   * 新增（当前选中日）。
   * 第二个参数是「预计用时（分钟）」，**不传 / 非法 = 0（未估时）**。
   */
  /**
   * 新增任务。
   *
   * `patch` 是给「自然语言速记」用的：`明天9点 高数 p1` 解析出来的日期 /
   * 时间 / 优先级 / 重复 / 分类从这里进来，避免为了加一张表单而重写创建链路。
   * id / createdAt / updatedAt 由 createTask 决定，patch 覆盖不了它们。
   */
  addTask: (title: string, estimatedMinutes?: number, patch?: Partial<Task>) => void;  /**
   * 在某条任务下新增子任务。
   * 子任务继承父任务的 date（显示在同一个日期下），分类/时间则回落默认 ——
   * 子任务是"步骤"，不需要自己再选一次日期。
   */
  addSubtask: (parentId: string, title: string) => void;
  /**
   * 把一条任务按规则拆成子任务（长期迭代「任务拆解」）。
   *
   * 返回值交给界面显示"**怎么**拆的"：
   * 这条不是装饰 —— 拆错了要手动删四次才回到原状，所以必须让用户看见依据。
   * `added === 0` 表示一步都没加（已经拆过了 / 标题为空），`reason` 说明原因。
   * 任务不存在、或目标本身是子任务（只准一层）时返回 `null`。
   */
  breakdownTask: (id: string) => BreakdownResult | null;
  /** 勾选/取消勾选（同帧写 doneAt + updatedAt，并进入 sticky） */
  toggleTask: (id: string) => void;
  /** 打开抽屉 */
  openTask: (id: string) => void;
  /** 关闭抽屉（焦点归还在 App 里按 returnFocusId 处理） */
  closeDrawer: () => void;
  /** 删除（带 5s 撤销） */
  deleteTask: (id: string) => void;
  /** 逾期批量移到今天（带撤销） */
  moveOverdueToToday: () => void;
  /** 抽屉内六个字段的即时 patch */
  patchDrawerTask: (patch: Partial<Task>) => void;
  /** 抽屉底部「删除任务」 */
  deleteDrawerTask: () => void;
  /** 抽屉底部「标记完成 / 取消完成」 */
  toggleDrawerTask: () => void;
  /** 回收站：恢复一条已删任务（同时清掉它的墓碑） */
  restoreFromTrash: (id: string) => void;
  /** 回收站：清空（不可逆，墓碑没了对端就不会再跟着删） */
  clearTrash: () => void;
  /**
   * 从任务行 / 抽屉「开始专注」（F2 方案 B）。
   *
   * 只做**并发防护 + 切视图**，不自己造计时器：
   * 番茄钟实例仍然只在 FocusView 里挂（`useFocusTimer` 内部与实例化位置一律不动）。
   * 真正的"开局"由 FocusView 收到 `pendingFocusTaskId` 后调一次 `timer.start(taskId)`。
   */
  startFocus: (taskId: string) => void;
}

/**
 * `useTaskActions` 的可选注入项（不传也能用，只是「开始专注」退化为仅切视图）
 */
export interface TaskActionsOptions {  /**
   * 把"要开始专注的任务"交给 App（它持有 `pendingFocusTaskId` 与 SET_VIEW）。
   * 用回调注入而不是让本 hook 去 import App：hook 不该知道视图状态住哪儿。
   */
  onRequestFocus?: (taskId: string) => void;
}

export function useTaskActions(today: DateKey, options: TaskActionsOptions = {}): TaskActions {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const toast = useToast();
  const { tasks, settings, ui } = state;

  /**
   * `tasks` 的**影子引用**。
   *
   * ⚠️ 这几个动作（勾选 / 删除 / 加子任务 / 批量移今天）需要在回调里**读**任务
   * （拿 title 做 Toast、拿 repeat 生成下一周期、拿 index 做撤销），
   * 但如果把 `tasks` 写进 `useCallback` 的依赖，那么**任何一条任务变化都会换掉
   * 这些函数的引用** → 传给被 memo 的 `RowWithChildren` / `TaskRow` →
   * 每勾一次整列表重渲（列表越长越明显）。
   *
   * 用 ref 读、依赖里不写，引用就恒定了，而读到的永远是最新那一版
   * （回调是事件处理器，执行时 ref 早已被上一次渲染刷新）。
   * 这是"依赖数组与读取路径分离"的常规做法，不是绕过：这些回调从不参与渲染。
   */
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;

  /**
   * `settings` 的影子引用，理由同上：
   * 拆解时要读 `focusMinutes`（没估时的任务按一个番茄一步），但它变了不该
   * 换掉 `breakdownTask` 的引用 —— 传给抽屉的 props 越稳，重渲越少。
   * 读的仍然是最新那一版（回调是事件处理器，执行时 ref 已被本次渲染刷新）。
   */
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  /** 用 ref 存回调：让 startFocus 的依赖稳定，不会每次渲染都换一个新函数 */
  const onRequestFocusRef = useRef(options.onRequestFocus);
  onRequestFocusRef.current = options.onRequestFocus;

  const addTask = useCallback(
    (title: string, estimatedMinutes?: number, patch?: Partial<Task>) => {
      const date = patch?.date ?? settings.lastSelectedDate;
      try {
        // createTask 负责 trim/截断/日期校验 + 估时夹紧（0–9999）
        // 标题为空会抛 EmptyTitleError（已在 QuickAdd 拦掉）
        const base = createTask({ title, date, estimatedMinutes }, nowIso(), date);
        // patch 只补充字段，不能改身份（id / createdAt 一律以 createTask 为准）
        const task = patch
          ? { ...base, ...patch, id: base.id, createdAt: base.createdAt }
          : base;
        dispatch({ type: 'TASK_ADD', task });
      } catch {
        /* 兜底：不弹错，用户再输入一次即可 */
      }
    },
    [dispatch, settings.lastSelectedDate],
  );

  const addSubtask = useCallback(
    (parentId: string, title: string) => {
      const parent = tasksRef.current.find((t) => t.id === parentId);
      if (!parent) return;
      // 只准一层：父本身是子任务时，新子任务挂到它父上（与自己同级）
      const realParentId = normalizeParentId(tasksRef.current, parentId);
      if (realParentId === null) return;
      try {
        const task = createTask({ title, date: parent.date }, nowIso(), parent.date);
        dispatch({ type: 'TASK_ADD', task: { ...task, parentId: realParentId } });
      } catch {
        /* 标题为空等，直接忽略 */
      }
    },
    [dispatch],
  );

  /**
   * 拆解（长期迭代）。规则在 `lib/breakdown`，这里只负责"落成子任务"。
   *
   * 三条纪律：
   * - **只给顶层任务拆**：子任务不能再挂子任务（只准一层）。目标本身是子任务
   *   时 `normalizeParentId` 会给出它的父 id —— 那就等于跟它同级，语义不对，
   *   所以直接返回 null（界面那边这个按钮本来也不显示）。
   * - **按标题去重**：同一批步骤已经存在就跳过，所以连点两次不会出两份。
   * - 时长保留：每步带自己的估时，合计刚好等于父任务的估时（`distribute` 保证），
   *   所以拆完「今日预算」不会凭空变多。
   */
  const breakdownTask = useCallback(
    (id: string): BreakdownResult | null => {
      const task = tasksRef.current.find((t) => t.id === id);
      if (!task || task.parentId) return null;

      const plan = planBreakdown({
        title: task.title,
        note: task.note,
        estimatedMinutes: task.estimatedMinutes,
        focusMinutes: settingsRef.current.focusMinutes,
      });
      if (plan.steps.length === 0) return { added: 0, reason: plan.reason };

      const existing = new Set(
        tasksRef.current.filter((t) => t.parentId === id).map((t) => t.title),
      );
      const steps = plan.steps.filter((step) => !existing.has(step.title));
      if (steps.length === 0) return { added: 0, reason: '这几步都已经有了，没有再加' };

      const now = nowIso();
      let added = 0;
      for (const step of steps) {
        try {
          const child = createTask(
            { title: step.title, date: task.date, estimatedMinutes: step.estimatedMinutes },
            now,
            task.date,
          );
          dispatch({ type: 'TASK_ADD', task: { ...child, parentId: id } });
          added += 1;
        } catch {
          /* 单条失败不该挡住其余步骤 */
        }
      }
      return { added, reason: plan.reason };
    },
    [dispatch],
  );

  const toggleTask = useCallback(
    (id: string) => {
      const task = tasksRef.current.find((t) => t.id === id);
      const now = nowIso();
      dispatch({ type: 'TASK_TOGGLE', id, now });

      // 勾完成 + 是重复任务 → 当场生成下一周期的那一份
      if (task && !task.done && task.repeat !== 'none') {
        const nextDate = nextOccurrence(task.date, task.repeat, today);
        /**
         * 下一周期"同款"任务已存在就不再生成（防连点 / 网络延迟重放）。
         *
         * ⚠️ 只比 title 是**不够**的：同一天可以有两条同名重复任务
         * （「跑步」07:00 每天 + 「跑步」20:00 每天）。勾完 07:00 那条会生成
         * 明天 07:00 的；再勾 20:00 那条时，只比 title 会命中刚才生成的那条，
         * 判定"已存在"直接跳过 —— 20:00 这条重复链从此断掉，且悄无声息。
         * 所以时间 / 分类 / 优先级一起比。
         *
         * 真正的根治是给任务加 `seriesId`（重复链 id），去重按 `seriesId + date`；
         * 那要动持久化字段与迁移链，留作后续（见 docs 的已知取舍）。
         */
        const candidate = nextDate ? { ...task, date: nextDate } : null;
        const exists =
          candidate !== null &&
          tasksRef.current.some((t) => !t.done && isSameRepeatOccurrence(t, candidate));
        if (nextDate && !exists) {
          try {
            const next = createTask(
              {
                title: task.title,
                note: task.note,
                date: nextDate,
                time: task.time,
                repeat: task.repeat,
                priority: task.priority,
                category: task.category,
                // 估时跟着重复任务一起走：每天同一件事的用时基本一样，
                // 丢了它会让"今日预算"在每个重复任务上都少算一段
                estimatedMinutes: task.estimatedMinutes,
              },
              now,
              nextDate,
            );
            dispatch({ type: 'TASK_ADD', task: next });
            toast.show(`已生成下一次 · ${formatDateTitle(nextDate)}`, null, TOAST_TIMEOUT.info);
          } catch {
            /* 生成失败不影响这次勾选本身 */
          }
        }
      }
    },
    [dispatch, today, toast],
  );

  const openTask = useCallback(
    (id: string) => {
      dispatch({ type: 'OPEN_DRAWER', taskId: id, returnFocusId: id });
    },
    [dispatch],
  );

  const closeDrawer = useCallback(() => {
    dispatch({ type: 'CLOSE_DRAWER' });
  }, [dispatch]);

  const deleteTask = useCallback(
    (id: string) => {
      const index = tasksRef.current.findIndex((task) => task.id === id);
      if (index < 0) return;
      const snapshot = tasksRef.current[index] as Task;
      // 带 now：删除要落成墓碑，对端同步时才知道这条是被删的，而不是"从来没有过"
      dispatch({ type: 'TASK_DELETE', id, now: new Date().toISOString() });
      toast.show(
        `已删除「${snapshot.title}」`,
        { label: '撤销', undo: { kind: 'delete', task: snapshot, index } },
        TOAST_TIMEOUT.undo,
      );
    },
    [dispatch, toast],
  );

  const moveOverdueToToday = useCallback(() => {
    const overdue = getOverdueTasks(tasksRef.current, today);
    if (overdue.length === 0) return;
    // endDate 也要记：批量平移会把多天任务整体搬走，撤销得能搬回去
    const moves = overdue.map((task) => ({
      id: task.id,
      from: task.date,
      endDate: task.endDate ?? null,
    }));
    dispatch({
      type: 'TASK_MOVE_TO_TODAY',
      ids: moves.map((move) => move.id),
      targetDate: today,
      now: nowIso(),
    });
    toast.show(
      `已把 ${moves.length} 项移到今天`,
      { label: '撤销', undo: { kind: 'move-to-today', moves } },
      TOAST_TIMEOUT.undo,
    );
  }, [dispatch, toast, today]);

  const patchDrawerTask = useCallback(
    (patch: Partial<Task>) => {
      if (!ui.drawerTaskId) return;
      dispatch({ type: 'TASK_PATCH', id: ui.drawerTaskId, patch, now: nowIso() });
    },
    [dispatch, ui.drawerTaskId],
  );

  const deleteDrawerTask = useCallback(() => {
    if (ui.drawerTaskId) deleteTask(ui.drawerTaskId);
  }, [deleteTask, ui.drawerTaskId]);

  const toggleDrawerTask = useCallback(() => {
    if (ui.drawerTaskId) toggleTask(ui.drawerTaskId);
  }, [toggleTask, ui.drawerTaskId]);

  const restoreFromTrash = useCallback(
    (id: string) => {
      dispatch({ type: 'TOMBSTONE_RESTORE', id, now: nowIso() });
      toast.show('已恢复', null, TOAST_TIMEOUT.info);
    },
    [dispatch, toast],
  );

  const clearTrash = useCallback(() => {
    dispatch({ type: 'TOMBSTONE_CLEAR' });
    toast.show('回收站已清空', null, TOAST_TIMEOUT.info);
  }, [dispatch, toast]);

  /**
   * 任务 → 专注一键开始（F2 方案 B）。
   *
   * 三种分支，**互斥且都以磁盘上的真实运行态为准**：
   * ① 已经在专注这一项 → 只切视图 + 提示"继续专注中"（不重复 start，
   *    否则会凭空多开一段，时间统计翻倍）；
   * ② 正在专注别的（任务不同，或根本是秒表 / 提醒）→ 只提示，**不切视图、
   *    不写磁盘、不覆盖**别人的运行态（覆盖 = 静默抹掉用户正在计的时间）；
   * ③ 什么都没在跑 → 把 taskId 交给 App，由它切到专注页并让番茄钟开局。
   *
   * 判据用 `loadRunningTimer()`（读磁盘单 key）而不是内存里的某个 state：
   * 三套计时器共用那一个 key，它天然就是"当前有没有人在计时"的唯一真相，
   * 也天然互斥。
   */
  const startFocus = useCallback(
    (taskId: string) => {
      const running = loadRunningTimer();

      if (running) {
        if (running.mode === 'pomodoro' && running.taskId === taskId) {
          dispatch({ type: 'SET_VIEW', view: 'focus' });
          toast.show(TEXT.focusContinuing, null, TOAST_TIMEOUT.info);
          return;
        }
        toast.show(TEXT.focusBusy, null, TOAST_TIMEOUT.info, 'warn');
        return;
      }

      onRequestFocusRef.current?.(taskId);
      dispatch({ type: 'SET_VIEW', view: 'focus' });
    },
    [dispatch, toast],
  );

  return {
    addTask,
    addSubtask,
    breakdownTask,
    toggleTask,
    openTask,
    closeDrawer,
    deleteTask,
    moveOverdueToToday,
    patchDrawerTask,
    deleteDrawerTask,
    toggleDrawerTask,
    restoreFromTrash,
    clearTrash,
    startFocus,
  };
}
