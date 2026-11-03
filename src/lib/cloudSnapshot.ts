import type { PersistedPayload } from '../types';
import { SYNC_HISTORY_TABLE, SYNC_TABLE, cloud } from './cloud';
import { mergeSnapshots } from './merge';
import {
  UNAUTHORIZED_STATUS,
  isUniqueViolation,
  permissionDeniedError,
  toSyncError,
  type SyncErrorInfo,
} from './syncErrors';
import type { CloudSnapshotMeta } from './syncDecision';

/* ============================================================================
   云端"行"的读写（Supabase 那一层）
   ----------------------------------------------------------------------------
   从 `lib/cloudSync.ts`（930 行）按**依赖什么**切出来的第一层：
   这一层只做"把一行读出来 / 写回去 / 删掉 / 列历史"，不判断方向、不做合并、
   不管失败停摆 —— 那些是编排层（cloudSync）的事。

   好处很直接：想换掉 Supabase（比如换成本地 mock 或别的后端），
   只需要替换这一个文件；而"什么时候推、推什么、推失败了怎么办"完全不用动。

   唯一的共享可变状态是 `lastKnownRemoteCount`（云端已知有几条任务）：
   读写都在这一层，编排层通过 `getLastKnownRemoteCount()` 只读地拿它做判断
   （"本机为空而云端已知有数据时，绝不自动推空"）。
   ========================================================================= */

export interface CloudSnapshot extends CloudSnapshotMeta {
  id: number;
}

/** 载荷里有多少条任务（脏数据兜底为 0） */
function taskCountOf(payload: PersistedPayload | null | undefined): number {
  return payload && Array.isArray(payload.tasks) ? payload.tasks.length : 0;
}

/**
 * 最近一次已知的云端任务数。自动推送是"只写不读"时的时间兜底，
 * 防止空本机数据把云端真实数据盖掉。需要清空云端请走「立即同步」。
 */
let lastKnownRemoteCount: number | null = null;

/** 编排层只读访问（判断"本机为空时要不要跳过自动推送"） */
export function getLastKnownRemoteCount(): number | null {
  return lastKnownRemoteCount;
}

/**
 * 写入口：`pull`（拉到几条）、`clear`（清零）、以及编排层推送成功后（推上去几条）。
 * 统一走函数而不是各写 `lastKnownRemoteCount = ...`，是为了让"谁能改它"
 * 一眼可查 —— 拆文件时最容易漏的就是这种藏在别处的可变状态。
 */
export function noteRemoteCount(count: number | null): void {
  lastKnownRemoteCount = count;
}

export type PullResult =
  | { status: 'ok'; snapshot: CloudSnapshot | null }
  | { status: 'signed-out' }
  | { status: 'error'; error: SyncErrorInfo };

export type PushResult =
  | { status: 'ok'; rowId: number }
  | { status: 'signed-out' }
  | { status: 'error'; error: SyncErrorInfo };

/* ---------- 拉取 / 推送 / 清空 ---------- */

/** auth 门禁：无会话返回 true —— 调用方直接走 signed-out 分支，不发任何云端读写 */
/**
 * 「现在到底有没有登录」——**三态**，不是布尔。
 *
 * 曾经这里写的是 `return Boolean(error) || !data`：只要拿 session 出错就判"未登录"。
 * 可 `getSession()` 在 token 需要续期时会**发网络请求**，于是
 * 网络一抖（或桌面端 Origin 改写偶发失败）就被判成"掉登录"→
 * 设置页把用户显示成未登录、还弹"登录状态已失效，请重新登录" ——
 * 用户以为要重登，其实凭据好好躺在 localStorage 里。
 * 这正是「每次更新或打开，登录总是掉」的根因。
 *
 * 现在只有两种情况算**真未登录**：
 * ① 拿得到响应且根本没有 session（data 空、error 也空）；
 * ② 错误明确是"会话失效"类（401 / invalid_grant / invalid_token / refresh token 失效）。
 * 其余（网络、超时、未知）一律报 `unknown`，由上层按"同步失败"处理，
 * **绝不据此清掉登录态**。
 */
type SessionPresence =
  | { state: 'signed-in' }
  | { state: 'signed-out' }
  | { state: 'unknown'; error: SyncErrorInfo };

/** 这些错误码/状态码说明"这个会话确实不能再用了"，其余都当临时故障 */
function isSessionInvalid(info: SyncErrorInfo): boolean {
  if (info.status === UNAUTHORIZED_STATUS) return true;
  const text = `${info.code ?? ''} ${info.message}`.toLowerCase();
  return (
    text.includes('invalid_grant') ||
    text.includes('invalid_token') ||
    text.includes('invalid refresh token') ||
    text.includes('refresh_token') ||
    text.includes('session_not_found') ||
    text.includes('jwt expired')
  );
}

export async function readSessionPresence(): Promise<SessionPresence> {
  try {
    const { data, error } = await cloud.auth.getSession();
    if (data) return { state: 'signed-in' };
    if (!error) return { state: 'signed-out' };
    const info = toSyncError(error);
    return isSessionInvalid(info) ? { state: 'signed-out' } : { state: 'unknown', error: info };
  } catch (thrown) {
    const info = toSyncError(
      thrown && typeof thrown === 'object'
        ? (thrown as { message?: string; code?: string; status?: number })
        : null,
    );
    return { state: 'unknown', error: info };
  }
}

/** 取云端最新一行；没有数据返回 null（首次使用，不是错误） */
export async function pullSnapshot(): Promise<PullResult> {
  try {
    const presence = await readSessionPresence();
    if (presence.state === 'signed-out') return { status: 'signed-out' };
    if (presence.state === 'unknown') return { status: 'error', error: presence.error };

    const { data, error } = await cloud.database
      .from(SYNC_TABLE)
      .select('id, payload, saved_at')
      .order('saved_at', { ascending: false })
      .limit(1);

    if (error) return { status: 'error', error: toSyncError(error) };

    const row = Array.isArray(data) && data.length > 0 ? data[0] : null;
    if (!row) {
      noteRemoteCount(0);
      return { status: 'ok', snapshot: null };
    }

    noteRemoteCount(taskCountOf(row.payload));
    return {
      status: 'ok',
      snapshot: {
        id: row.id,
        payload: row.payload,
        savedAt: typeof row.saved_at === 'string' ? row.saved_at : '',
        taskCount: taskCountOf(row.payload),
      },
    };
  } catch {
    return { status: 'error', error: { code: null, message: '同步失败，数据仍在本机', status: null } };
  }
}

/** 取云端最新一行的 id；没有行返回 null（首次使用，不是错误） */
async function findLatestRowId(): Promise<
  { ok: true; id: number | null } | { ok: false; error: SyncErrorInfo }
> {
  const { data, error } = await cloud.database
    .from(SYNC_TABLE)
    .select('id')
    .order('saved_at', { ascending: false })
    .limit(1);
  if (error) return { ok: false, error: toSyncError(error) };
  const id = Array.isArray(data) && data.length > 0 ? data[0]?.id : null;
  return { ok: true, id: typeof id === 'number' ? id : null };
}

/** 取云端最新一行（含 payload）：并发首同恢复时用来合并，避免整包覆盖对方刚写的数据 */
async function findLatestRowWithPayload(): Promise<
  { ok: true; id: number | null; payload: PersistedPayload | null } | { ok: false; error: SyncErrorInfo }
> {
  const { data, error } = await cloud.database
    .from(SYNC_TABLE)
    .select('id, payload')
    .order('saved_at', { ascending: false })
    .limit(1);
  if (error) return { ok: false, error: toSyncError(error) };
  const row = Array.isArray(data) && data.length > 0 ? data[0] : null;
  if (!row) return { ok: true, id: null, payload: null };
  const payload =
    row.payload && typeof row.payload === 'object' ? (row.payload as PersistedPayload) : null;
  return { ok: true, id: typeof row.id === 'number' ? row.id : null, payload };
}

type WriteOutcome =
  | { status: 'ok'; rowId: number }
  /** 写生效行数 0：RLS 拦截，或行刚被另一台设备删掉 */
  | { status: 'missing' }
  | { status: 'error'; error: SyncErrorInfo };

async function insertSnapshot(payload: PersistedPayload, savedAt: string): Promise<WriteOutcome> {
  // 不传 owner_id —— 由数据库 DEFAULT auth.uid() 填充
  const { data, error } = await cloud.database
    .from(SYNC_TABLE)
    .insert({ payload, saved_at: savedAt })
    .select('id');
  if (error) return { status: 'error', error: toSyncError(error) };
  // RLS 拒绝了这次 insert：PostgREST 不报错、只返空数组 —— 按权限口径上报
  if (!Array.isArray(data) || data.length === 0) return { status: 'error', error: permissionDeniedError() };
  return { status: 'ok', rowId: data[0].id };
}

async function updateSnapshot(rowId: number, payload: PersistedPayload, savedAt: string): Promise<WriteOutcome> {
  const { data, error } = await cloud.database
    .from(SYNC_TABLE)
    .update({ payload, saved_at: savedAt })
    .eq('id', rowId)
    .select();
  if (error) return { status: 'error', error: toSyncError(error) };
  // 空数组意味着 RLS 拦了或行已不存在 —— 那是失败，绝不能当成成功
  if (!Array.isArray(data) || data.length === 0) return { status: 'missing' };
  return { status: 'ok', rowId };
}

/**
 * 一轮写入：取最新行 → 有则 update，无则 insert。
 *
 * - update 生效 0 行：行可能刚被另一台设备删掉 → 重抢行 id 后再 update；
 *   行真的没了才落到 insert 重建（防止把"并发删除"误判成 RLS 拦截）。
 * - insert 撞唯一冲突（23505）：另一台设备抢先建了行 → 拉下它的 payload
 *   与入参**合并**后再 update，绝不把冲突抛给用户、更不拿整包覆盖对方的数据。
 * - 重抢后行还在却仍然写不进 → `missing`，由 pushSnapshot 整体重试一次后按权限口径收口。
 */
async function writeLatest(payload: PersistedPayload, savedAt: string): Promise<WriteOutcome> {
  const found = await findLatestRowId();
  if (!found.ok) return { status: 'error', error: found.error };

  if (found.id !== null) {
    const updated = await updateSnapshot(found.id, payload, savedAt);
    if (updated.status !== 'missing') return updated;
    // update 生效 0 行：行可能刚被另一台设备删掉 → 重抢一次行 id
    const raced = await findLatestRowId();
    if (!raced.ok) return { status: 'error', error: raced.error };
    if (raced.id !== null) {
      const again = await updateSnapshot(raced.id, payload, savedAt);
      if (again.status !== 'missing') return again;
      // 行还在却仍然写不进：RLS 真拦截 → 整体重试也无害，按 missing 上交
      return { status: 'missing' };
    }
    // 行真的没了 → 落到 insert 分支重建
  }

  const inserted = await insertSnapshot(payload, savedAt);
  if (inserted.status !== 'error' || !isUniqueViolation(inserted.error)) return inserted;

  // 并发首同：另一台设备抢先建了行 → 拉下它写的 payload 与入参**合并**后再 update。
  // 直接覆盖会把对方刚同步上去的任务无声吞掉（QA 对抗验证发现的真实丢失路径：
  // 两台都从未同步、各有任务时，后 insert 的那台会用本机整包盖掉先 insert 的）。
  const raced = await findLatestRowWithPayload();
  if (!raced.ok) return { status: 'error', error: raced.error };
  if (raced.id !== null) {
    const toWrite = raced.payload ? mergeSnapshots(payload, raced.payload) : payload;
    return await updateSnapshot(raced.id, toWrite, savedAt);
  }
  // 极端：行又没了（对方秒删）→ 再试一次 insert
  return await insertSnapshot(payload, savedAt);
}

/**
 * 整包写入云端：已有行 update，没有则 insert。
 *
 * ⚠️ update / insert 后**必须**看返回数组长度：空数组意味着 RLS 拦了或行已不存在，
 * 那是失败，绝不能当成成功（PostgREST 在 RLS 拒绝写时不报错、只返空数组）。
 */
export async function pushSnapshot(payload: PersistedPayload): Promise<PushResult> {
  try {
    const presence = await readSessionPresence();
    if (presence.state === 'signed-out') return { status: 'signed-out' };
    if (presence.state === 'unknown') return { status: 'error', error: presence.error };
    const savedAt = new Date().toISOString();

    const first = await writeLatest(payload, savedAt);
    if (first.status !== 'missing') {
      return first.status === 'ok'
        ? { status: 'ok', rowId: first.rowId }
        : { status: 'error', error: first.error };
    }
    // 第一轮写生效 0 行：重抢一次。仍写不动才按权限口径上报
    // （RLS 真拦截时重试也无效，但多一次尝试的代价只是一次请求）。
    const second = await writeLatest(payload, savedAt);
    if (second.status === 'ok') return { status: 'ok', rowId: second.rowId };
    if (second.status === 'error') return { status: 'error', error: second.error };
    return { status: 'error', error: permissionDeniedError() };
  } catch {
    return { status: 'error', error: { code: null, message: '同步失败，数据仍在本机', status: null } };
  }
}

/* ---------- 历史版本（误删 / 坏数据的最后一道退路） ---------- */

/** 一个被存档下来的旧版本（只带元信息，不带 payload，避免整包拉下来） */
export interface HistoryEntry {
  id: number;
  /** 这个版本当时的 saved_at */
  savedAt: string;
  /** 被存档下来的时刻（排序用它） */
  archivedAt: string;
  taskCount: number;
  /** 存档原因：`UPDATE` 被新数据覆盖 / `DELETE` 云端被清空 */
  reason: string;
}

export type HistoryResult =
  | { status: 'ok'; entries: HistoryEntry[] }
  | { status: 'signed-out' }
  | { status: 'error'; error: SyncErrorInfo };

/**
 * 列出最近的历史版本（新的在前）。
 *
 * 存档由数据库触发器在每次覆盖/删除前自动写入，所以「清空云端」也会留下一份 ——
 * 误删之后仍然回得来。空数组是正常结果（还没产生过覆盖），不是错误。
 */
export async function listHistory(limit = 20): Promise<HistoryResult> {
  try {
    const presence = await readSessionPresence();
    if (presence.state === 'signed-out') return { status: 'signed-out' };
    if (presence.state === 'unknown') return { status: 'error', error: presence.error };

    const { data, error } = await cloud.database
      .from(SYNC_HISTORY_TABLE)
      .select('id, payload, saved_at, archived_at, archived_reason')
      .order('archived_at', { ascending: false })
      .limit(limit);
    if (error) return { status: 'error', error: toSyncError(error) };

    const rows = Array.isArray(data) ? data : [];
    return {
      status: 'ok',
      entries: rows.map((row) => ({
        id: typeof row.id === 'number' ? row.id : 0,
        savedAt: typeof row.saved_at === 'string' ? row.saved_at : '',
        archivedAt: typeof row.archived_at === 'string' ? row.archived_at : '',
        taskCount: taskCountOf(row.payload),
        reason: typeof row.archived_reason === 'string' ? row.archived_reason : '',
      })),
    };
  } catch {
    return { status: 'error', error: { code: null, message: '读取历史版本失败', status: null } };
  }
}
