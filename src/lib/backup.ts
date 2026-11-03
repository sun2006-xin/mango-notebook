/* ============================================================================
   备份的**唯一解析入口**（F4）

   为什么只能有这一个入口：
   `hydrateFromPayload` 是全工程唯一允许"把一份 payload 装回状态"的地方，
   它之前已经被"四份手抄 HYDRATE"坑过一次（见 store/reducer.ts 的注释）。
   备份恢复如果再手抄一份装载逻辑，加字段时又会漏（漏 tombstones = 回收站空、
   漏 focusSessions = 专注记录消失），而且编译不报错、只在恢复后才暴露。

   所以本文件只做两件事：
   - `parseBackupJson`：JSON → migrate → PersistedPayload | null（**永不抛**）
   - `listLocalBackups`：桌面端备份目录的列表
   视图层拿到 payload 后**只允许** `dispatch(hydrateFromPayload(payload, null))`。
   ========================================================================= */

import { migrate } from './storage';
import { listDesktopBackups, type LocalBackupEntry } from './desktopBackup';
import type { PersistedPayload } from '../types';

/**
 * 这份 JSON 看起来像不像一份载荷。
 *
 * 为什么在 migrate 之前还要多这一道：`migrate({})` 是**能成功**的 ——
 * 它会把任意对象补成"全空的合法载荷"。于是用户随手选了个 package.json，
 * 恢复流程就会拿到一份空载荷并把本机数据全清掉。
 * 所以要求至少满足其一：有数字型 schemaVersion，或有任意一个集合是数组。
 */
function looksLikePayload(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const rec = raw as Record<string, unknown>;
  if (Number.isFinite(Number(rec.schemaVersion))) return true;
  return COLLECTIONS.some((key) => Array.isArray(rec[key]));
}

const COLLECTIONS = ['tasks', 'diary', 'notes', 'focusSessions', 'tombstones'] as const;

/**
 * 解析一份备份文件内容。
 *
 * 四种失败都必须返回 null 而不是抛异常：
 * - 不是 JSON（用户选错了文件 / 文件被截断）
 * - 形状不像载荷（`[]` / `{}` / 一个 txt 被改名成 .json）
 * - schemaVersion 比当前版本高（降级安装，不能瞎装载）
 * - 结构完全坏掉（migrate 返回 null）
 *
 * `migrate` 内部已经做了字段级兜底与版本保护，这里只负责前面两道闸。
 */
export function parseBackupJson(text: string): PersistedPayload | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!looksLikePayload(raw)) return null;
  try {
    return migrate(raw);
  } catch {
    return null;
  }
}

/**
 * 本机可恢复的备份列表。
 *
 * 只有桌面端有"文件备份"这个概念；网页 / 安卓的兜底是 localStorage 里的
 * 双快照（SNAPSHOT + SNAPSHOT_PREV），由 storage.ts 自动回退，不需要用户选。
 */
export async function listLocalBackups(): Promise<LocalBackupEntry[]> {
  return listDesktopBackups();
}
