import { useCallback, useEffect, useRef, useState } from 'react';
import { SAVE_DEBOUNCE_MS, SCHEMA_VERSION } from '../constants';
import { isCloudRuntimeAvailable } from '../lib/cloud';
import { flushCloudPush, noteLocalSavedAt, scheduleCloudPush } from '../lib/cloudSync';
import { savePersisted, savePersistedSync } from '../lib/storage';
import { useAppDispatch, useAppState } from '../store/StoreContext';
import type {
  AppState,
  DiaryEntry,
  FocusSession,
  Note,
  PersistedPayload,
  Settings,
  Task,
  TaskTombstone,
} from '../types';

type SaveErrorReason = 'quota' | 'unavailable' | 'unknown';

interface UsePersistOptions {
  /** 写入失败时上报（由 App 接到 Toast 上，不阻塞继续操作） */
  onError?: (reason: SaveErrorReason) => void;
}

/**
 * 串行写链的对外形状。
 *
 * 语义契约（由 `src/hooks/__tests__/writeChain.test.ts` 逐条**行为**守护）：
 * - `enqueue` 返回的 Promise 按**调用顺序**串行执行：后入队的 work 必须等
 *   前一个 settle 后才开始；
 * - 前一个 work reject 不阻断后续入队（内部尾链吞掉错误继续跑，
 *   也绝不冒出未处理 rejection）；
 * - 单个 `enqueue` 的 Promise 在自己的 work 完成后才 settle（透传本条
 *   结果；reject 时由调用方自行处理）。
 *
 * ⚠️ 它守护的是 usePersist 的 R7「写序竞争」。写链原是 Hook 内裸
 * `useRef<Promise>` 挂链，QA 变异验证（改回并发写
 * `void (async () => {...})()`）时 348 条测试全绿 0 条红 —— 没有任何
 * 行为守护。抽成纯函数后，并发化变异会被上述单测直接测红。
 */
export interface SerialWriteChain {
  enqueue: (work: () => Promise<void>) => Promise<void>;
}

/** 创建一条串行写链（纯函数：无副作用、不依赖 React、可单测） */
export function createSerialWriteChain(): SerialWriteChain {
  // 内部尾链：每条都 `.catch` 掉，保证后续入队永远被执行
  let tail: Promise<void> = Promise.resolve();
  return {
    enqueue(work: () => Promise<void>): Promise<void> {
      const result = tail.then(work);
      tail = result.catch(() => undefined);
      return result;
    },
  };
}

/**
 * 参与持久化的 state 字段 —— **依赖数组与 payload 构造共用的唯一真相**。
 *
 * 为什么要抽出来：自动保存靠 `useEffect` 的依赖数组触发。以前依赖数组是手写的，
 * 加 diary 时 `buildPayload` 改了、依赖数组没改 → **日记写完不落盘，刷新即消失**（P0）。
 * 手写两份必然会漂移，所以让 effect 的依赖数组直接由这里生成，
 * 并由 `src/hooks/__tests__/persistDeps.test.ts` 逐字段守护。
 *
 * ⚠️ 以后新增持久化字段：只在这里加一项，buildPayload 与监听自动跟着走。
 */
export function persistDeps(
  state: AppState,
): [Task[], Settings, DiaryEntry[], TaskTombstone[], FocusSession[], Note[]] {
  return [
    state.tasks,
    state.settings,
    state.diary,
    state.tombstones,
    state.focusSessions,
    state.notes,
  ];
}

/**
 * 由当前 state 造一份落盘 / 同步用的载荷。
 *
 * 对外导出是因为**自动同步也要构造"本机现在是什么样"**，
 * 曾经设置页里手抄过一份（字段漏了 focusSessions 那次），
 * 所以这里做唯一出口，别处一律 import 它。
 *
 * `savedAt` 可覆盖：云同步必须用**本机真实落盘时间**而不是"现在" ——
 * 一台从没保存过的新设备如果报"现在"，它的空数据会被当成"最新"推上云端，
 * 把别的设备的任务全清掉。落盘与自动备份走默认值（现在）。
 */
export function buildPersistedPayload(state: AppState, savedAt?: string): PersistedPayload {
  return {
    schemaVersion: SCHEMA_VERSION,
    savedAt: savedAt ?? new Date().toISOString(),
    tasks: state.tasks,
    settings: state.settings,
    diary: state.diary,
    tombstones: state.tombstones,
    focusSessions: state.focusSessions,
    notes: state.notes,
  };
}

function reasonToMessage(reason: SaveErrorReason): string {
  if (reason === 'quota') return '本地空间不足，数据未能保存';
  if (reason === 'unavailable') return '当前环境不支持本地存储，数据未能保存';
  return '数据未能保存';
}

/**
 * 持久化：`[tasks, settings]` 变化 → 300ms 防抖整包写入 → pagehide 强制 flush。
 * - 首次挂载不写（避免"什么都没改却覆盖一次"）
 * - 连续改动只写一次（倒计时被重置）
 * - 写入失败只上报，不阻塞操作（§3.3）
 *
 * 异步化（增量设计 S3）：savePersisted 改异步后 flush() **保持同步签名** ——
 * 同步取 pending → 挂到串行写链（`createSerialWriteChain`）后即返回。
 * pagehide / visibilitychange 里无法 await，只能 fire-and-forget；写链保证
 * 后一次 flush 的写入排在先一次之后、**后写覆盖先写**（R7 写序竞争，
 * 行为守护见 `src/hooks/__tests__/writeChain.test.ts`）。
 * 落盘时间登记已上移至 StoreContext 启动装载处（同步 / 原生两条路径各自
 * 登记），此处只负责"保存成功后"那一处。
 */
export function usePersist(options: UsePersistOptions = {}): { flush: () => void } {
  const state = useAppState();
  const dispatch = useAppDispatch();
  /**
   * 只读模式（装载超时兜底）：**一个字节都不写**。
   *
   * 那一刻内存里是空态，而盘上可能躺着几 MB 的真实数据 —— 只要让它写一次，
   * 用户随手加的一条任务就会把整份数据替换掉。宁可这一轮白改，
   * 也不能让"没读出来"变成"覆盖掉"。
   */
  const persistBlocked = state.ui.persistBlocked;
  const onErrorRef = useRef(options.onError);
  onErrorRef.current = options.onError;

  const firstRun = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<PersistedPayload | null>(null);
  /**
   * 串行写链（R7 写序竞争）：`useState` 的惰性初始化保证工厂只建一次。
   * 全部落盘写入经 `enqueue` 挂链，按入队顺序串行执行、后写覆盖先写；
   * 语义由 `src/hooks/__tests__/writeChain.test.ts` 守护。
   */
  const [writeChain] = useState(createSerialWriteChain);

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const payload = pending.current;
    if (!payload) return;
    pending.current = null;

    // 同步签名：同步合并 pending → 挂串行写链 → 立即返回（不等落盘）。
    // pagehide 场景由浏览器决定进程生死，属已知残余风险（R2）。
    writeChain.enqueue(async () => {
      try {
        const result = await savePersisted(payload);
        if (result.ok) {
          dispatch({ type: 'UI_SAVE_STATE', saveState: 'saved', error: null });
          // 记录**真实**落盘时间：它决定云同步的方向（云端更新 → 拉，本地更新 → 推）。
          // 用「现在」顶替会让本机永远显得最新，新设备登录时就会把云端数据盖成空的。
          noteLocalSavedAt(payload.savedAt);
          // 本机落盘成功后，已登录就顺手同步一次到云端（同一个防抖节奏，不另造保存逻辑）。
          // 未登录时 cloudSync 内部直接返回 signed-out：不发请求、不报错；
          // 非发布域名（桌面端 exe）连排期都不排，那个端本就不该联网
          // （APK 的 hostname 已是发布域名，由 isCloudRuntimeAvailable() 自动放行）。
          if (isCloudRuntimeAvailable()) scheduleCloudPush(payload);
          return;
        }
        dispatch({ type: 'UI_SAVE_STATE', saveState: 'error', error: reasonToMessage(result.reason) });
        onErrorRef.current?.(result.reason);
      } catch {
        // savePersisted 本身永不 reject；这里只是绝不让写链冒出
        // 未处理 rejection（那会让后续 flush 全部静默停摆）
        dispatch({ type: 'UI_SAVE_STATE', saveState: 'error', error: reasonToMessage('unknown') });
        onErrorRef.current?.('unknown');
      }
    });
  }, [dispatch]);

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    if (persistBlocked) return;
    pending.current = buildPersistedPayload(state);
    dispatch({ type: 'UI_SAVE_STATE', saveState: 'saving' });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
    /**
     * 只在**被持久化的**数据真正变化时触发；state 的其余字段（ui）不参与持久化。
     * 依赖由 `persistDeps(state)` 生成：三个字段必须与 `buildPayload` 取的一致，
     * 漏掉 diary 会导致日记写完不落盘、刷新即消失（P0，已修复并守护）。
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...persistDeps(state), dispatch, flush, persistBlocked]);

  /**
   * 卸载前的**同步**落盘。
   *
   * `flush()` 的签名是同步的，但内部 `await savePersisted(...)` 是一串微任务 ——
   * `pagehide` / 窗口关闭之后浏览器不保证把它们跑完，于是"最后一次编辑"
   * 可能留在内存里（用户下次打开看到上一版）。
   *
   * 这里改用 localStorage 的同步写把这一刻直接钉到盘上。
   * 返回 false 表示这个环境做不到同步写（安卓原生 Preferences）→ 调用方回落到 `flush()`。
   */
  const flushSync = useCallback((): boolean => {
    // 只读模式：不写盘，直接报"已处理"（不回落异步写链，那也是写）
    if (persistBlocked) return true;
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const payload = pending.current;
    if (!payload) return true; // 没有待写内容，无需回落
    const result = savePersistedSync(payload);
    if (result === null) return false; // 环境不支持 → 交给异步写链
    pending.current = null;
    if (result.ok) {
      dispatch({ type: 'UI_SAVE_STATE', saveState: 'saved', error: null });
      noteLocalSavedAt(payload.savedAt);
    } else {
      dispatch({ type: 'UI_SAVE_STATE', saveState: 'error', error: reasonToMessage(result.reason) });
      onErrorRef.current?.(result.reason);
    }
    return true; // 已经处理过（成功或已上报失败），不再走异步重复写
  }, [dispatch, persistBlocked]);

  useEffect(() => {
    const onHide = (): void => {
      if (!flushSync()) flush();
      // 防抖窗口内关页面/切后台：本地已落盘，云端那份也不能丢
      if (isCloudRuntimeAvailable()) void flushCloudPush();
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') {
        if (!flushSync()) flush();
        if (isCloudRuntimeAvailable()) void flushCloudPush();
      }
    };
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVisibility);
      flush();
    };
  }, [flush]);

  return { flush };
}
