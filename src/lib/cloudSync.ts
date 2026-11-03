import { SAVE_DEBOUNCE_MS } from '../constants';
import type { PersistedPayload } from '../types';
import { SYNC_HISTORY_TABLE, SYNC_TABLE, cloud } from './cloud';
import { isBrowserOffline } from './network';
import { clearOutbox, recordUndelivered, type OutboxReason } from './outbox';
import { getLocalStorage, hasAnyPersistedData, migrate } from './storage';
import {
  getLastKnownRemoteCount,
  noteRemoteCount,
  pullSnapshot,
  pushSnapshot,
  readSessionPresence,
} from './cloudSnapshot';

/** 载荷里有多少条任务（脏数据兜底为 0）—— 推成功后更新"云端已知条数"用 */
function taskCountOf(payload: PersistedPayload | null | undefined): number {
  return payload && Array.isArray(payload.tasks) ? payload.tasks.length : 0;
}
/**
 * 决策层（方向判定 + 快照差异比较）已拆到 `lib/syncDecision.ts`。
 *
 * 那部分是这个文件里**最容易错、也最值得单测**的内容：它决定"谁覆盖谁"、
 * "到底要不要推"。搬出去之后 cloudSync 只剩"发请求 / 收结果 / 广播状态"。
 * 这里再导出一次，是因为调用点和测试都从 cloudSync 拿这几个名字 ——
 * cloudSync 仍然是对外那张脸，没必要为了搬家制造一轮全仓 diff。
 */
import {
  decideSyncAction,
  isSameSnapshot,
  snapshotDiffers,
  type CloudSnapshotMeta,
  type SyncAction,
} from './syncDecision';
export { decideSyncAction, isSameSnapshot, snapshotDiffers };
export type { CloudSnapshotMeta, SyncAction };
import {
  permissionDeniedError,
  syncErrorMessage,
  toSyncError,
  type SyncErrorInfo,
} from './syncErrors';

/* ============================================================================
   云同步（可选增强）
   —— 不登录时本模块**一次网络请求都不发**，应用照常工作；
      云端失败也只影响同步，绝不阻塞本地功能。
   纪律：任何日志都不出现完整手机号 / 验证码 / payload 原文。
   ========================================================================= */

/* ---------- 合并策略（纯函数，可单测） ---------- */

/**
 * 合并策略已搬到 `lib/merge.ts`（纯函数、零网络依赖）。
 * 这里保留**再导出**：调用点与测试仍然从 cloudSync 拿这几个函数，
 * 一次性全改只会制造无谓 diff 风险；cloudSync 依旧是"对外那张脸"。
 */
export {
  applyTombstones,
  mergeDiary,
  mergeFocusSessions,
  mergeGoals,
  mergeNotes,
  mergeSnapshots,
  mergeTasks,
  mergeTombstones,
} from './merge';
/**
 * 上面那条 `export { ... } from` **不会**在本地建立绑定，所以内部要用
 * `mergeSnapshots` 必须再单独 import 一次 —— 这不是重复导入（曾经被误判成重复，
 * 删掉那一行会让 537 / 997 / 1149 三处调用全部报未定义）。
 */
import { mergeSnapshots } from './merge';

/* ---------- 错误归一（已拆到 lib/syncErrors.ts，这里再导出） ---------- */

export {
  SESSION_EXPIRED_MESSAGE,
  UNSUPPORTED_RUNTIME_MESSAGE,
  isUniqueViolation,
  permissionDeniedError,
  syncErrorMessage,
  toSyncError,
  type SyncErrorInfo,
} from './syncErrors';

/* ---------- 结果信封（Pull / Push / 历史 在 cloudSnapshot，这里只再导出） ---------- */

export type { CloudSnapshot, HistoryEntry, HistoryResult, PullResult, PushResult } from './cloudSnapshot';
export { getLastKnownRemoteCount, listHistory, pullSnapshot, pushSnapshot } from './cloudSnapshot';

/**
 * `export type { X } from '...'` **不建立本地绑定** —— 内部要用 `PushResult`
 * 必须再 import 一次（同 §merge 那段的教训，别删掉这行）。
 */
import type { PushResult } from './cloudSnapshot';

/* ---------- 会话 ---------- */

export interface CloudAccount {
  id: string;
  /** 可能是 `+86 138...` 形式；展示前**必须**过 maskPhone */
  phone: string | null;
}

/** 手机号脱敏：保留前 3 后 4，中间打星号。任何展示路径都不打印完整号码。 */
export function maskPhone(phone: string | null | undefined): string {
  if (typeof phone !== 'string') return '***';
  const digits = phone.replace(/\D/g, '');
  if (digits.length >= 11) {
    const tail = digits.slice(-11);
    return `${tail.slice(0, 3)}****${tail.slice(7)}`;
  }
  if (digits.length >= 4) return `${digits.slice(0, 2)}***${digits.slice(-1)}`;
  return '***';
}

/** 当前登录用户；未登录 / 读失败一律 null（未登录是合法状态，不是错误） */
export async function getSessionUser(): Promise<CloudAccount | null> {
  try {
    const { data, error } = await cloud.auth.getSession();
    if (error || !data) return null;
    return { id: data.user.id, phone: data.user.phone ?? null };
  } catch {
    return null;
  }
}

/** 登录态变化订阅（订阅时会立即回放一次 INITIAL_SESSION）；返回取消订阅函数 */
export function subscribeAuth(listener: (account: CloudAccount | null) => void): () => void {
  return cloud.auth.onAuthStateChange((_event, session) => {
    listener(session ? { id: session.user.id, phone: session.user.phone ?? null } : null);
  });
}

/** 退出登录：失败也当作已退出（本地凭据已清，界面不该再显示可用登录态） */
export async function signOut(): Promise<void> {
  try {
    await cloud.auth.signOut();
  } catch {
    /* 断网时也必须能登出 */
  }
}


export type ClearResult =
  | { status: 'ok'; removed: number }
  | { status: 'signed-out' }
  | { status: 'error'; error: SyncErrorInfo };

/**
 * 清空云端：删除该账号在 todo_sync 的全部行。本机数据不动。
 * 删除成功后暂停自动推送（否则本机数据会被立刻推回云端，清空失去意义），
 * 用户点一次「立即同步」即恢复正常同步。
 */
export async function clearRemoteSnapshot(): Promise<ClearResult> {
  try {
    const presence = await readSessionPresence();
    if (presence.state === 'signed-out') return { status: 'signed-out' };
    if (presence.state === 'unknown') return { status: 'error', error: presence.error };

    // 先探一下有没有行：没有就直接算成功（0 条），
    // 避免把"云端本来就没数据"误报成权限错误。
    const before = await cloud.database
      .from(SYNC_TABLE)
      .select('id')
      .order('saved_at', { ascending: false })
      .limit(1);
    if (before.error) return { status: 'error', error: toSyncError(before.error) };
    const hasRow = Array.isArray(before.data) && before.data.length > 0;
    if (!hasRow) {
      noteRemoteCount(0);
      return { status: 'ok', removed: 0 };
    }

    const { data, error } = await cloud.database.from(SYNC_TABLE).delete().select('id');
    if (error) return { status: 'error', error: toSyncError(error) };
    // 已知有行却返回空数组：RLS 静默拦截，按权限口径上报
    if (!Array.isArray(data) || data.length === 0) {
      return { status: 'error', error: permissionDeniedError() };
    }
    noteRemoteCount(0);
    pauseAutoPush();
    return { status: 'ok', removed: data.length };
  } catch {
    return { status: 'error', error: { code: null, message: '清空云端失败，数据仍在本机', status: null } };
  }
}


export type RestoreResult =
  | { status: 'ok'; payload: PersistedPayload }
  | { status: 'signed-out' }
  | { status: 'error'; error: SyncErrorInfo };

/**
 * 回滚到某个历史版本：把那份旧 payload 推回云端，并返回给调用方 hydrate 本机。
 *
 * 推上去的那一刻，当前状态会被触发器**再存档一次** —— 所以回滚本身也是可逆的，
 * 点错了再回滚一次就能回到原地。回滚同样过 `migrate()`，坏版本不会被写回云端。
 */
export async function restoreHistory(id: number): Promise<RestoreResult> {
  try {
    const presence = await readSessionPresence();
    if (presence.state === 'signed-out') return { status: 'signed-out' };
    if (presence.state === 'unknown') return { status: 'error', error: presence.error };

    const { data, error } = await cloud.database
      .from(SYNC_HISTORY_TABLE)
      .select('payload')
      .eq('id', id)
      .limit(1);
    if (error) return { status: 'error', error: toSyncError(error) };

    const row = Array.isArray(data) && data.length > 0 ? data[0] : null;
    if (!row || !row.payload || typeof row.payload !== 'object') {
      return { status: 'error', error: { code: null, message: '该历史版本已不存在', status: null } };
    }
    // 过一遍字段级兜底：坏版本不能被写回云端，否则回滚反而制造坏数据
    const payload = migrate(row.payload as PersistedPayload);
    if (!payload) {
      return { status: 'error', error: { code: null, message: '该历史版本数据无法识别', status: null } };
    }

    const pushed = await pushSnapshot(payload);
    if (pushed.status === 'signed-out') return { status: 'signed-out' };
    if (pushed.status === 'error') return { status: 'error', error: pushed.error };

    // 回滚成功 → 解除自动推送暂停（「清空云端 → 从历史恢复」这条路径需要）
    resumeAutoPush();
    noteSyncSuccess();
    return { status: 'ok', payload };
  } catch {
    return { status: 'error', error: { code: null, message: '回滚失败，数据仍在本机', status: null } };
  }
}

/* ---------- 同步状态（供设置页展示「上次同步：HH:MM」） ---------- */

export interface SyncStatus {
  /** 最近一次成功同步的 ISO 时间；null = 尚未同步 */
  lastSyncedAt: string | null;
  /** 是否正在同步 */
  syncing: boolean;
}

let syncStatus: SyncStatus = { lastSyncedAt: null, syncing: false };
const statusListeners = new Set<(status: SyncStatus) => void>();

function setSyncStatus(patch: Partial<SyncStatus>): void {
  syncStatus = { ...syncStatus, ...patch };
  for (const listener of statusListeners) listener(syncStatus);
}

export function getSyncStatus(): SyncStatus {
  return syncStatus;
}

export function subscribeSyncStatus(listener: (status: SyncStatus) => void): () => void {
  statusListeners.add(listener);
  listener(syncStatus);
  return () => {
    statusListeners.delete(listener);
  };
}

export function noteSyncStart(): void {
  setSyncStatus({ syncing: true });
}

export function noteSyncSuccess(): void {
  setSyncStatus({ syncing: false, lastSyncedAt: new Date().toISOString() });
  // 任何一次成功都把"连续失败"计数清零并解除自动同步的暂停：
  // 网络抖动 / token 过期重登后不该永久停摆。
  resetAutoSyncFailures();
}

export function noteSyncFailure(): void {
  setSyncStatus({ syncing: false });
}

/* ---------- 本机最后一次真实落盘时间 ---------- */

/**
 * 本机最后一次**真实落盘**的 `savedAt`。
 *
 * 登记点共两处（增量设计 D3，登记点自 usePersist 挂载 effect 上移）：
 * ① `StoreContext` 启动装载完成时 —— 同步路径（createInitialState）与
 *    原生路径（runNativeHydration）各自装载成功后登记"磁盘上那份"的时间；
 * ② `usePersist` 保存成功后（savePersisted 返回 ok）—— 登记本次真实落盘时间。
 *
 * ⚠️ 它决定同步方向，绝不能用 `new Date().toISOString()` 顶替：
 * 那会让本地时间恒为"现在"，`decideSyncAction` 永远判不出云端更新，
 * 于是"新设备登录"会用空本机数据把云端真实数据覆盖掉。
 * `null` = 本机从未落盘过（新设备 / 全新安装）。
 */
let localSavedAt: string | null = null;

export function noteLocalSavedAt(savedAt: string): void {
  if (typeof savedAt === 'string' && savedAt) localSavedAt = savedAt;
}

export function getLocalSavedAt(): string | null {
  return localSavedAt;
}

/* ---------- 自动推送（挂在本机防抖保存之后） ---------- */

let pushTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPayload: PersistedPayload | null = null;
let errorHandler: ((message: string) => void) | null = null;
/** 后台自动同步合并进了云端独有任务时的回调（由 App 接到 HYDRATE 上） */
let mergeHandler: ((payload: PersistedPayload) => void) | null = null;

/** 注册一个全局的同步失败提示出口（由 App 接到 Toast 上）；传 null 注销 */
export function setCloudErrorHandler(handler: ((message: string) => void) | null): void {
  errorHandler = handler;
}

/** 注册"自动推送合并结果"回调；传 null 注销 */
export function setCloudMergeHandler(handler: ((payload: PersistedPayload) => void) | null): void {
  mergeHandler = handler;
}

/* ---------- 失败提示的节流与自动同步的停摆 ---------- */

/**
 * 同一条错误文案的最小提示间隔。
 *
 * 后台同步挂在"每次保存"后面：云端拒绝（RLS / 401 / 环境不支持）时，
 * 用户每改一个字就会弹一条"无权操作此数据" —— 那是**提示洪水**，
 * 不是提示。同一句话 5 分钟内只说一次，用户主动点「立即同步」不受此限
 * （那条路径自己 toast，不走这里）。
 */
const ERROR_NOTIFY_COOLDOWN_MS = 5 * 60_000;

/** 连续失败到这个次数就暂停自动同步（本会话内），不再每次保存都去撞墙 */
const AUTO_SYNC_FAIL_LIMIT = 3;

/** 自动同步停摆时统一下的一句话（与具体错误文案区分，方便用户理解"不会再烦你"） */
export const AUTO_SYNC_PAUSED_MESSAGE = '云同步暂时不可用，数据仍在本机（可在设置页手动同步）';

/** 离线时的统一口径（比"同步失败"准确：不是云端出问题，是这台设备没网） */
export const OFFLINE_MESSAGE = '当前离线，改动已存在本机，联网后会自动补传';

/**
 * 记一笔"本机改动还没送达云端"（离线 / 请求失败时）。
 *
 * 落盘到设备本地的 outbox，作用有三个（见 lib/outbox.ts 的说明）：
 * ① 刷新 / 关掉应用之后仍然记得"还有东西没上去"；
 * ② 启动与网络恢复时可以据此**立刻补推**，不用等用户发现；
 * ③ 设置页能如实显示"N 条待上传"。
 *
 * 空载荷不记：一台还没建过任何东西的设备失败一次不该被算成"有待上传"。
 */
function markUndelivered(payload: PersistedPayload | null, reason: OutboxReason): void {
  if (!payload || !hasAnyPersistedData(payload)) return;
  recordUndelivered(payload.savedAt, reason);
}

const lastNotifiedAt = new Map<string, number>();
let autoSyncFailures = 0;
let autoSyncPaused = false;

/**
 * 上报一条同步错误给用户看。
 *
 * `force = true` 用于"用户刚刚主动点了同步"以及"自动同步就此停摆"这两种
 * **必须让人知道**的时刻；其余（后台自动）一律走节流。
 */
export function notifySyncError(message: string, force = false): void {
  const now = Date.now();
  if (!force && now - (lastNotifiedAt.get(message) ?? 0) < ERROR_NOTIFY_COOLDOWN_MS) return;
  lastNotifiedAt.set(message, now);
  errorHandler?.(message);
}

/** 连续失败计数清零 + 解除停摆（任何一次同步成功都会调到） */
export function resetAutoSyncFailures(): void {
  autoSyncFailures = 0;
  autoSyncPaused = false;
}

/** 自动同步是否已被"连续失败"停摆（供测试与设置页展示用） */
export function isAutoSyncPaused(): boolean {
  return autoSyncPaused;
}

/** 当前连续失败次数（测试用） */
export function getAutoSyncFailures(): number {
  return autoSyncFailures;
}

/** 停摆后由用户在设置页点「立即同步」恢复（runSync 成功 → noteSyncSuccess → 清零） */
export function resumeAutoSync(): void {
  resetAutoSyncFailures();
}

/** 「清空云端」后暂停自动推送：否则本机数据会被立刻推回云端，清空就失去了意义。
 *  用户点一次「立即同步」（runSync 成功）即恢复。 */
let autoPushPaused = false;

function pauseAutoPush(): void {
  autoPushPaused = true;
  // 取消在途的自动推送：清空云端前 300ms 防抖窗口内的编辑，其定时器可能
  // 还没到点 —— 不取消就会在清空后又被推回云端（QA 报告的竞争窗口）。
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  pendingPayload = null;
}

function resumeAutoPush(): void {
  autoPushPaused = false;
}

/* ---------- 「清空全部数据」的封锁（否则 60 秒后数据自己长回来） ---------- */

/**
 * 本机被用户**显式清空**过的时间戳（存在设备本地，不进数据、不进云端）。
 *
 * 为什么必须单独存一份：`decideSyncAction` 里"本机为空 + 云端有数据 = 空机恢复"
 * 是正确规则（新设备该拉），但它分不清"新设备"和"用户刚清空"。
 * 不分清的后果：点完「清空全部数据」，60 秒轮询一到就 `pull-cloud`，
 * 整份数据原样回来了 —— 用户会以为"清空了又自己长回来"，像是见了鬼。
 *
 * 存 localStorage 而不是塞进 `settings`：这是**本机的意图**，不是数据内容。
 * 塞进 settings 会跟着云同步跑到别的设备上，把"我在这台清空了"变成
 * "所有设备都清空"，语义完全不对（而且要走持久化字段那一整套纪律）。
 */
const CLEARED_AT_KEY = 'dt:cleared-at:v1';

/** 记下"本机刚被清空"，并立刻停掉自动同步（推和拉都停） */
export function noteLocalCleared(): void {
  try {
    // 走统一访问器（隐私模式下 getLocalStorage 返回 null，不会抛）
    getLocalStorage()?.setItem(CLEARED_AT_KEY, new Date().toISOString());
  } catch {
    /* 写不进去也不影响：下面的内存封锁仍然生效 */
  }
  clearAutoSyncBlocked = true;
  // 清空后不该再有"待上传"：要推的是空，而空数据永远不该自动推
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  pendingPayload = null;
  clearOutbox();
}

/** 本机是否有"清空过"的标记（设置页用来给出提示；也供 runSync 判方向） */
export function getLocalClearedAt(): string | null {
  try {
    const raw = getLocalStorage()?.getItem(CLEARED_AT_KEY) ?? null;
    return raw && Number.isFinite(Date.parse(raw)) ? raw : null;
  } catch {
    return null;
  }
}

/** 用户点了「立即同步」→ 标记作废（这次就是他要的决定，恢复或推空都随他） */
export function clearLocalClearedMark(): void {
  try {
    getLocalStorage()?.removeItem(CLEARED_AT_KEY);
  } catch {
    /* 忽略 */
  }
}

/**
 * 「清空全部数据」后自动同步整体停摆（内存态，重启后由 `CLEARED_AT_KEY` 兜住）。
 * 与 `autoSyncPaused`（连续失败停摆）分开：两者原因不同、文案不同、解除条件也不同。
 */
let clearAutoSyncBlocked = false;

/** 是否因"清空过本机数据"而暂停了自动同步（设置页展示用） */
export function isAutoSyncBlockedByClear(): boolean {
  return clearAutoSyncBlocked;
}

/**
 * 排一次云端推送。与本机保存共用 `SAVE_DEBOUNCE_MS`，连续改动只推最后一次。
 * 未登录时 flushCloudPush 里 pullSnapshot 会直接返回 signed-out —— 不发请求、不报错。
 */
export function scheduleCloudPush(payload: PersistedPayload): void {
  if (autoPushPaused) {
    pendingPayload = null;
    return;
  }
  // 连续失败已停摆：不再每次保存都去撞一次墙（用户点「立即同步」成功即恢复）
  if (autoSyncPaused) {
    pendingPayload = null;
    return;
  }
  // 本机为空、而云端已知有数据（或还不知道云端情况）时，绝不自动推空数据上去。
  // ⚠️ "本机为空"必须是**全集合都空**（tasks/diary/notes/focusSessions/tombstones）：
  // 只数任务会把纯记事 / 纯日记设备当成空机，它的记事连排期都不会有。
  if (!hasAnyPersistedData(payload) && (getLastKnownRemoteCount() === null || (getLastKnownRemoteCount() ?? 0) > 0)) {
    pendingPayload = null;
    return;
  }
  pendingPayload = payload;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void flushCloudPush();
  }, SAVE_DEBOUNCE_MS);
}

/** 立即执行挂起的推送；没有挂起任务、或正在同步（已重新排期）时返回 null */
export async function flushCloudPush(): Promise<PushResult | null> {
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  const payload = pendingPayload;
  if (!payload) return null;

  // 上一轮同步还在飞：这次编辑不能直接丢，重新排一次，等它结束再补推
  if (getSyncStatus().syncing) {
    scheduleCloudPush(payload);
    return null;
  }

  /**
   * 离线：连试都不试。
   *
   * 为什么不在这一层直接发请求然后失败：那会走下面 `pulled.status === 'error'`
   * 的路径，连续 3 次就把自动同步停摆 —— 用户在地铁里改 3 条，出站之后
   * **自动同步已经不再跑了**，得手动点「立即同步」才行。这是 ⑦ 要修的核心症状。
   *
   * 正确做法：把"没送达"这件事落盘到 outbox（刷新也还在），
   * 然后由 `online` 事件触发补推（见 hooks/useAutoSync.ts）。
   */
  if (isBrowserOffline()) {
    markUndelivered(payload, 'offline');
    return null;
  }

  noteSyncStart();

  // 先拉云端：自动推送不是"本机说了算"，而是"拉下来合并后再推回去"。
  // 盲推会让另一台设备刚同步上去的增量，被本机的旧整包无声盖掉。
  const pulled = await pullSnapshot();
  if (pulled.status === 'signed-out') {
    pendingPayload = null;
    noteSyncFailure();
    return { status: 'signed-out' };
  }
  if (pulled.status === 'error') {
    // 拉失败：这次编辑先不推（宁可晚一步，也不能拿旧整包盖掉云端）。
    // payload 留在 pendingPayload 里，下一次编辑或页面隐藏时会顺带补推；
    // 同时落盘到 outbox —— 内存里的 pendingPayload 活不过一次刷新。
    noteSyncFailure();
    markUndelivered(payload, 'error');
    notifySyncError(syncErrorMessage(pulled.error));
    return null;
  }

  if (autoPushPaused) {
    // 拉取期间用户点了「清空云端」：这次推送作废，不吃回头草。
    // 本机数据仍在（usePersist 已落盘），点「立即同步」会推当前完整状态。
    noteSyncFailure();
    return null;
  }

  pendingPayload = null;
  // 合并本身已对脏数据兜底，这里再包一层：任何意外都不该变成
  // 未处理的 Promise rejection（那会让自动同步静默停摆）。
  // 真到那一步就推本机整包 —— 内容优先于时间，本机数据不会因此丢失。
  let merged: PersistedPayload;
  try {
    merged = pulled.snapshot ? mergeSnapshots(payload, pulled.snapshot.payload) : payload;
  } catch {
    merged = payload;
  }
  // 云端已是这份内容（稳态：本机保存过，但没有任何相对云端的增量）→ 不白写一次，
  // 也省掉「写→hydrate→保存→再推送」的级联。
  // 稳态同样意味着"本机内容云端已经有了" → 待上传队列可以直接清空。
  if (pulled.snapshot && isSameSnapshot(payload, pulled.snapshot.payload)) {
    noteRemoteCount(taskCountOf(merged));
    clearOutbox();
    noteSyncSuccess();
    return { status: 'ok', rowId: pulled.snapshot.id };
  }
  const result = await pushSnapshot(merged);
  if (result.status === 'ok') {
    noteRemoteCount(taskCountOf(merged));
    // 送达成功 → 待上传队列清空（这是"确实送到了"的唯一凭据，别在别处提前清）
    clearOutbox();
    noteSyncSuccess();
    // 云端有本机没有的内容（任务 / 日记 / 记事 / 专注记录任一）→ 把合并结果带回本机
    // （内容有差异才回调，避免触发保存环）。
    // ⚠️ 不能只看任务：只比任务的话，云端独有的记事永远 hydrate 不到本机。
    if (mergeHandler && snapshotDiffers(payload, merged)) mergeHandler(merged);
  } else {
    noteSyncFailure();
    if (result.status === 'error') {
      markUndelivered(merged, isBrowserOffline() ? 'offline' : 'error');
      notifySyncError(syncErrorMessage(result.error));
    }
  }
  return result;
}

/* ---------- 后台自动同步（定时拉 + 事件触发） ---------- */

/**
 * 为什么必须有它（"同步有时候不管用"的根因）：
 *
 * 原来只有**本机保存**才会触发同步（先拉后推）。也就是说：
 * 手机上改了任务 → 电脑打开后**只要不动任何东西**，就永远看不到那份改动，
 * 只有点了「立即同步」才发现数据不一致。用户感受到的就是"同步时灵时不灵"。
 *
 * 现在补上三个触发点：① 启动后拉一次 ② 每 60 秒拉一次（页面可见时）
 * ③ 切回前台 / 网络恢复时立刻拉一次。方向判定仍由 `runSync` 内部的
 * `decideSyncAction` 负责（内容优先、空数据绝不上推），**不新造一套方向逻辑**。
 */

/** 轮询间隔；页面隐藏时不轮询（省电，也避免后台标签页被节流后堆积请求） */
export const AUTO_SYNC_INTERVAL_MS = 60_000;
/** 启动后首次自动同步的延迟：先让首屏渲染完，不与启动装载抢资源 */
export const AUTO_SYNC_BOOT_DELAY_MS = 2_500;
/** 两次自动同步之间的最小间隔：事件（可见性 / 联网）触发不能把轮询打爆 */
const AUTO_SYNC_MIN_GAP_MS = 15_000;

let autoSyncRunning = false;
let lastAutoSyncAt = 0;

/**
 * 跑一次后台自动同步。
 *
 * 与用户点「立即同步」的区别只有两点：失败走节流提示 + 连续失败会停摆；
 * 成功时把云端回来的内容经 mergeHandler 装回本机（与自动推送同一出口）。
 * 未登录 / 环境不支持 / 上一次还在飞 → 安静地什么都不做，绝不打扰。
 */
export async function runAutoSync(
  getLocal: () => PersistedPayload | null,
): Promise<SyncOutcome | null> {
  if (autoSyncPaused) return null;
  if (autoSyncRunning || getSyncStatus().syncing) return null;
  /**
   * 用户清空过本机数据：整轮跳过。
   *
   * 内存标志 `clearAutoSyncBlocked` 只在本次运行有效，重启之后还得靠
   * `getLocalClearedAt()` 这个落盘标记接住 —— 否则"清空 → 立刻杀掉应用 →
   * 再打开"，60 秒后那套规则又会把云端的数据原样拉回来。
   * 解除条件只有一个：用户点「立即同步」（见 runSync 的 manual 分支）。
   */
  if (clearAutoSyncBlocked || getLocalClearedAt()) return null;
  /**
   * 离线：**直接放过这一轮**，不去撞墙。
   *
   * 两个关键点：
   * ① 不累计失败次数 —— 否则用户在没网的地方待一会儿（60 秒轮询 3 次）就会把
   *    自动同步永久停摆，回到有网的地方也不再自动跑，必须手动点一次；
   * ② **在设 `lastAutoSyncAt` 之前返回** —— 否则线上恢复时 `online` 事件触发的
   *    那次同步会被"最小间隔 15 秒"挡掉（离线期间那次"尝试"白占了时间片）。
   */
  if (isBrowserOffline()) return null;
  const now = Date.now();
  if (now - lastAutoSyncAt < AUTO_SYNC_MIN_GAP_MS) return null;
  lastAutoSyncAt = now;
  autoSyncRunning = true;
  try {
    const outcome = await runSync(getLocal());
    if (outcome.status === 'error') {
      autoSyncFailures += 1;
      if (autoSyncFailures >= AUTO_SYNC_FAIL_LIMIT) {
        autoSyncPaused = true;
        // 停摆这件事必须让人知道一次 —— 否则"同步悄悄不跑了"更难查
        notifySyncError(AUTO_SYNC_PAUSED_MESSAGE, true);
      } else {
        notifySyncError(syncErrorMessage(outcome.error));
      }
      return outcome;
    }
    // 未登录是合法状态，不算失败（否则新装的应用 3 次轮询就被停摆）
    if (outcome.status === 'signed-out') return outcome;
    autoSyncFailures = 0;
    if (outcome.status === 'pulled' || outcome.status === 'merged') {
      mergeHandler?.(outcome.payload);
    }
    return outcome;
  } catch {
    // runSync 内部已兜底所有异常；这里只是绝不让轮询冒出未处理 rejection
    // （那会让 setInterval 后的每一轮都静默失败）
    return null;
  } finally {
    autoSyncRunning = false;
  }
}

/**
 * 一次完整的双向同步：拉云端 → 用 decideSyncAction 判方向 →
 * 推 / 拉 / 合并 / 什么都不做。返回给调用方（设置页）一句话状态，由它决定 Toast 文案。
 *
 * - 两边都有数据 → `merged`：任务级合并后推上去，两台设备以此收敛，谁都不丢
 *   （绝不按时间整包互盖 —— 那是"一边新增的任务被另一边无声吞掉"的根源）；
 *
 * @param local 本机数据；`null` 表示"本机从未落盘过"（新设备），此时只要云端有
 *              数据就一定走恢复分支，绝不会把空数据推上去覆盖云端。
 */
export type SyncOutcome =
  | { status: 'pushed' }
  | { status: 'pulled'; payload: PersistedPayload }
  | { status: 'merged'; payload: PersistedPayload }
  | { status: 'unchanged' }
  | { status: 'signed-out' }
  | { status: 'error'; error: SyncErrorInfo };

export interface RunSyncOptions {
  /**
   * 用户主动点「立即同步」。**必须显式传** —— 自动同步与手动同步在
   * "清空过云端 / 清空过本机"这两种状态下行为不同，靠猜会猜错：
   * - 手动：解除所有封锁，按用户意图走（本机空 → 恢复，本机有 → 推）；
   * - 自动：尊重封锁，绝不在用户刚清空之后把数据推上去或拉回来。
   */
  manual?: boolean;
}

export async function runSync(
  local: PersistedPayload | null,
  options: RunSyncOptions = {},
): Promise<SyncOutcome> {
  const manual = options.manual === true;
  /**
   * 用户主动点「立即同步」= 他对"清空过"这件事重新做了决定：
   * 标记作废、封锁解除，之后按正常规则走（本机空 + 云有数据 → 恢复，正是提示语说的）。
   */
  if (manual) {
    clearAutoSyncBlocked = false;
    clearLocalClearedMark();
  }
  noteSyncStart();
  try {
    const pulled = await pullSnapshot();
    if (pulled.status === 'signed-out') return { status: 'signed-out' };
    if (pulled.status === 'error') {
      // 没连上 / 被拒：本机改动还没送达，落盘记一笔，下次启动或联网时补推
      markUndelivered(local, isBrowserOffline() ? 'offline' : 'error');
      return { status: 'error', error: pulled.error };
    }

    if (!manual && clearAutoSyncBlocked) return { status: 'unchanged' };

    const action = decideSyncAction(local, pulled.snapshot);

    /**
     * 「清空云端」之后只拦住"往云端写"的方向：拉取仍然允许（那是把云端恢复
     * 回来，用户没要求）；但推送会把刚删掉的那一行重建出来，清空就白做了。
     */
    if (!manual && autoPushPaused && (action === 'push-local' || action === 'merge')) {
      return { status: 'unchanged' };
    }
    if (action === 'pull-cloud' && pulled.snapshot) {
      resumeAutoPush();
      // 拉云端意味着本机是空的（decideSyncAction 的判定），没有"待上传"可言
      clearOutbox();
      noteSyncSuccess();
      return { status: 'pulled', payload: pulled.snapshot.payload };
    }
    if (action === 'merge' && local && pulled.snapshot) {
      // 两边都有数据：合并后推上去，并把合并结果返回给调用方 hydrate，
      // 两台设备以此收敛到同一份任务集，谁都不丢。
      const merged = mergeSnapshots(local, pulled.snapshot.payload);
      const pushed = await pushSnapshot(merged);
      if (pushed.status === 'signed-out') return { status: 'signed-out' };
      if (pushed.status === 'error') {
        markUndelivered(merged, isBrowserOffline() ? 'offline' : 'error');
        return { status: 'error', error: pushed.error };
      }
      resumeAutoPush();
      clearOutbox();
      noteSyncSuccess();
      return { status: 'merged', payload: merged };
    }
    if (action === 'none') {
      resumeAutoPush();
      // 两边内容一致 = 云端已经有这份内容 → 没有待上传
      clearOutbox();
      noteSyncSuccess();
      return { status: 'unchanged' };
    }

    // 判出来该上推、但本机其实没有数据（两边都空）：没有可推的东西，不算失败
    if (!local) {
      resumeAutoPush();
      clearOutbox();
      noteSyncSuccess();
      return { status: 'unchanged' };
    }

    const pushed = await pushSnapshot(local);
    if (pushed.status === 'signed-out') return { status: 'signed-out' };
    if (pushed.status === 'error') {
      markUndelivered(local, isBrowserOffline() ? 'offline' : 'error');
      return { status: 'error', error: pushed.error };
    }
    // 用户显式同步成功 → 恢复自动推送（清空云端后的暂停到此解除）
    resumeAutoPush();
    clearOutbox();
    noteSyncSuccess();
    return { status: 'pushed' };
  } catch {
    markUndelivered(local, 'error');
    noteSyncFailure();
    return { status: 'error', error: { code: null, message: '同步失败，数据仍在本机', status: null } };
  } finally {
    if (getSyncStatus().syncing) setSyncStatus({ syncing: false });
  }
}

/** 「上次同步：HH:MM」；非法时间返回 null */
export function formatSyncTime(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
