import { createDefaultSettings } from '../constants';
import { monthOfKey, todayKey } from '../lib/date';
import type { LoadResult } from '../lib/storage';
import type { AppAction } from './actions';
import { reduceContent } from './domains/content';
import { reduceHabits } from './domains/habits';
import { reduceLifecycle } from './domains/lifecycle';
import { reduceSettings } from './domains/settings';
import { reduceTasks } from './domains/tasks';
import { reduceUi } from './domains/ui';
import { withFieldClocks } from './fieldClock';
import type { AppState, PersistedPayload } from '../types';

/* ============================================================================
   纯 reducer 的组合根（ARCHITECTURE §3.4）

   纪律（对每个域文件都成立）：
   - 每个 action 都返回**新对象**（不可变更新，可用 Object.is 抽查）；
   - 写操作必须刷新 updatedAt（TOGGLE 也刷）；
   - 不在 reducer 里读时钟：需要时间戳的 action 由调用方把 `now` 传进来，
     保证同样的输入必得同样的输出（可单测、可回放）；
   - 域函数返回 `null` 表示"这条 action 不归我管"。

   为什么拆：原来是一个 1000 行的 switch，46 个 action 全挤在一起。
   改一项功能要在上千行里找 case，而且"哪些状态不落盘""哪些字段删除要留墓碑"
   这类约束只写在零散注释里。现在每个域一个文件，域的边界就是文件的边界。

   ⚠️ 分派是**顺序尝试**，不是查表：`null` 才算"没接"。所以域之间不能出现
   同一条 action 被两个域都认领 —— p2Constraints 的 action 清单测试会盯着总量，
   但"某个 case 漏写"只能靠各域自己的用例。
   ========================================================================= */

export type { AppAction };

export function reducer(state: AppState, action: AppAction): AppState {
  const next =
    reduceLifecycle(state, action) ??
    reduceTasks(state, action) ??
    reduceHabits(state, action) ??
    reduceSettings(state, action) ??
    reduceContent(state, action) ??
    reduceUi(state, action) ??
    state;
  /**
   * 收尾打点：字段级时钟。
   *
   * **必须在所有域之后**——每个域的出口都要过这一关，否则"某个域改了标题
   * 却没留时钟"会让云同步按旧时间戳把这次改动判给对端（改动无声丢失）。
   * 早退见 `withFieldClocks`：`tasks` 引用没变时是零成本的。
   */
  return next === state ? next : withFieldClocks(state, next);
}

/* ============================================================================
   初始态
   ========================================================================= */
export function createEmptyState(): AppState {
  const today = todayKey();
  return {
    tasks: [],
    notes: [],
    diary: [],
    tombstones: [],
    focusSessions: [],
    settings: createDefaultSettings(today),
    ui: {
      drawerTaskId: null,
      drawerReturnFocusId: null,
      monthCursor: monthOfKey(today),
      toast: null,
      stickyDoneIds: [],
      saveState: 'idle',
      storageError: null,
      // 原生 hydration 门控标记：装载完成（HYDRATE）后置回 false；网页 / 桌面恒 false
      hydrating: false,
      // 正常装载不封锁落盘；只有"可能有数据却没读出来"时才置 true
      persistBlocked: false,
    },
  };
}

/** 存储层错误 → 用户可见文案 */
export function storageErrorMessage(
  error: LoadResult['error'],
  backupCreated: boolean,
): string | null {
  if (!error) return null;
  if (error === 'corrupt') {
    return backupCreated ? '数据读取失败，已重置（原始数据已备份）' : '数据读取失败，已重置';
  }
  if (error === 'future-version') return '数据来自更高版本，已以只读方式备份';
  return '本地存储不可用，本次改动不会保存';
}

/**
 * LoadResult → HYDRATE action。
 *
 * **全工程唯一的一份"装载动作构造"**。
 * 之前 StoreContext 里还手抄了一份 `hydrateAction`，只写了 tasks/settings/diary
 * 三个字段，漏了 tombstones 与 focusSessions —— 结果是 APK 每次冷启动，
 * 回收站和专注记录都会凭空消失（墓碑丢了还会让已删任务在下次同步时复活）。
 * 编译不报错、网页端也复现不出来（网页走的是 stateFromLoad），只有安卓用户会中招。
 * 现在只有这一份，加字段只改这里。
 */
export function hydrateFromPayload(
  payload: PersistedPayload | null,
  storageError: string | null,
  /**
   * 装载失败时是否封锁落盘。
   *
   * 只有一种情况需要：**盘上可能有数据但这次没读出来**（APK 冷启动超时）。
   * 此时内存里是空态，若照常保存，用户随手加一条任务就等于把真实数据整包覆盖。
   * 默认 false —— 新设备第一次启动也是空态，那种情况本来就没什么可覆盖。
   */
  persistBlocked = false,
): AppAction {
  const base = createEmptyState();
  return {
    type: 'HYDRATE',
    tasks: payload ? payload.tasks : [],
    settings: payload ? payload.settings : base.settings,
    diary: payload ? payload.diary : [],
    // 墓碑必须一起装载：它是"哪条被删了"的唯一凭据，丢了就会复活
    tombstones: payload ? payload.tombstones : [],
    // 专注记录同理：历史时长不该因为一次装载而消失
    focusSessions: payload ? payload.focusSessions : [],
    // 记事本同理：漏了它 = 升级后用户的记事全部消失
    notes: payload ? payload.notes : [],
    storageError,
    persistBlocked,
  };
}

export function hydrateFromLoad(load: LoadResult): AppAction {
  return hydrateFromPayload(load.payload, storageErrorMessage(load.error, load.backupCreated));
}

/**
 * 装载超时（盘上可能有数据却没读出来）时的兜底动作：空态 + **只读**。
 *
 * 单开一个语义化入口，是为了让"装回状态"仍然只在 reducer 里构造 ——
 * StoreContext 不必知道 HYDRATE 有哪些字段（它以前手抄过一份，漏了两个集合，
 * 安卓每次冷启动丢数据）。加字段时只有这里要改。
 */
export function blockedHydration(storageError: string): AppAction {
  return hydrateFromPayload(null, storageError, true);
}

/**
 * 由 storage.loadPersisted() 的结果构造初始态。
 * 走 `HYDRATE` 分支而不是就地拼对象 —— 保证"启动装载"只有一条代码路径。
 */
export function stateFromLoad(load: LoadResult): AppState {
  return reducer(createEmptyState(), hydrateFromLoad(load));
}
