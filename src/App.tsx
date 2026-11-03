import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import { TOAST_TIMEOUT } from './constants';
import { Toast } from './components/common/Toast';
import { UpdateBanner } from './components/common/UpdateBanner';
import { WindowChrome, TITLE_BAR_HEIGHT } from './components/common/WindowChrome';
import { desktopBridge } from './lib/update';
import { MobileTabBar, Sidebar } from './components/layout/Nav';
import { TaskDrawer } from './components/task/TaskDrawer';
import { useHotkeys } from './hooks/useHotkeys';
import { useKeyboard } from './hooks/useKeyboard';
import { useAutoBackup } from './hooks/useAutoBackup';
import { useAutoSync } from './hooks/useAutoSync';
import { useHabitAutoTask } from './hooks/useHabitAutoTask';
import { useWeeklyAutoReport } from './hooks/useWeeklyAutoReport';
import { buildPersistedPayload, usePersist } from './hooks/usePersist';
import { useTaskActions } from './hooks/useTaskActions';
import { useTheme } from './hooks/useTheme';
import { useReminders } from './hooks/useReminders';
import { useNoteReminders } from './hooks/useNoteReminders';
import { useReminderWatcher } from './hooks/useReminderWatcher';
import { useToast } from './hooks/useToast';
import { formatDateTitle, formatRelativeDay, nowIso, todayKey } from './lib/date';
import {
  getLocalSavedAt,
  setCloudErrorHandler,
  setCloudMergeHandler,
} from './lib/cloudSync';
import { focusStatsForTask } from './lib/focus';
import { migrate } from './lib/storage';
import { getChildTasks, getDayProgress } from './lib/task';
import { hydrateFromPayload } from './store/reducer';
import { useAppDispatch, useAppState } from './store/StoreContext';
import type { DateKey, PersistedPayload, ViewId } from './types';
import { CalendarView } from './views/CalendarView';
import { DiaryView } from './views/DiaryView';
import { NotesView } from './views/NotesView';
import { FocusView } from './views/FocusView';
import { SettingsView } from './views/SettingsView';
import { TodayView } from './views/TodayView';
import { TrashView } from './views/TrashView';
import { WeekView } from './views/WeekView';
import { ReviewView } from './views/ReviewView';
import { SearchOverlay } from './components/common/SearchOverlay';

/**
 * 每 60s 检查一次跨天：变了才 set，避免渲染期反复读时钟（§5.4）。
 * `dayStartHour` 参与计算并进依赖：用户在设置里把日界从 0 改成 4，
 * 今天必须立刻重算（03:00 会从"明天"退回"昨天"），不能等下一次 setInterval。
 */
function useToday(dayStartHour: number): string {
  const [today, setToday] = useState<string>(() => todayKey(dayStartHour));
  useEffect(() => {
    const sync = (): void => {
      setToday((prev) => {
        const next = todayKey(dayStartHour);
        return prev === next ? prev : next;
      });
    };
    sync();
    const timer = setInterval(sync, 60_000);
    return () => clearInterval(timer);
  }, [dayStartHour]);
  return today;
}

/* ============================================================================
   渲染期异常的最后一道兜底

   为什么必须有这一层：
   `renderMarkdown(draft)` 是在**渲染期同步求值**的（DiaryView / NotesView 的
   dangerouslySetInnerHTML），而日记与笔记会经云同步从别的设备过来 ——
   一篇内容不讲理（例如几千个 `>`）就能让它抛 RangeError。
   没有边界时，一次抛异常会让整棵 React 树卸载＝**白屏**，
   用户连"切到别的视图 / 把那段内容改回来"的入口都没有。

   有了边界，异常降级成一张"内容无法显示"的卡片，并给出两个可恢复入口：
   - 重试：重置边界、重渲染子树（改过内容即可恢复）；
   - 重新加载：任何情况下都留一条回到应用的路。
   本机数据不受影响（它没有参与这次渲染的写盘）。
   ========================================================================= */

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  error: Error | null;
}

class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null };

  /** 渲染期抛异常 → 切到降级 UI（必须设在 state 里，不能在这.side effect 里做） */
  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  /** 只记录 Error 本身，不记录 props / state 原文 —— 里面可能有用户写的日记 */
  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[芒果本本] 界面渲染出错，已降级显示：', error?.message ?? error);
    if (info?.componentStack) console.error(info.componentStack);
  }

  private readonly retry = (): void => {
    this.setState({ error: null });
  };

  private readonly reload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-paper px-6 py-12">
        <div className="w-full max-w-content card px-6 py-8 text-center">
          <div className="text-h2 font-bold text-ink">内容无法显示</div>
          <p className="mt-2 text-body-sm leading-relaxed text-ink-2">
            界面渲染时出错了，已经被安全拦下 —— 你的数据没有被改动，仍在本机。
            <br />
            如果某篇日记 / 记事的写法比较特殊（比如大量引用符号），可以先改掉那段再重试。
          </p>
          {error.message ? (
            <p className="mt-3 break-all rounded-md bg-paper px-3 py-2 text-label text-ink-3">
              {error.message}
            </p>
          ) : null}
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            <button type="button" onClick={this.retry} className="btn btn-primary">
              重试
            </button>
            <button type="button" onClick={this.reload} className="btn btn-outlined">
              重新加载
            </button>
          </div>
        </div>
      </div>
    );
  }
}

/**
 * 应用壳（M2-6 完整装配）：
 * 四档视图 switch + 导航双形态 + 任务抽屉 + 全局键盘 + Toast 编排（删除/移动撤销）
 * + 主题解析 + 防抖持久化 + 抽屉关闭后的焦点归还。
 *
 * 外层由 AppErrorBoundary 包住：子树任何渲染期异常都降级成一张卡片，而不是白屏。
 */
function AppShell() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const toast = useToast();

  const { settings, ui, tasks } = state;
  // 日界由设置决定，必须在 useToday 之前拿到
  const today = useToday(settings.dayStartHour);
  const view = settings.lastView;
  /** 后台合并要用**当前**视图（effect 依赖里不放 view，否则每次切页都重注册回调） */
  const viewRef = useRef(view);
  viewRef.current = view;
  /** 同理：后台合并要知道"这一刻有没有尚未落盘的编辑"（见下面的守卫） */
  const saveStateRef = useRef(state.ui.saveState);
  saveStateRef.current = state.ui.saveState;

  /**
   * 「开始专注」的启动意图（F2 方案 B）。
   *
   * 为什么是"意图 + 切视图"而不是在任务行直接开计时器：
   * `useFocusTimer` 只在 FocusView 里挂载（它的实例化位置是红线，不动）。
   * 所以这里只记下"要给哪个任务开局"，切到专注页后由 PomodoroPanelInner
   * 一次性消费；消费完立刻清空，防止切走再切回来重复开局。
   *
   * 并发防护（已在跑别的 / 已在跑同一项）在 useTaskActions.startFocus 里做，
   * 判据是磁盘上的 FOCUS_RUNNING_KEY —— 那是三套计时器唯一的真相，天然互斥。
   */
  const [pendingFocusTaskId, setPendingFocusTaskId] = useState<string | null>(null);
  const requestFocus = useCallback((taskId: string) => setPendingFocusTaskId(taskId), []);
  const clearPendingFocus = useCallback(() => setPendingFocusTaskId(null), []);

  const actions = useTaskActions(today, { onRequestFocus: requestFocus });

  useTheme(settings.theme);

  // 到期提醒：开关在设置里；权限没拿到时静默不弹，不影响其它功能
  useReminders(today, tasks, settings.remindEnabled);

  /**
   * 笔记闹钟（到点响铃，但**不进复习队列**）。
   * 复用同一个「到期提醒」总开关，不新增开关 —— 两个开关管同一件事
   * （要不要打扰我），分开放只会让用户困惑。
   */
  useNoteReminders(state.notes, settings.remindEnabled);

  // 自定义时长提醒到点 watcher：常驻、与视图无关，切走其它视图到点仍响
  useReminderWatcher();

  useKeyboard({
    onToggleRow: actions.toggleTask,
    onOpenRow: actions.openTask,
    onDeleteRow: actions.deleteTask,
    onCloseDrawer: actions.closeDrawer,
  });

  const onPersistError = useCallback(
    (reason: 'quota' | 'unavailable' | 'unknown') => {
      const message =
        reason === 'quota'
          ? '本地空间不足，数据未能保存'
          : reason === 'unavailable'
            ? '当前环境不支持本地存储，数据未能保存'
            : '数据未能保存';
      toast.show(message, null, TOAST_TIMEOUT.error, 'danger');
    },
    [toast],
  );
  usePersist({ onError: onPersistError });

  /**
   * 后台自动同步（App 级常驻）：启动拉一次 + 每 60s 拉一次 + 切回前台/联网时补拉。
   *
   * 没有它时，另一台设备的改动**只有这一台也改了东西**才会被拉下来 ——
   * 用户看到的就是"同步有时候不管用"。详见 hooks/useAutoSync.ts。
   *
   * 取"本机现在是什么样"用 getter：state 每次 render 都是新对象，
   * 直接传值会让 hook 里的 effect 反复重建（它内部用 ref 接住，这里配合即可）。
   */
  const getLocalForSync = useCallback((): PersistedPayload | null => {
    /**
     * 只读模式（装载超时）：本机这份"空"不是真实的空，绝不能拿去和云端对账。
     * 返回 null 会让 runSync 判成"本机没有数据"——只读恢复方向，不上推。
     */
    if (state.ui.persistBlocked) return null;
    const savedAt = getLocalSavedAt();
    // 本机从未落盘 + 一条数据都没有 = 新设备：交给 runSync 判成"从云端恢复"，
    // 绝不能把空数据推上去盖掉云端。判据与设置页「立即同步」一致。
    if (savedAt === null && state.tasks.length === 0) return null;

    const payload = buildPersistedPayload(state);
    /**
     * ⚠️ `savedAt` 必须是**本机上次真正落盘的时间**，不能是"现在"。
     *
     * `mergeSnapshots` 用 `local.savedAt >= remote.savedAt` 判 `localNewer`，
     * 而 `buildPersistedPayload` 里的 savedAt 是 `new Date()` —— 于是每次同步
     * 本机都"比云端新"，`base` 永远取本机 settings：另一台设备改的日界 /
     * 默认视图 / 周起始日 / 分类顺序**永远传不过来**，还会被本机覆盖回去。
     *
     * 用真实落盘时间之后语义才正确：这台没动过 → 云端更新 → 云端设置生效；
     * 这台刚改过 → 本机更新 → 本机设置生效。
     * 设置页「立即同步」早就是这么做的（`getLocalSavedAt() ?? now`），此处对齐。
     */
    return savedAt ? { ...payload, savedAt } : payload;
  }, [state]);
  useAutoSync(getLocalForSync);

  /**
   * 桌面端自动备份：启动写一份当天备份 + 每小时查跨天。
   * 网页 / 安卓没有文件写权限，靠 storage.ts 的双快照（SNAPSHOT + PREV）兜底，
   * 这个 hook 在那边是一个空操作（内部先探测 window.desktopBackup）。
   */
  useAutoBackup(today);

  /**
   * 长期迭代的两条"到点自动做"：
   * - 习惯 → 今日任务（开了开关的习惯，每天第一次打开时列进待办）；
   * - 自动周报（每周第一次打开时把上一周写进日记）。
   *
   * 都放在 App 里而不是各视图里：它们跟"现在在看哪一页"无关，
   * 挂视图上会变成"必须先去日记页才生成周报"。
   */
  useHabitAutoTask(today);
  useWeeklyAutoReport(today);

  /**
   * 代码块「复制」按钮（F11）：**事件委托**挂在 document 上。
   *
   * 为什么不给按钮写内联 onclick：Markdown 渲染器只产出 HTML 字符串，
   * 让它去引用全局函数等于把一份脚本塞进内容层。委托放在 App 里，
   * 渲染器保持纯函数、可单测。
   */
  useEffect(() => {
    const onClick = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null;
      const button = target?.closest?.('[data-md-copy]');
      if (!button) return;
      const code = button.closest('.md-code')?.querySelector('code')?.textContent ?? '';
      if (!code) return;
      const clipboard = navigator.clipboard;
      if (!clipboard || typeof clipboard.writeText !== 'function') {
        toast.show('当前环境不支持复制，请手动选择', null, TOAST_TIMEOUT.info, 'warn');
        return;
      }
      void clipboard.writeText(code).then(
        () => toast.show('已复制', null, TOAST_TIMEOUT.info),
        () => toast.show('复制失败，请手动选择', null, TOAST_TIMEOUT.info, 'warn'),
      );
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [toast]);

  /**
   * 桌面端"换了端口"的告知（数据安全）。
   *
   * 本地服务的首选端口绑不上时会退到备用端口，而 localStorage 按【协议+域+端口】
   * 隔离 —— 换了端口就等于换了一个站点：**数据没删，但读不到**，
   * 登录态同样读不到。用户看到的是"数据没了 + 要重新登录"，很容易误判成丢数据。
   *
   * 所以这里明确说一句，并给出唯一的自救路径（导入备份 / 覆盖安装同一版）。
   */
  useEffect(() => {
    const api = window.desktopWindow;
    if (!api || typeof api.getState !== 'function') return;
    void api
      .getState()
      .then((state) => {
        if (!state?.storageDegraded) return;
        toast.show(
          '本次启动换了本地数据目录：旧数据与登录态可能读不到（数据仍在，未删除）。请用「设置 → 导入备份」找回',
          null,
          TOAST_TIMEOUT.error,
          'warn',
        );
      })
      .catch(() => {
        /* 问不到就算了，不能在启动时抛错 */
      });
  }, [toast]);

  /**
   * 桌面端全局快捷键（Ctrl+Shift+Space）：回到今日页。
   *
   * 主进程负责把窗口叫回前台（最小化就还原），这里只负责"落在哪一页"——
   * 主进程不该知道视图枚举，渲染层也别去碰窗口。
   * 网页 / 安卓没有这个桥，整段是空操作。
   */
  useEffect(() => {
    const unsubscribe = window.desktopWindow?.onQuickAdd?.(() => {
      dispatch({ type: 'SET_VIEW', view: 'today' });
    });
    return () => unsubscribe?.();
  }, [dispatch]);

  // 后台自动同步的失败也要让用户看见（不静默失败）；失败不影响本机数据
  useEffect(() => {
    setCloudErrorHandler((message) => {
      toast.show(message, null, TOAST_TIMEOUT.info, 'warn');
    });
    return () => setCloudErrorHandler(null);
  }, [toast]);

  // 后台自动推送合并进了云端独有的任务 → 把合并结果 hydrate 回本机，
  // 两台设备以此收敛（只在内容有差异时触发，不会与保存形成环）
  useEffect(() => {
    setCloudMergeHandler((payload) => {
      /**
       * ⚠️ 正在保存（300ms 防抖窗口内）就**跳过这次回灌**。
       *
       * 否则云端内容会盖掉本机还没落盘的那一次编辑 —— 用户敲完字的一瞬间
       * 恰好赶上 60 秒轮询的自动同步，修改就没了。跳过之后云端那份还在，
       * 下一次同步（≤60 秒）自然会再拉下来，不丢东西。
       */
      if (saveStateRef.current === 'saving') return;

      const migrated = migrate(payload);
      if (!migrated) return;
      /**
       * 走 hydrateFromPayload 这个唯一出口。
       * 曾经这里是手写的 HYDRATE 字面量，加 tombstones / focusSessions 时漏了它 ——
       * 合并刚算出来的"删除"结论被丢掉，下一次保存又把任务写回去，
       * 对端再删一次，两边永远收敛不了（比"复活"更难查的 churn）。
       *
       * ⚠️ 但**后台合并绝不抢用户正在看的页面**：
       * 云端的 settings.lastView 是"另一台设备最后停在哪个页面"。
       * 自动同步现在每 60 秒跑一次，把它原样灌进来 = 写日记写到一半被拽到专注页。
       * 用户主动点「立即同步」时不走这里（设置页自己 hydrate），那条路径才该跟着云端走。
       */
      dispatch(
        hydrateFromPayload(
          { ...migrated, settings: { ...migrated.settings, lastView: viewRef.current } },
          null,
        ),
      );
    });
    return () => setCloudMergeHandler(null);
  }, [dispatch]);

  // 启动时的存储异常只提示一次
  const reportedRef = useRef(false);
  useEffect(() => {
    if (!ui.storageError || reportedRef.current) return;
    reportedRef.current = true;
    toast.show(ui.storageError, null, TOAST_TIMEOUT.error, 'warn');
  }, [toast, ui.storageError]);

  // 抽屉关闭后把焦点还给原任务行（该行可能已换日期，退化为首个任务行）
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const open = ui.drawerTaskId !== null;
    if (wasOpenRef.current && !open) {
      const id = ui.drawerReturnFocusId;
      const target = id
        ? document.querySelector<HTMLElement>(`[data-task-id="${id}"]`)
        : null;
      const fallback = document.querySelector<HTMLElement>('[data-task-id]');
      (target ?? fallback)?.focus();
    }
    wasOpenRef.current = open;
  }, [ui.drawerTaskId, ui.drawerReturnFocusId]);

  const onViewChange = useCallback(
    (next: ViewId) => {
      /**
       * 切视图时清掉"待开局"的意图：用户点了 ▷ 之后又自己点了别的导航，
       * 那个意图就作废了 —— 否则下次进专注页会莫名其妙自己开始计时。
       * 注意 startFocus 内部是直接 dispatch SET_VIEW（不走这里），
       * 所以"▷ → 专注页"这条路径上的 pending 不会被自己清掉。
       */
      setPendingFocusTaskId(null);
      dispatch({ type: 'SET_VIEW', view: next });
    },
    [dispatch],
  );

  /**
   * 退出复习会话 → 回今日。
   * 目标视图由 App 决定（ReviewView 只管"我要退出"），
   * 这样将来想改成"回到进入复习前的视图"只需改这一处。
   */
  const exitReview = useCallback(() => {
    dispatch({ type: 'SET_VIEW', view: 'today' });
  }, [dispatch]);

  /* ---------- 全局搜索 ---------- */
  const [searchOpen, setSearchOpen] = useState(false);
  const closeSearch = useCallback(() => setSearchOpen(false), []);

  // Ctrl/Cmd+K 打开搜索（浮层自己处理 Esc）
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onSearchOpenTask = useCallback(
    (id: string) => {
      setSearchOpen(false);
      actions.openTask(id);
    },
    [actions],
  );

  const onSearchOpenDiary = useCallback(
    (date: DateKey) => {
      setSearchOpen(false);
      dispatch({ type: 'SET_SELECTED_DATE', date });
      dispatch({ type: 'SET_VIEW', view: 'diary' });
    },
    [dispatch],
  );

  /** 搜索深链到记事本：关浮层 + 切到记事本视图 + 待打开的 note id */
  const [pendingOpenNoteId, setPendingOpenNoteId] = useState<string | null>(null);
  const onSearchOpenNote = useCallback(
    (id: string) => {
      setSearchOpen(false);
      dispatch({ type: 'SET_VIEW', view: 'notes' });
      setPendingOpenNoteId(id);
    },
    [dispatch],
  );

  /**
   * 这两个值传给被 memo 的侧栏 / 底部 Tab。
   * 不 memo 的话每次渲染都是新对象/新函数，memo 直接失效 —— 等于白包。
   */
  const progress = useMemo(
    () => getDayProgress(tasks, settings.lastSelectedDate),
    [tasks, settings.lastSelectedDate],
  );
  const dateLabel = formatDateTitle(settings.lastSelectedDate);
  const openSearch = useCallback(() => setSearchOpen(true), []);
  const isWide = view === 'week' || view === 'calendar';

  /**
   * 「N」新建任务：切到今日 + 把焦点放进快速添加框。
   *
   * 为什么切视图后要等一帧：输入框是随视图渲染出来的，
   * 同一个事件回调里 dispatch 完 DOM 还没更新，`querySelector` 会取到 null ——
   * 表现就是"第一次按 N 没反应，第二次才聚焦"。
   */
  const focusQuickAdd = useCallback(() => {
    if (view !== 'today') dispatch({ type: 'SET_VIEW', view: 'today' });
    requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>('[data-testid="quickadd-input"]');
      if (!input) return;
      input.focus();
      input.select();
    });
  }, [dispatch, view]);

  /**
   * 桌面端快捷键（N / / / 1–7）。
   * 抽屉或搜索浮层开着时整体关掉 —— 那时候按键应该留给浮层自己。
   * 复习页同理：那里 1/2/3 是"评级"，抢去切视图会把整个会话弄丢
   * （ReviewView 自己也 preventDefault，两道保险都留着 —— 少一道就复发）。
   */
  useHotkeys(
    {
      onNew: focusQuickAdd,
      onSearch: openSearch,
      onView: (next: ViewId) => dispatch({ type: 'SET_VIEW', view: next }),
    },
    { enabled: !ui.drawerTaskId && !searchOpen && view !== 'review' },
  );

  /**
   * 抽屉的派生数据用 `useMemo` 包住：`find` + `getChildTasks`（filter + sort）
   * 原来在 App 每渲一次都跑一遍。App 的重渲频率不低（swipe / 拖拽 / Toast），
   * 任务量大时这两行是白花的 O(n)。
   */
  const drawerTask = useMemo(
    () => (ui.drawerTaskId ? (tasks.find((task) => task.id === ui.drawerTaskId) ?? null) : null),
    [tasks, ui.drawerTaskId],
  );

  const drawerSubtasks = useMemo(
    () => (drawerTask ? getChildTasks(tasks, drawerTask.id) : []),
    [tasks, drawerTask],
  );

  /**
   * 抽屉里那条任务的专注累计。
   *
   * ⚠️ 这里**只算一条**，不要建 `focusStatsByTask` 的整张 Map ——
   * 今日视图那边已经为任务行建过了，同一份 focusSessions 在两处各聚合一遍是白烧 CPU。
   * 抽屉一次只用得到 `drawerTask` 这一条，走 `focusStatsForTask` 就够。
   */
  const drawerFocusSummary = useMemo(
    () => (drawerTask ? focusStatsForTask(state.focusSessions, drawerTask.id) : undefined),
    [state.focusSessions, drawerTask],
  );

  /**
   * 抽屉底部「开始专注」（移动端的唯一入口）。
   * 先关抽屉再开局：不关的话专注页上会盖着一层抽屉面板，
   * 用户会以为"点了没反应"。
   */
  const onDrawerStartFocus = useCallback(() => {
    if (!drawerTask) return;
    actions.closeDrawer();
    actions.startFocus(drawerTask.id);
  }, [actions, drawerTask]);

  const onAddSubtask = useCallback(
    (title: string) => {
      if (drawerTask) actions.addSubtask(drawerTask.id, title);
    },
    [actions, drawerTask],
  );

  /**
   * 抽屉里的「智能拆解」。直接转发给动作层 —— 拆解规则住在 `lib/breakdown`，
   * 落库住在 `useTaskActions`，这里只把"当前打开的是哪条"接上。
   */
  const onBreakdown = useCallback(
    () => (drawerTask ? actions.breakdownTask(drawerTask.id) : null),
    [actions, drawerTask],
  );

  const onToastAction = useCallback(() => {
    const current = ui.toast;
    if (!current?.action) return;
    const undo = current.action.undo;
    if (undo.kind === 'delete') {
      // now 让恢复的任务 updatedAt 盖过墓碑时间，否则下一次云同步又把它删掉
      dispatch({ type: 'TASK_RESTORE', task: undo.task, index: undo.index, now: nowIso() });
      toast.show(`已恢复到 ${formatRelativeDay(undo.task.date, today)}`);
      return;
    }
    dispatch({ type: 'TASK_UNDO_MOVE', moves: undo.moves, now: nowIso() });
    toast.show('已撤销移动');
  }, [dispatch, toast, today, ui.toast]);

  /**
   * 桌面端是无边框窗口：顶部留出一条可拖拽区（同时是系统按钮的位置），
   * 网页 / 安卓没有窗口外壳，不加内边距。
   * isDesktop 在模块加载时就确定了（bridge 是否存在），不会在运行中变化。
   */
  const isDesktop = desktopBridge() !== null;
  /** 顶部被窗口外壳占掉的高度：桌面端要让所有 sticky 元素避开它，否则一滚就钻到按钮底下 */
  const chromeHeight = isDesktop ? TITLE_BAR_HEIGHT : 0;

  return (
    <div
      className="flex min-h-screen flex-col bg-paper lg:flex-row"
      style={isDesktop ? { paddingTop: TITLE_BAR_HEIGHT } : undefined}
    >
      {isDesktop ? <WindowChrome /> : null}
      <Sidebar
        view={view}
        onViewChange={onViewChange}
        progress={progress}
        dateLabel={dateLabel}
        onSearch={openSearch}
        topOffset={chromeHeight}
      />

      <MobileTabBar
        view={view}
        onViewChange={onViewChange}
        progress={progress}
        dateLabel={dateLabel}
        onSearch={openSearch}
        topOffset={chromeHeight}
      />

      <main className="min-w-0 flex-1 pb-24 lg:pb-8">
        <div
          className={`mx-auto w-full px-4 pt-6 lg:px-6 ${
            isWide ? 'max-w-calendar' : 'max-w-content'
          }`}
        >
          {/*
            只读模式常驻横幅：装载超时后内存是空态，落盘被全局封锁。
            用横幅而不是 Toast —— Toast 会消失，而"这次改动不会被保存"这件事
            必须在用户动手期间一直看得见。
          */}
          {ui.persistBlocked ? (
            <div
              data-testid="persist-blocked-banner"
              role="alert"
              className="banner-warn mb-4 rounded-md px-3 py-2.5 text-label leading-relaxed text-ink"
            >
              <span className="font-semibold">本地数据这次没能读出来。</span>
              {' '}为免覆盖已有记录，本次不会保存任何改动。<br />
              请完全退出应用后重新打开；若反复出现，先检查手机存储空间是否已满。
            </div>
          ) : null}
          <UpdateBanner />
          {/*
            视图切换的进入动效（180ms 淡入 + 8px 上浮）。
            `key={view}` 是必需的：不换 key 的话 React 会复用同一个 div，
            动画只在首次挂载时跑一次，切视图反而没有反馈。
            只做"进"不做"出" —— 视图本来就是条件渲染，做出场要给它续命 180ms，
            还得接管它期间的数据与滚动位置，代价远大于收益。
          */}
          <div key={view} className="view-enter">
          {view === 'today' ? <TodayView today={today} onRequestFocus={requestFocus} /> : null}
          {view === 'week' ? <WeekView today={today} /> : null}
          {view === 'calendar' ? <CalendarView today={today} /> : null}
          {view === 'focus' ? (
            <FocusView
              today={today}
              pendingFocusTaskId={pendingFocusTaskId}
              onAutoStartConsumed={clearPendingFocus}
            />
          ) : null}
          {view === 'diary' ? <DiaryView today={today} /> : null}
          {view === 'notes' ? (
            <NotesView
              today={today}
              openNoteId={pendingOpenNoteId}
              onOpenNoteConsumed={() => setPendingOpenNoteId(null)}
            />
          ) : null}
          {view === 'settings' ? <SettingsView today={today} /> : null}
          {view === 'trash' ? <TrashView today={today} /> : null}
          {/* 复习会话：不在导航里（同 trash 的处理），只能从今日横幅 / 记事本进入 */}
          {view === 'review' ? <ReviewView today={today} onExit={exitReview} /> : null}
          </div>
        </div>
      </main>

      <TaskDrawer
        task={drawerTask}
        open={ui.drawerTaskId !== null}
        categories={settings.categories}
        subtasks={drawerSubtasks}
        onClose={actions.closeDrawer}
        onPatch={actions.patchDrawerTask}
        onDelete={actions.deleteDrawerTask}
        onToggleDone={actions.toggleDrawerTask}
        onAddSubtask={onAddSubtask}
        onBreakdown={onBreakdown}
        onToggleSubtask={actions.toggleTask}
        onStartFocus={drawerTask ? onDrawerStartFocus : undefined}
        focusSummary={drawerFocusSummary}
      />

      <Toast toast={ui.toast} onAction={onToastAction} onDismiss={toast.dismiss} />

      <SearchOverlay
        open={searchOpen}
        tasks={tasks}
        diary={state.diary}
        notes={state.notes}
        onClose={closeSearch}
        onOpenTask={onSearchOpenTask}
        onOpenDiary={onSearchOpenDiary}
        onOpenNote={onSearchOpenNote}
      />
    </div>
  );
}

/**
 * 对外导出的应用根组件。
 *
 * 只做一件事：把真正的界面树包进错误边界。渲染期任何异常（典型场景：日记 /
 * 记事内容触发 renderMarkdown 抛错）都被它降级成一张"内容无法显示"的卡片，
 * 而不是让整棵树卸载变成白屏。
 */
export function App() {
  return (
    <AppErrorBoundary>
      <AppShell />
    </AppErrorBoundary>
  );
}
