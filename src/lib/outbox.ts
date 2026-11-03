import { OUTBOX_KEY, OUTBOX_MAX_ENTRIES } from '../constants';
import { getLocalStorage } from './storage';
import { toMillis } from './fieldClock';

/* ============================================================================
   离线写入队列（outbox）
   ----------------------------------------------------------------------------
   要解决的问题（用户报过"地铁里改的东西回来就没了"的同类现象）：

   原来本机保存 → 300ms 防抖 → 先拉云端再合并推回。**离线时**这条链路从第一
   步就断了：拉取失败 → 这次改动只留在内存里的 `pendingPayload`。
   接着连续失败 3 次 → 自动同步整个停摆（`autoSyncPaused`）。用户看到的是
   "地铁里改了 5 条，出站以后一条都没上去，隔天开机才发现"。刷新 / 关掉
   应用更是直接把"还有东西没送达"这件事忘得一干二净。

   这个队列只记**一件事**：本机还有 N 条改动没确认送达云端。
   - 落盘（`OUTBOX_KEY`，设备本地）→ 刷新、关闭、第二天开机都还记得；
   - 有了它，启动时 / 网络恢复时可以**立刻补推**，不用等用户发现；
   - 送达成功（推 / 合并 / 稳态）就清空。

   ⚠️ 为什么"重放"不是逐条回放操作：
   服务端是**快照式** API（一次写整包）。逐条回放中间态会把一堆过时快照推
   上去，对端每拉一次就回滚一次 —— 那比不同步更糟。快照式同步的正确重放
   就是"把**最新**的那一份推上去"，而最新的那一份本机本来就有（已落盘）。
   所以队列负责的是"**要不要推**"和"**按什么顺序/理由推**"，
   而不是"逐条重演历史"。这也是它只存 `{ at, reason }` 而不存内容的原因。
   ========================================================================= */

/** 没送达的原因：离网 / 请求失败。只影响给用户看的措辞与折叠策略 */
export type OutboxReason = 'offline' | 'error';

export interface OutboxEntry {
  /** 入队时间（ISO）。同时充当顺序号：队列按它升序 */
  at: string;
  reason: OutboxReason;
}

export interface OutboxState {
  /** 未送达的改动，**按发生顺序**排列（最早的在前） */
  entries: OutboxEntry[];
  /** 因为超过上限被折叠掉的条数（语义上仍然"待上传"，只是不再逐条记） */
  dropped: number;
}

/** 同一个原因的连续入队，间隔小于这个值就**合并成一条**（只把时间推后） */
const COALESCE_MS = 5_000;

export function emptyOutbox(): OutboxState {
  return { entries: [], dropped: 0 };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isReason(value: unknown): value is OutboxReason {
  return value === 'offline' || value === 'error';
}

/**
 * 收敛队列：脏数据（手改 JSON / 旧格式 / 本地存储被别的标签页写坏）一律降级为
 * **空队列**，绝不抛异常 —— 队列只是"要不要补推"的提示，坏掉最多多试一次同步，
 * 不能让一个解析错误把整个保存链路炸掉。
 */
export function sanitizeOutbox(raw: unknown): OutboxState {
  const rec = asRecord(raw);
  if (!rec) return emptyOutbox();
  const list = Array.isArray(rec.entries) ? rec.entries : [];
  const entries: OutboxEntry[] = [];
  for (const item of list) {
    const entry = asRecord(item);
    if (!entry) continue;
    const at = typeof entry.at === 'string' ? entry.at : '';
    if (toMillis(at) <= 0) continue;
    entries.push({ at, reason: isReason(entry.reason) ? entry.reason : 'error' });
  }
  // 排序保证"最早的在前"这一性质不依赖写入顺序（旧版本 / 手改都可能乱序）
  entries.sort((a, b) => toMillis(a.at) - toMillis(b.at));
  const droppedRaw = Number(rec.dropped);
  const dropped = Number.isFinite(droppedRaw) && droppedRaw > 0 ? Math.trunc(droppedRaw) : 0;
  return { entries: trim(entries), dropped };
}

/** 超出上限就从**最旧的**开始折叠（丢的是明细，不是"待上传"这个事实） */
function trim(entries: OutboxEntry[]): OutboxEntry[] {
  if (entries.length <= OUTBOX_MAX_ENTRIES) return entries;
  return entries.slice(entries.length - OUTBOX_MAX_ENTRIES);
}

/**
 * 入队一次"本机有改动、还没送达"。
 *
 * 折叠规则：**队尾**是同原因、且时间在 `COALESCE_MS` 内 → 只把时间推后，
 * 不新增一条。理由：离线时用户可能连续改十几次（每次保存都入队），
 * 逐条记只会把队列刷满 20 条，反而看不出"这是同一段离线编辑"。
 */
export function enqueueOutbox(state: OutboxState, at: string, reason: OutboxReason): OutboxState {
  const base = state ?? emptyOutbox();
  const entries = Array.isArray(base.entries) ? [...base.entries] : [];
  const last = entries[entries.length - 1];
  if (last && last.reason === reason && toMillis(at) - toMillis(last.at) <= COALESCE_MS) {
    entries[entries.length - 1] = { at, reason };
    return { entries, dropped: base.dropped ?? 0 };
  }
  entries.push({ at, reason });
  const overflow = Math.max(0, entries.length - OUTBOX_MAX_ENTRIES);
  return {
    entries: trim(entries),
    dropped: (base.dropped ?? 0) + overflow,
  };
}

/** 待上传条数（超限折叠掉的也计入 —— 它们同样是"还没送达"） */
export function pendingCount(state: OutboxState): number {
  if (!state) return 0;
  const count = Array.isArray(state.entries) ? state.entries.length : 0;
  return count + (state.dropped ?? 0);
}

/** 最近一条未送达的原因（给界面措辞用）；空队列 → null */
export function latestReason(state: OutboxState): OutboxReason | null {
  const entries = state?.entries ?? [];
  return entries.length > 0 ? entries[entries.length - 1].reason : null;
}

/* ---------- 设备本地存储（永不抛） ---------- */


export function readOutbox(): OutboxState {
  try {
    const ls = getLocalStorage();
    if (!ls) return emptyOutbox();
    const raw = ls.getItem(OUTBOX_KEY);
    if (!raw) return emptyOutbox();
    return sanitizeOutbox(JSON.parse(raw) as unknown);
  } catch {
    return emptyOutbox();
  }
}

export function writeOutbox(state: OutboxState): void {
  try {
    const ls = getLocalStorage();
    if (!ls) return;
    ls.setItem(OUTBOX_KEY, JSON.stringify(state));
  } catch {
    /* 配额满 / 隐私模式：写不进去最多导致下次少补推一次，绝不因此加抛 */
  }
}

/** 记一次"没送达"（读 → 入队 → 写），返回写后的状态 */
export function recordUndelivered(at: string, reason: OutboxReason): OutboxState {
  const next = enqueueOutbox(readOutbox(), at, reason);
  writeOutbox(next);
  return next;
}

/** 送达成功：清空（**只在确认云端已拿到本机内容时调用**） */
export function clearOutbox(): void {
  try {
    const ls = getLocalStorage();
    if (!ls) return;
    ls.removeItem(OUTBOX_KEY);
  } catch {
    /* 忽略：下次同步成功会再清一次 */
  }
}

/** 还有没有没送达的改动（启动 / 联网时据此决定"立刻补推一次"） */
export function hasPendingOutbox(): boolean {
  return pendingCount(readOutbox()) > 0;
}

/** 待上传条数（界面展示用） */
export function getPendingCount(): number {
  return pendingCount(readOutbox());
}
