import {
  createContext,
  useContext,
  useReducer,
  useEffect,
  type Dispatch,
  type ReactNode,
} from 'react';
import { HYDRATE_TIMEOUT_MS } from '../constants';
import { noteLocalSavedAt } from '../lib/cloudSync';
import { isNativeStorage, loadPersisted, loadPersistedAsync } from '../lib/storage';
import type { LoadResult } from '../lib/storage';
import { BootSplash } from '../components/common/BootSplash';
import type { AppState } from '../types';
import {
  createEmptyState,
  blockedHydration,
  hydrateFromLoad,
  reducer,
  stateFromLoad,
  type AppAction,
} from './reducer';

/**
 * 两次装载都超时后的文案。
 *
 * 必须让人看懂"为什么这次改的东西可能不见" —— 只说"存储不可用"会让人
 * 以为是临时故障，接着照常用，然后发现整天的记录都没了。
 */
const LOAD_TIMEOUT_MESSAGE =
  '本地数据读取超时，本次为只读模式（改动不会保存，以免覆盖已有记录）';

/* ============================================================================
   Store：State / Dispatch 拆成两个 Context
   —— 纯展示组件只订阅 dispatch 时不会因为状态变化而重渲染（§1.3 决策 A）
   ========================================================================= */

const StateContext = createContext<AppState | null>(null);
const DispatchContext = createContext<Dispatch<AppAction> | null>(null);

/**
 * 启动装载（平台分流，增量设计 S1 / S2）：
 * - 网页 / 桌面（isNativeStorage()=false）：同步读一次 localStorage，
 *   避免"先空态再填充"的闪动 —— 与改前逐字段一致，零回归；
 * - 原生（APK）：Preferences 只有异步 API，同步装载做不到 → 返回
 *   `hydrating:true` 的空态，由 StoreProvider 门控渲染 BootSplash，
 *   异步装载完成后走 HYDRATE 打开门控。
 *
 * 同步路径在此登记落盘时间（登记点自 usePersist 上移，见 cloudSync 注释）：
 * 保证本会话任何同步触发前，云同步方向判定用的已是"磁盘上那份"的真实 savedAt。
 */
export function createInitialState(): AppState {
  if (isNativeStorage()) {
    const base = createEmptyState();
    return { ...base, ui: { ...base.ui, hydrating: true } };
  }
  const load = loadPersisted();
  if (load.payload?.savedAt) noteLocalSavedAt(load.payload.savedAt);
  return stateFromLoad(load);
}

/**
 * 装载动作统一走 reducer 里的 `hydrateFromLoad`。
 * 这里曾经手抄过一份同逻辑的副本，只写了三个字段 —— 见 reducer.ts 里的注释。
 */

/**
 * 原生异步装载（仅 APK）：`loadPersistedAsync()` 与 `HYDRATE_TIMEOUT_MS` 兜底赛跑。
 *
 * - 装载成功 → `noteLocalSavedAt(真实落盘时间)` + dispatch HYDRATE；
 * - 超时 → **重试一次**（存储偶尔只是慢，不是坏），仍然超时才降级；
 * - 两次都超时 → dispatch 一份 **只读**空态（`persistBlocked: true`）。
 *
 * ⚠️ 为什么必须是只读：旧实现在超时后照常打开一个可编辑的空应用，而
 * `usePersist` 不区分"空因为新装"和"空因为没读出来" —— 用户随手加一条任务，
 * 整包写入就把盘上那份真实数据（可能是几 MB 的记事与专注记录）覆盖掉了，
 * 而 Toast 还写着"本次改动不会保存"。这条路径一次点击就能丢光所有数据，
 * 所以宁可让这一轮不保存，也不能让空态落盘。
 */
export async function runNativeHydration(dispatch: Dispatch<AppAction>): Promise<void> {
  /** 单次装载；超时返回 null（不 reject，绝不让门控卡死） */
  const readOnce = async (): Promise<LoadResult | null> => {
    let gaveUp = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const guard = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        gaveUp = true;
        resolve(null);
      }, HYDRATE_TIMEOUT_MS);
    });
    try {
      const raced = await Promise.race([loadPersistedAsync(), guard]);
      if (gaveUp || raced === null) return null;
      return raced as LoadResult;
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const load = await readOnce();
    if (!load) continue;
    if (load.payload?.savedAt) noteLocalSavedAt(load.payload.savedAt);
    dispatch(hydrateFromLoad(load));
    return;
  }

  // 两次都没读出来：进只读模式（App 顶部有常驻横幅，改不了数据也覆盖不掉）
  dispatch(blockedHydration(LOAD_TIMEOUT_MESSAGE));
}

export function StoreProvider({ children }: { children: ReactNode }): ReactNode {
  const [state, dispatch] = useReducer(reducer, undefined, createInitialState);

  // 原生 hydration 门控：装载期间只渲染 BootSplash，children 不挂载 ——
  // usePersist 的 firstRun 守卫依赖"挂载时状态已装载"，提前挂载会被空态
  // 消耗掉，hydration 后会触发一次无谓回写还刷新 savedAt（D6 / R7）。
  useEffect(() => {
    if (!state.ui.hydrating) return;
    let alive = true;
    void runNativeHydration((action) => {
      if (alive) dispatch(action);
    });
    return () => {
      alive = false;
    };
  }, [state.ui.hydrating, dispatch]);

  if (state.ui.hydrating) return <BootSplash />;

  return (
    <StateContext.Provider value={state}>
      <DispatchContext.Provider value={dispatch}>{children}</DispatchContext.Provider>
    </StateContext.Provider>
  );
}

export function useAppState(): AppState {
  const state = useContext(StateContext);
  if (!state) throw new Error('useAppState 必须在 <StoreProvider> 内使用');
  return state;
}

export function useAppDispatch(): Dispatch<AppAction> {
  const dispatch = useContext(DispatchContext);
  if (!dispatch) throw new Error('useAppDispatch 必须在 <StoreProvider> 内使用');
  return dispatch;
}
