import type { Task, TaskFieldAt, TaskSyncField } from '../types';

/* ============================================================================
   字段级时钟（云同步"按字段择优"的基础设施）
   ----------------------------------------------------------------------------
   问题：合并原来是**整条任务**比 `updatedAt`，新者整条胜。
   两台设备同时改同一条任务的不同字段 —— 电脑改标题、手机改备注 ——
   合并时只有一个赢家，另一方的改动**无声消失**。这是云同步已知的口径缺陷。

   解法：给每个可同步字段记一个"最后改动时间"，合并时逐字段比。
   本文件只做三件纯事：
     ① `fieldClockOf` 把"这个字段什么时候变的"解析成一个 ISO 串（缺失回落 updatedAt）；
     ② `stampChangedFields` 比较前后两条任务，算出这次改了哪些字段；
     ③ `sanitizeFieldAt` 把脏数据（手改 JSON / 老端推上来的）收敛成合法的时钟表。

   ⚠️ 打点**不在**各个 action 里做，统一由 `store/fieldClock.ts` 的 reducer 收尾调用
   ②（46 个 action 手写必然漏，漏了不报错，只在"改动被别的设备吃掉"时暴露）。
   ========================================================================= */

/**
 * 参与字段级合并的任务字段（顺序即合并时的遍历顺序，**不要随手调换**：
 * 调换会让时钟对象的键序变化，虽然内容等价，但会给排查 diff 添麻烦）。
 *
 * 不含 `doneAt`（跟随 `done`）、`createdAt`（取更早的）、`updatedAt`（由结果推出）。
 */
export const TASK_SYNC_FIELDS: readonly TaskSyncField[] = [
  'title',
  'note',
  'date',
  'endDate',
  'time',
  'repeat',
  'priority',
  'category',
  'done',
  'parentId',
  'estimatedMinutes',
  'order',
];

/** ISO → 毫秒；非法/缺失一律 0（合并里到处要比时间，不能让 NaN 漏进比较） */
export function toMillis(iso: string | null | undefined): number {
  if (typeof iso !== 'string' || !iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 取某个字段的时钟：字段自己的记录优先，**缺失回落到 `createdAt`**。
 *
 * 为什么回落的是 `createdAt` 而不是 `updatedAt` —— 这一条是字段级合并能否成立的关键：
 *
 * 「这条任务有 `fieldAt`、但没有字段 F 的记录」= **F 从建任务起就没被单独改过**
 * （新代码改动任何字段都会打点）。它的值最早、最不该赢。
 * 如果回落成 `updatedAt`（"这条任务最后被改的时间"），就会出现：
 * 手机改过标题 → 整条 updatedAt 变成 11:00 → 电脑在 09:00 改的备注
 * 在合并时被判成"电脑的备注更旧"，**电脑那次备注改动被无声吃掉** ——
 * 正是这个功能要消灭的现象。
 *
 * 反过来，`createdAt` 是"这个值至少从建任务起就没动过"的诚实下界：
 * 只要对端**真的**改过 F，它的时间戳一定晚于任何一侧的 createdAt，必然获胜。
 *
 * 老数据（**整条**没有 `fieldAt`）不走这里 —— `mergeTaskPair` 会先短路成整条 LWW，
 * 那种"完全没有逐字段信息"的情况不能靠猜。
 */
export function fieldClockOf(task: Task, field: TaskSyncField): string {
  const at = task.fieldAt?.[field];
  if (typeof at === 'string' && toMillis(at) > 0) return at;
  return task.createdAt;
}

/** 一条任务的全部字段都打上同一个时间（用于给无时钟的老数据补点） */
export function fullFieldClock(at: string): TaskFieldAt {
  const clock: TaskFieldAt = {};
  for (const field of TASK_SYNC_FIELDS) clock[field] = at;
  return clock;
}

/** 值为 undefined 与 null 视为同一态（老数据的 `order` / `endDate` 常缺省） */
function sameValue(a: unknown, b: unknown): boolean {
  return (a ?? null) === (b ?? null);
}

/**
 * 比较前后两条任务，返回"这次改了哪些字段"（时间戳取 `next.updatedAt`）。
 *
 * 返回 `null` = 没有任何可同步字段变化（可能是纯派生变化、或对象被无意义地重建）。
 * 此时**绝不写时钟** —— 否则每个 action 都会把所有字段的时间往前推，
 * 字段级合并退化成"谁最后点了什么谁全赢"，等于没做。
 *
 * `done` 变化时 `doneAt` 会跟着变，但它不在字段清单里：
 * 合并时由 `done` 的赢家一并带过来（见 merge.ts 的 `mergeTaskPair`）。
 */
export function stampChangedFields(prev: Task, next: Task): TaskFieldAt | null {
  if (!prev || !next) return null;
  const stamps: TaskFieldAt = {};
  let changed = false;
  for (const field of TASK_SYNC_FIELDS) {
    if (sameValue(prev[field], next[field])) continue;
    stamps[field] = next.updatedAt;
    changed = true;
  }
  return changed ? stamps : null;
}

/**
 * 收敛时钟表：只认"字段名在清单里 + 值是合法 ISO"的项，其余丢弃。
 *
 * 为什么必须收敛而不是原样透传：这张表来自云端 / 手改的备份文件，
 * 脏值（`{ title: 123 }`、`{ 恶意键: '...' }`）会进比较逻辑。
 * 补齐的意义在于**逐字段重建**——`sanitizeTasks` 是逐字段重建对象的，
 * 漏写这一行 = 每次冷启动 / 每次云同步都把字段时钟清空，字段级合并静默失效。
 */
export function sanitizeFieldAt(raw: unknown): TaskFieldAt | undefined {
  const rec = asRecord(raw);
  if (!rec) return undefined;
  const clock: TaskFieldAt = {};
  let any = false;
  for (const field of TASK_SYNC_FIELDS) {
    const value = rec[field];
    if (typeof value !== 'string' || toMillis(value) <= 0) continue;
    clock[field] = value;
    any = true;
  }
  return any ? clock : undefined;
}
