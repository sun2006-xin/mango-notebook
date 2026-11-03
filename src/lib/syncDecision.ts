import type { PersistedPayload, Settings } from '../types';
import { sameByIdentity } from './equal';
import { hasAnyPersistedData } from './storage';

/* ============================================================================
   云同步的**决策层** —— 纯函数：不碰网络、不碰存储、不碰浏览器

   从 cloudSync.ts 里拆出来的理由：
   cloudSync 同时管着「拿什么覆盖什么」「HTTP 怎么发」「状态怎么广播」三件事，
   混在一个 1200 行的文件里，改决策逻辑时得在登入/表读写/状态事件之间翻找。
   这里是同步里**最容易错、也最值得单测**的一部分，单独成文件后：

   - 决策可以被穷举验证（本地空 / 远端空 / 都空 / 一样 / 不一样）
   - 不会因为某个 import 把浏览器 API 拖进来而测不了

   ⚠️ `snapshotDiffers` 与 `decideSyncAction` 的口径必须**完全一致**：
   前者答"要不要干活"，后者答"干什么活"。两边对同一个集合的判断一旦分叉，
   就会出现"判定为稳态不推送，但合并时又认为有差异"的鬼打墙。
   所以两个函数都写在同一个文件里，共用 `IDENTITY_SPECS` 这一张表。
   ========================================================================= */

export type SyncAction = 'push-local' | 'pull-cloud' | 'merge' | 'none';

/** 云端一侧参与比较的最小信息 */
export interface CloudSnapshotMeta {
  payload: PersistedPayload;
  savedAt: string;
  /** 云端这份数据里有多少条任务 —— 判同步方向时**内容优先于时间**，见 decideSyncAction */
  taskCount: number;
}

/** 任意集合取数组形态（缺字段 / 脏数据一律退化为空数组，绝不抛） */
function listOf<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

/**
 * 载荷里"有没有真实数据"：tasks / diary / notes / focusSessions / tombstones
 * **任一非空**都算非空。
 *
 * 不能只数任务：
 * - 纯记事用户（0 任务）会被判成"本机是空的"，既不敢往云端推
 *   （怕空数据盖掉真实数据），也落不到"一边空一边有"的决策分支 —— 记事永远同步不了；
 * - 同理，只有日记 / 只有专注记录 / 只有墓碑的设备也一样被冤枉成空机。
 *
 * `settings` 不算：它恒有默认值，算它等于永远非空，方向决策就失效了。
 */
function hasAnyData(payload: PersistedPayload | null | undefined): boolean {
  /**
   * 实现**只有一份**：storage.ts 的 `hasAnyPersistedData`。
   *
   * 这里曾经自己又枚举了一遍 5 个集合 —— 加第 6、第 7 个集合时必然漏一处，
   * 而漏掉是**编译不报错**的：那类设备会被误判成"空机"，
   * 于是既不敢往云端推（怕空数据盖掉真数据），也落不进"一边空一边有"的分支
   * —— 那一整个集合永远同步不了。
   */
  return hasAnyPersistedData(payload);
}

/**
 * 两边数据是否同一份 —— 五个集合共用一套口径：**主键 + 版本戳**，不比内容。
 *
 * 为什么抽成一项配置而不是五个函数：
 *
 * 这五处原本是五份手抄实现，差别只在"主键是 id 还是 date、戳是 updatedAt 还是
 * endedAt"。漂移一次就是静默失败 —— 曾经记事那一处漏比 `updatedAt`：
 * 记事的任何改动都判不出差异，同步被当成"稳态"短路，
 * **既推不上去也拉不下来**，界面上完全看不出哪里坏了。
 *
 * 五个集合的版本戳各选各的，是因为它们的数据形态本来就不同：
 * - 任务 / 记事 / 日记：可编辑 → `updatedAt`（改内容必刷新）
 * - 墓碑：只有 `deletedAt`（删了就不再改）
 * - 专注记录：只增不改的流水，没有 `updatedAt`，用 `endedAt`
 *
 * 少比任何一组，对端那次改动就永远同步不到本机 —— 这是这张表存在的唯一理由。
 */
const IDENTITY_SPECS = {
  tasks: { key: 'id', stamp: 'updatedAt' },
  diary: { key: 'date', stamp: 'updatedAt' },
  tombstones: { key: 'id', stamp: 'deletedAt' },
  notes: { key: 'id', stamp: 'updatedAt' },
  focusSessions: { key: 'id', stamp: 'endedAt' },
} as const satisfies Record<string, { key: string; stamp: string }>;

/** 按上面那张表比一个集合（键 / 戳的取值都做类型与空值兜底） */
function sameSet(spec: { key: string; stamp: string }, a: unknown, b: unknown): boolean {
  const read = (item: unknown, field: string): string | undefined => {
    if (!item || typeof item !== 'object') return undefined;
    const value = (item as Record<string, unknown>)[field];
    return typeof value === 'string' ? value : undefined;
  };
  return sameByIdentity(
    listOf(a as unknown[]).filter(Boolean),
    listOf(b as unknown[]).filter(Boolean),
    (item) => read(item, spec.key),
    (item) => read(item, spec.stamp),
  );
}

/** 两份设置是否一致（整体序列化比较；序列化失败按"不一致"处理，宁可多同步一次） */
function sameSettings(a: Settings, b: Settings): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * 两份载荷在**任何一个集合**上有差异。
 *
 * 三处闸门的统一口径：记事后背不了书 —— 只要 notes / focusSessions 有一处不同，
 * 就必须推送、必须把合并结果 hydrate 回本机，否则记事与专注记录是"看得见但同步不了"。
 */
export function snapshotDiffers(a: PersistedPayload, b: PersistedPayload): boolean {
  return (
    !sameSet(IDENTITY_SPECS.tasks, a.tasks, b.tasks) ||
    !sameSet(IDENTITY_SPECS.diary, a.diary, b.diary) ||
    !sameSet(IDENTITY_SPECS.notes, a.notes, b.notes) ||
    !sameSet(IDENTITY_SPECS.focusSessions, a.focusSessions, b.focusSessions) ||
    !sameSet(IDENTITY_SPECS.tombstones, a.tombstones, b.tombstones) ||
    !sameSettings(a.settings, b.settings)
  );
}

/**
 * 两份载荷内容是否一致：任务按 id + updatedAt，日记按 date + updatedAt，
 * 墓碑按 id + deletedAt，**记事按 id + updatedAt，专注记录按 id + endedAt**，
 * 设置按 JSON 序列化。
 * 用于识别"刚拉取过的稳态"—— 不能只比 savedAt：本机每次保存都会刷新
 * savedAt，与云端永不相等，时间相等的分支在真实流程里不可达。
 *
 * ⚠️ 五个集合**一个都不能漏**：少比一组等于给那一组上了"永不同步"的锁
 * ——只要其它四个集合没变，这一组的任何改动都会被判成稳态而跳过同步。
 *
 * diary / notes / focusSessions 缺字段要按空数组算：老版本载荷没有这些字段，
 * 与"空集合"应判为相同，否则每次同步都误判成有差异，白写一次还触发 hydrate 级联。
 */
export function isSameSnapshot(a: PersistedPayload, b: PersistedPayload): boolean {
  if (!Array.isArray(a?.tasks) || !Array.isArray(b?.tasks)) return false;
  return !snapshotDiffers(a, b);
}

/**
 * 决定本地与云端谁覆盖谁（纯函数，不碰网络、不碰存储）。
 *
 * - 云端无数据 → `push-local`（首次把本机数据放上去）
 * - 本地无数据 → `pull-cloud`（空机恢复）
 * - 一边空、一边有数据 → 有数据的一边赢（内容优先于时间，空数据绝不能盖掉真实数据）
 * - 两边都空 → `none`
 * - 两边内容完全一致（稳态）→ `none`（省掉无谓的一次写，也不触发合并→hydrate 级联）
 * - 两边都有数据且内容有差异 → `merge`（任务级合并，**绝不按时间整包互盖**）
 */
export function decideSyncAction(
  local: PersistedPayload | null,
  remote: CloudSnapshotMeta | null,
): SyncAction {
  if (!remote) return 'push-local';
  if (!local) return 'pull-cloud';

  const localEmpty = !hasAnyData(local);
  const remoteEmpty = !hasAnyData(remote.payload);

  /* 内容优先于时间：只要有一边空的、另一边有数据，就让有数据的那边赢，
     绝不允许空数据因为时间更新而盖掉真实数据。
     ⚠️ "空"必须是**全集合都空**：只看任务数的话，0 任务但有记事/日记的设备
     会被当成空机，那台设备的记事与日记永远上不了云端。 */
  if (localEmpty && !remoteEmpty) return 'pull-cloud';
  if (remoteEmpty && !localEmpty) return 'push-local';
  if (localEmpty && remoteEmpty) return 'none';

  /* 稳态：两边内容完全一致 → 什么都不做。
     不能只比 savedAt：本机每次保存都会刷新 savedAt，与云端永不相等，
     时间相等的分支在真实流程里不可达（QA 实测指出），稳态只能按内容判。 */
  if (isSameSnapshot(local, remote.payload)) return 'none';

  /* 两边都有数据且内容有差异 → 合并。绝不按时间整包互盖：那是"一边新增的任务
     被另一边无声吞掉"的根源（两台设备各建了任务，晚保存的那台一同步就抹掉另一台的新增）。 */
  return 'merge';
}
