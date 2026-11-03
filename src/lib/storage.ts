import {
  BACKUP_KEY,
  FOCUS_PREFS_KEY,
  FOCUS_RUNNING_KEY,
  SCHEMA_VERSION,
  SNAPSHOT_KEY,
  SNAPSHOT_PREV_KEY,
  SNAPSHOT_PREV_MAX_BYTES,
  STORAGE_KEY,
  DATE_KEY_PATTERN,
} from '../constants';
import type { AppState, PersistedPayload, SaveResult } from '../types';
import { getLocalStorage, isNativeStorage, resolveBackend, type KeyValueBackend } from './storageBackend';

/**
 * 后端的公开面仍从 `storage` 出去（调用方一直是这么拿的）。
 * `export ... from` 不建立本地绑定，所以上面还要单独 import 一次 —— 见下方说明。
 */
export { NATIVE_DUAL_WRITE_PHASE, getLocalStorage, isNativeStorage } from './storageBackend';
import { nowIso } from './date';
import {
  hasAnyPersistedData,
  sanitizeDiary,
  sanitizeFocusSessions,
  sanitizeNotes,
  sanitizeSettings,
  sanitizeTasks,
  sanitizeTombstones,
} from './sanitize';
import { DEFAULT_REMINDER_PRESETS } from './timer';
import type { RunningTimer, RunningTimerPrefs } from './timer';

/**
 * `isNoteDeleted` 的实现已下沉到零依赖叶子 `lib/note.ts`（形成
 * `note.ts ← srs.ts ← storage.ts` 的单向依赖，避免 storage ↔ srs 的环）。
 * 这里 re-export，**既有调用点一个都不用改**：
 * NotesView / lib/search.ts / notes.test.ts 仍然 `from '../lib/storage'` 取它。
 */
export { isNoteDeleted } from './note';

/* ============================================================================
   存储层（ARCHITECTURE §3.3 / §4.3）
   本文件是全工程**唯一**允许碰 localStorage 的 lib 模块（§11 纪律）。
   所有函数都不抛异常：读失败降级、写失败返回判别联合。

   双平台后端（增量设计 §1.1.2）：
   - 网页 / 桌面：localStorage（同步 API 包一层 Promise）；
   - 原生（APK）：Capacitor Preferences（SharedPreferences，不受 WebView
     origin 影响）—— 仅在 isNativeStorage() 判定为真后**动态 import**，
     web 端代码被切块但永不加载，行为零变化、包体零增加。
   ========================================================================= */

type Migration = (raw: unknown) => unknown;

export interface LoadResult {
  payload: PersistedPayload | null;
  error: 'unavailable' | 'corrupt' | 'future-version' | null;
  backupCreated: boolean;
  /** 主 key 为空、从快照恢复而来（用于提示用户"已自动恢复"） */
  restoredFromSnapshot?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * sanitize* 家族已搬到 `lib/sanitize.ts`（纯函数、零存储依赖）。
 * 这里保留**再导出**：几十处调用点（含测试）仍然从 storage 拿这几个函数，
 * 一次性全改只会制造无谓的 diff 风险。storage 依旧是"对外的那张脸"。
 */
export { hasAnyPersistedData } from './sanitize';
export {
  sanitizeDiary,
  sanitizeFocusSessions,
  sanitizeNotes,
  sanitizeRemind,
  sanitizeSettings,
  sanitizeTasks,
  sanitizeTombstones,
} from './sanitize';

/**
 * 版本链迁移。
 * `schemaVersion > SCHEMA_VERSION` → 返回 null（调用方走只读备份，绝不覆盖原 key）。
 * 无法识别的形态同样返回 null。
 */
const MIGRATIONS: Record<number, Migration> = {
  // 0 → 1：早期可能存在的"裸数组"或三 key 分离形态归一化
  0: (raw) => {
    const source = (raw ?? {}) as Record<string, unknown>;
    return {
      /**
       * ⚠️ 必须先用 `...source` 打底。
       *
       * 这一级是"没有 schemaVersion 的老数据"归一化。原实现是**重建**对象，
       * 于是 `{"notes":[...]}` 这类"无 schemaVersion 但带集合"的载荷，
       * 会被 `parseBackupJson` 的形状校验放行（它认"任意集合是数组"），
       * 然后在迁移时把 notes / diary / focusSessions / tombstones **全部丢掉**，
       * 得到一个"合法但全空"的载荷 —— 恢复时等于静默清空（QA 审计 P3-2）。
       *
       * 真实备份恒带 `schemaVersion: 1`（buildBackupPayload 保证），不走这一级。
       */
      ...source,
      schemaVersion: 1,
      savedAt: typeof source.savedAt === 'string' ? source.savedAt : nowIso(),
      tasks: Array.isArray(raw) ? raw : (source.tasks ?? []),
      settings: source.settings ?? null,
    };
  },
  // 1 → 2：新增 diary（日记）。tasks / settings 原样透传，一个字节都不动。
  1: (raw) => {
    const source = (raw ?? {}) as Record<string, unknown>;
    return {
      ...source,
      schemaVersion: 2,
      diary: Array.isArray(source.diary) ? source.diary : [],
    };
  },
  /**
   * 2 → 3：新增 tombstones（已删除任务的墓碑）。其余字段原样透传。
   *
   * 老数据里没有删除记录，只能补空数组 —— 这意味着**老数据同步过来时，
   * 之前删掉的任务可能被对端的旧副本复活一次**（一端有墓碑、一端没有的情况）。
   * 这是从"无墓碑"迁移到"有墓碑"不可避免的一次性代价，之后就自洽了。
   */
  2: (raw) => {
    const source = (raw ?? {}) as Record<string, unknown>;
    return {
      ...source,
      schemaVersion: 3,
      tombstones: Array.isArray(source.tombstones) ? source.tombstones : [],
    };
  },
  /**
   * 3 → 4：新增 focusSessions（专注时长记录）。其余字段原样透传。
   * 老数据没有专注记录，补空数组即可，不丢任何东西。
   */
  3: (raw) => {
    const source = (raw ?? {}) as Record<string, unknown>;
    return {
      ...source,
      schemaVersion: 4,
      focusSessions: Array.isArray(source.focusSessions) ? source.focusSessions : [],
    };
  },
  /**
   * 4 → 5：新增 notes（记事本）。其余字段原样透传。
   * 老数据没有记事，补空数组即可。
   */
  4: (raw) => {
    const source = (raw ?? {}) as Record<string, unknown>;
    return {
      ...source,
      schemaVersion: 5,
      notes: Array.isArray(source.notes) ? source.notes : [],
    };
  },
};

/** localStorage 可能因隐私模式/SSR 完全不可用 */
export function migrate(raw: unknown): PersistedPayload | null {
  if (raw === null || raw === undefined) return null;
  const isArray = Array.isArray(raw);
  const rec = asRecord(raw);
  if (!isArray && !rec) return null;

  const declared = isArray ? 0 : Number((rec as Record<string, unknown>).schemaVersion ?? 0);
  if (!Number.isFinite(declared) || declared > SCHEMA_VERSION) return null;

  let version = declared;
  let data: unknown = raw;
  let guard = 0;
  while (version < SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (!step || guard > 16) return null;
    data = step(data);
    guard += 1;
    const nextRec = asRecord(data);
    const nextVersion = nextRec ? Number(nextRec.schemaVersion ?? version + 1) : version + 1;
    version = Number.isFinite(nextVersion) ? nextVersion : version + 1;
  }

  const payload = asRecord(data);
  if (!payload) return null;

  return {
    schemaVersion: SCHEMA_VERSION,
    savedAt: typeof payload.savedAt === 'string' && payload.savedAt ? payload.savedAt : nowIso(),
    tasks: sanitizeTasks(payload.tasks),
    settings: sanitizeSettings(payload.settings),
    diary: sanitizeDiary(payload.diary),
    tombstones: sanitizeTombstones(payload.tombstones),
    focusSessions: sanitizeFocusSessions(payload.focusSessions),
    notes: sanitizeNotes(payload.notes),
  };
}

/**
 * 备份载荷的**唯一**来源：谁产出的数据都能喂进来（整个 `AppState` 就满足）。
 *
 * 为什么从六个位置参数改成对象：`buildBackupPayload(tasks, settings, diary,
 * tombstones, focusSessions, notes)` 这种签名靠**顺序**传参，
 * 加字段时要么忘记加参数、要么加错位置 —— 而两者都编译不过则罢，
 * 最坏的情况是老老实实加了参数却把 `notes` 和 `focusSessions` 写反，
 * 类型恰好都是数组，**编译通过、导出文件里两样东西互换**。
 * 改成按名字取之后，"漏一个字段"由字段集一致性测试逮（`backup.test.ts`），
 * 不再依赖人眼核对顺序。
 */
export type BackupSource = Pick<
  AppState,
  'tasks' | 'settings' | 'diary' | 'tombstones' | 'focusSessions' | 'notes'
>;

/**
 * 构造「导出备份文件」的载荷。
 *
 * 版本号**故意写死 1** 而不是 SCHEMA_VERSION：这样旧版 APK（只认 v1）也能读这份备份，
 * 换机 / 降级时备份不至于变成废文件。新版导入时 migrate 的 1→2 会先 `...source`
 * 展开再补 diary，所以这里带上 diary 就能一篇不差地回到新版。
 *
 * 曾经这里漏了 diary，导致「导出 → 导入」往返后日记全部消失 —— 这条字段由
 * lib/__tests__/backup.test.ts 的往返用例守着，删掉会变红。
 */
export function buildBackupPayload(source: BackupSource): PersistedPayload {
  // schemaVersion 写 1 是刻意的：备份走一遍完整迁移链（1→5）兜底字段，
  // 这样新版导出的备份在旧版导入时也不会变成废文件（只丢不认识的字段）。
  const { tasks, settings, diary, tombstones, focusSessions, notes } = source;
  return {
    schemaVersion: 1,
    savedAt: nowIso(),
    tasks,
    settings,
    diary,
    tombstones,
    focusSessions,
    notes,
  };
}

/** 损坏原文备份（localStorage 同步路径）：只在 backup 为空时写，避免覆盖上一次可用备份 */
function backupRawToStorage(ls: Storage, raw: string): boolean {
  try {
    if (ls.getItem(BACKUP_KEY)) return false;
    ls.setItem(BACKUP_KEY, raw);
    return true;
  } catch {
    return false;
  }
}

/** 损坏原文备份：只在 backup 为空时写，避免覆盖上一次可用备份 */
export async function backupRaw(raw: string): Promise<boolean> {
  const backend = await resolveBackend();
  if (!backend) return false;
  try {
    if (await backend.get(BACKUP_KEY)) return false;
    await backend.set(BACKUP_KEY, raw);
    return true;
  } catch {
    return false;
  }
}

/* ============================================================================
   进行中的计时（设备本地，不参与云同步）

   三套计时（番茄钟 / 秒表 / 提醒）共用同一份 RunningTimer。
   ⚠️ 老版本只落了 `{id, taskId, startedAt, phase}`（无 mode 等字段）。
   读回时一律回落 `mode: 'pomodoro'` 且 `running: true`，保证老数据刷新后
   仍能接回番茄钟（pomodoro 必保 refresh 可恢复）。
   ========================================================================= */

/** 读回进行中的计时；没有 / 脏数据 / 存储不可用 → null（永不抛） */
export function loadRunningTimer(): RunningTimer | null {
  const ls = getLocalStorage();
  if (!ls) return null;
  let raw: string | null = null;
  try {
    raw = ls.getItem(FOCUS_RUNNING_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const rec = parsed as Record<string, unknown>;
    if (typeof rec.id !== 'string' || !rec.id) return null;
    if (typeof rec.startedAt !== 'string' || !Number.isFinite(Date.parse(rec.startedAt))) {
      return null;
    }
    const mode: RunningTimer['mode'] =
      rec.mode === 'stopwatch' || rec.mode === 'reminder' ? rec.mode : 'pomodoro';
    const phase: RunningTimer['phase'] = rec.phase === 'break' ? 'break' : 'focus';
    const accumulatedMs =
      typeof rec.accumulatedMs === 'number' && Number.isFinite(rec.accumulatedMs)
        ? Math.max(0, rec.accumulatedMs)
        : 0;
    const running = rec.running !== false; // 老数据无此字段 → 视为在跑
    const durationMs =
      typeof rec.durationMs === 'number' && Number.isFinite(rec.durationMs)
        ? Math.max(0, rec.durationMs)
        : 0;
    return {
      mode,
      id: rec.id,
      taskId: typeof rec.taskId === 'string' && rec.taskId ? rec.taskId : null,
      startedAt: rec.startedAt,
      phase,
      accumulatedMs,
      running,
      durationMs,
    };
  } catch {
    return null;
  }
}

/** 写入 / 清除进行中的计时（传 null 即清）。失败静默 —— 计时器照跑，只是刷新后接不回来 */
/**
 * 只读原始字符串、**不解析** —— 给提醒轮询做"内容没变就跳过"的快速判据。
 *
 * `loadRunningTimer()` 每次都要 `JSON.parse`，而轮询是每秒一次、无论有没有
 * 计时器都在跑。一次 getItem 比一次 getItem + parse + 字段校验便宜得多，
 * 而绝大多数时候这个键根本不存在（返回 null，直接跳）。
 */
export function peekRunningTimerRaw(): string | null {
  const ls = getLocalStorage();
  if (!ls) return null;
  try {
    return ls.getItem(FOCUS_RUNNING_KEY);
  } catch {
    return null;
  }
}

export function saveRunningTimer(value: RunningTimer | null): void {
  const ls = getLocalStorage();
  if (!ls) return;
  try {
    if (value === null) ls.removeItem(FOCUS_RUNNING_KEY);
    else ls.setItem(FOCUS_RUNNING_KEY, JSON.stringify(value));
  } catch {
    /* 配额满 / 隐私模式：忽略 */
  }
}

/** 提醒预设封顶数量（分钟胶囊一列最多这么多） */
const MAX_REMINDER_PRESETS = 8;

/** 把读到的一坨脏数据收敛成合法的提醒预设列表（仅保留正整数，封顶 MAX_REMINDER_PRESETS） */
function sanitizePresets(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [...DEFAULT_REMINDER_PRESETS];
  const valid = raw
    .filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0)
    .map((n) => Math.trunc(n));
  return valid.length ? valid.slice(0, MAX_REMINDER_PRESETS) : [...DEFAULT_REMINDER_PRESETS];
}

/** 读回计时偏好；缺失 / 脏数据一律回落默认（mode 番茄钟 + 默认预设） */
export function loadFocusPrefs(): RunningTimerPrefs {
  const ls = getLocalStorage();
  const fallback: RunningTimerPrefs = {
    mode: 'pomodoro',
    reminderPresets: [...DEFAULT_REMINDER_PRESETS],
  };
  if (!ls) return fallback;
  let raw: string | null = null;
  try {
    raw = ls.getItem(FOCUS_PREFS_KEY);
  } catch {
    return fallback;
  }
  if (!raw) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return fallback;
    const rec = parsed as Record<string, unknown>;
    const mode: RunningTimerPrefs['mode'] =
      rec.mode === 'stopwatch' || rec.mode === 'reminder' ? rec.mode : 'pomodoro';
    return { mode, reminderPresets: sanitizePresets(rec.reminderPresets) };
  } catch {
    return fallback;
  }
}

/** 写入计时偏好（落独立 key FOCUS_PREFS_KEY，不进主 payload） */
export function saveFocusPrefs(prefs: RunningTimerPrefs): void {
  const ls = getLocalStorage();
  if (!ls) return;
  try {
    ls.setItem(
      FOCUS_PREFS_KEY,
      JSON.stringify({ mode: prefs.mode, reminderPresets: prefs.reminderPresets }),
    );
  } catch {
    /* 忽略 */
  }
}

/**
 * 字符串的 UTF-8 字节数（配额是按字节算的，`length` 是按字符算的）。
 *
 * 为什么较真：一条中文快照的 `length` 可能只有字节数的 1/3，
 * 用字符数比较会让"512 KB 的守卫"实际放行 1.5 MB —— 三份叠起来正好撞配额。
 * TextEncoder 在所有目标环境（浏览器 / WebView / Node 11+）都有；
 * 极端环境下缺失就退回字符数（宁可少一份历史，也不抛）。
 */
function utf8Bytes(text: string): number {
  try {
    const encoder = new TextEncoder();
    return encoder.encode(text).length;
  } catch {
    return text.length;
  }
}

/** 读取快照并校验；无效返回 null（快照只是兜底，绝不因为它而启动失败） */
function loadSnapshot(ls: Storage): PersistedPayload | null {
  /**
   * 两级快照：当前（SNAPSHOT_KEY）坏了就退到上一份（SNAPSHOT_PREV_KEY）。
   * 这正是 A/B 双快照的意义 —— 单快照时"最后两次写都写坏了"是必死局面。
   */
  for (const key of [SNAPSHOT_KEY, SNAPSHOT_PREV_KEY]) {
    let raw: string | null = null;
    try {
      raw = ls.getItem(key);
    } catch {
      raw = null;
    }
    if (!raw) continue;
    try {
      const payload = migrate(JSON.parse(raw));
      if (payload) return payload;
    } catch {
      /* 这一份坏了，看下一份 */
    }
  }
  return null;
}

/** 读取 + 校验 + 迁移（三级降级，永不抛） */
export function loadPersisted(): LoadResult {
  const ls = getLocalStorage();
  if (!ls) return { payload: null, error: 'unavailable', backupCreated: false };

  let raw: string | null = null;
  try {
    raw = ls.getItem(STORAGE_KEY);
  } catch {
    return { payload: null, error: 'unavailable', backupCreated: false };
  }
  if (!raw) {
    // 主 key 没了（极端情况下的写入中断 / 存储被部分清理）：先看快照能不能救回来
    const snapshot = loadSnapshot(ls);
    if (snapshot) return { payload: snapshot, error: null, backupCreated: false, restoredFromSnapshot: true };
    return { payload: null, error: null, backupCreated: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const backupCreated = backupRawToStorage(ls, raw);
    /**
     * ⚠️ 主 key **损坏**时也要试快照 —— 这里曾经和"主 key 缺失"不对称：
     * 缺失会回退快照，损坏却直接判死。而损坏恰恰更常见（写入被中断、
     * 容量写满截断，留下的都是半截 JSON）。
     * 原文已经另存到 BACKUP_KEY 了，所以回退快照不会销毁任何原始字节。
     */
    const snapshot = loadSnapshot(ls);
    if (snapshot) {
      return { payload: snapshot, error: null, backupCreated, restoredFromSnapshot: true };
    }
    return { payload: null, error: 'corrupt', backupCreated };
  }

  const payload = migrate(parsed);
  if (!payload) {
    // 更高版本：只读备份，原 key 保持不动
    const backupCreated = backupRawToStorage(ls, raw);
    return { payload: null, error: 'future-version', backupCreated };
  }

  return { payload, error: null, backupCreated: false };
}

/* ============================================================================
   异步装载（原生 Preferences 路径；网页 / 桌面走同步 loadPersisted）
   三级降级逻辑与 loadPersisted 完全同构，只是存储动作换成 backend。
   ========================================================================= */

/** 解析 + 迁移；任何异常都当成"这份快照救不回来"（绝不抛） */
function parseAndMigrate(raw: string): PersistedPayload | null {
  try {
    return migrate(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** 两级快照（SNAPSHOT → SNAPSHOT_PREV）里第一份能解析出来的；都没有返回 null */
async function loadSnapshotViaBackend(backend: KeyValueBackend): Promise<PersistedPayload | null> {
  for (const key of [SNAPSHOT_KEY, SNAPSHOT_PREV_KEY]) {
    let raw: string | null = null;
    try {
      raw = await backend.get(key);
    } catch {
      raw = null;
    }
    if (!raw) continue;
    const payload = parseAndMigrate(raw);
    if (payload) return payload;
  }
  return null;
}

/** 损坏原文备份（走已解析好的后端，避免重复 resolve） */
async function backupViaBackend(backend: KeyValueBackend, raw: string): Promise<boolean> {
  try {
    if (await backend.get(BACKUP_KEY)) return false;
    await backend.set(BACKUP_KEY, raw);
    return true;
  } catch {
    return false;
  }
}

/** 读取 + 校验 + 迁移（三级降级，永不抛、绝不 reject） */
async function loadViaBackend(backend: KeyValueBackend): Promise<LoadResult> {
  let raw: string | null = null;
  try {
    raw = await backend.get(STORAGE_KEY);
  } catch {
    return { payload: null, error: 'unavailable', backupCreated: false };
  }
  if (!raw) {
    // 主 key 没了：先看快照能不能救回来（SNAPSHOT → SNAPSHOT_PREV 两级）
    const snapshot = await loadSnapshotViaBackend(backend);
    if (snapshot) return { payload: snapshot, error: null, backupCreated: false, restoredFromSnapshot: true };
    return { payload: null, error: null, backupCreated: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const backupCreated = await backupViaBackend(backend, raw);
    // 同同步路径：损坏也试两级快照（原文已另存，回退不会销毁字节）
    const snapshot = await loadSnapshotViaBackend(backend);
    if (snapshot) {
      return { payload: snapshot, error: null, backupCreated, restoredFromSnapshot: true };
    }
    return { payload: null, error: 'corrupt', backupCreated };
  }

  const payload = migrate(parsed);
  if (!payload) {
    // 更高版本：只读备份，原 key 保持不动
    const backupCreated = await backupViaBackend(backend, raw);
    return { payload: null, error: 'future-version', backupCreated };
  }

  return { payload, error: null, backupCreated: false };
}

/**
 * 异步装载（APK 冷启动链路用）：平台分发 + 三级降级。
 * 非原生环境同样可用（走 localStorage），供测试与调用方统一语义；
 * `loadPersisted()` 保持同步不变，是网页 / 桌面端的唯一装载入口。
 */
export async function loadPersistedAsync(): Promise<LoadResult> {
  const backend = await resolveBackend();
  if (!backend) return { payload: null, error: 'unavailable', backupCreated: false };
  return loadViaBackend(backend);
}

/** 整包写入：不抛异常，返回判别联合 */
/**
 * 判断某个错误是不是"配额满了"。
 * 浏览器是 QuotaExceededError，Firefox 是 NS_ERROR_DOM_QUOTA_REACHED。
 */
function isQuotaError(error: unknown): boolean {
  const name = (error as { name?: string })?.name;
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED';
}

/**
 * 写主 key，配额不足时**按"先牺牲备份、保住正本"的顺序腾空间**。
 *
 * 为什么这个顺序：快照是备份，主 key 是正本。为了留住备份而把正本写失败，
 * 等于"用户这一次的修改全丢" —— 比丢掉一份备份糟糕得多。
 * 所以顺序是：直接写 → 失败就丢 SNAPSHOT_PREV → 再失败才丢 SNAPSHOT。
 *
 * 只负责主 key 本身的写入，快照的维护仍由调用方按原逻辑做（写失败也不影响主流程）。
 */
async function setPrimaryWithQuotaRecovery(
  backend: KeyValueBackend,
  json: string,
): Promise<void> {
  try {
    await backend.set(STORAGE_KEY, json);
    return;
  } catch (error) {
    if (!isQuotaError(error)) throw error;
  }

  // 依次牺牲两份备份，每牺牲一次就重试写正本
  for (const sacrificial of [SNAPSHOT_PREV_KEY, SNAPSHOT_KEY]) {
    try {
      await backend.remove(sacrificial);
    } catch {
      /* 删不掉也继续试写正本 */
    }
    try {
      await backend.set(STORAGE_KEY, json);
      return;
    } catch (error) {
      if (!isQuotaError(error)) throw error;
    }
  }
  // 腾完还写不进去：如实上报 quota（让上层提示用户清理数据）
  const error = new Error('quota');
  error.name = 'QuotaExceededError';
  throw error;
}

/**
 * **同步**落盘：只走 localStorage，绝不 await。
 *
 * 为什么需要它：`flush()` 有同步签名，但内部是 `await savePersisted(...)` ——
 * 一串微任务。页面 `pagehide` / 窗口关闭之后，浏览器**不保证**再把微任务跑完，
 * 于是"最后一次编辑"可能停在内存里，用户下次打开看到的是上一版。
 *
 * 这里用 localStorage 的同步写把这一刻的状态直接钉到盘上。
 * 桌面端（127.0.0.1）与网页端都走 localStorage，所以两端都受益；
 * 安卓 APK 的权威后端是 Preferences（原生、只有异步 API），返回 null 表示
 * "这个环境做不到同步写"，调用方回落到原来的异步路径。
 */
export function savePersistedSync(payload: PersistedPayload): SaveResult | null {
  /**
   * ⚠️ 原生端必须返回 null（= "这个环境做不到同步写"），让调用方回落异步写链。
   *
   * 为什么不能同步写：APK 上权威存储是 Capacitor Preferences，
   * `localStorage` 只是 `DualWriteBackend` 的**镜像**。这里若同步写镜像并
   * 返回 `{ ok: true }`，`usePersist.flushSync()` 就会认为"已经落盘"、
   * 把 pending 清空、不再走异步链 —— 于是切后台/返回键那一刻的最后一次编辑
   * 只留在镜像里，下次冷启动读 primary 时**静默消失**（≤300ms 的输入全丢）。
   *
   * 原来这里判的是 `getLocalStorage()`，但 WebView 里 localStorage 一直存在，
   * 这个判断在安卓上恒为真 —— 于是"同步写"一路冒充成功。
   */
  if (isNativeStorage()) return null;
  const ls = getLocalStorage();
  if (!ls) return null; // 无 localStorage（隐私模式等）→ 交给异步路径

  try {
    const json = JSON.stringify(payload);
    /**
     * 同步路径不做 quota 腾挪：这里的时间预算只有"页面还能执行几行代码"，
     * 反复删+写失败只会把最后的机会也耗掉。直接写，失败就如实上报。
     */
    ls.setItem(STORAGE_KEY, json);
    if (hasAnyPersistedData(payload)) {
      try {
        const previous = ls.getItem(SNAPSHOT_KEY);
        if (previous && utf8Bytes(previous) <= SNAPSHOT_PREV_MAX_BYTES) {
          ls.setItem(SNAPSHOT_PREV_KEY, previous);
        }
        ls.setItem(SNAPSHOT_KEY, json);
      } catch {
        /* 快照写失败不影响正本 */
      }
    }
    return { ok: true };
  } catch (error) {
    if (isQuotaError(error)) return { ok: false, reason: 'quota' };
    const name = (error as { name?: string })?.name;
    if (name === 'SecurityError') return { ok: false, reason: 'unavailable' };
    return { ok: false, reason: 'unknown' };
  }
}

export async function savePersisted(payload: PersistedPayload): Promise<SaveResult> {
  const backend = await resolveBackend();
  if (!backend) return { ok: false, reason: 'unavailable' };
  try {
    const json = JSON.stringify(payload);
    // 写正本：配额不足时按"先丢备份、保住正本"的顺序腾空间（见 setPrimaryWithQuotaRecovery）
    await setPrimaryWithQuotaRecovery(backend, json);
    // 镜像一份快照：主 key 出问题时还有一次自救机会。
    // 只在有数据（任一集合非空）时写，避免用空数据把上一份有效快照覆盖掉 ——
    // 判据不能只看 tasks：只有日记 / 记事的设备不该被当成"没有数据"，
    // 否则它的快照永远不会被更新。
    if (hasAnyPersistedData(payload)) {
      /**
       * A/B 双快照：先把"当前快照"挪成"上一份"，再写新快照。
       *
       * 为什么必须在 `hasAnyPersistedData` 分支**内部**：
       * 空数据既不覆盖快照，也就不该挪动 prev —— 否则一次"数据被清空"的保存
       * 会把仅有的两份历史一起推进成空，兜底能力归零。
       *
       * 体积保护：旧快照超过 SNAPSHOT_PREV_MAX_BYTES 就跳过。
       * localStorage 总量约 5 MB，三份大 JSON 撞配额时**第一个失败的是主 key**
       * —— 为了备份把正本弄丢，比没有备份更糟。
       */
      try {
        const previous = await backend.get(SNAPSHOT_KEY);
        if (previous && utf8Bytes(previous) <= SNAPSHOT_PREV_MAX_BYTES) {
          await backend.set(SNAPSHOT_PREV_KEY, previous);
        }
      } catch {
        /* prev 写失败不影响主流程（主 key 已经写成功了） */
      }
      try {
        await backend.set(SNAPSHOT_KEY, json);
      } catch {
        /* 快照写失败不影响主流程 */
      }
    }
    return { ok: true };
  } catch (error) {
    const name = (error as { name?: string })?.name;
    if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') {
      return { ok: false, reason: 'quota' };
    }
    if (name === 'SecurityError') return { ok: false, reason: 'unavailable' };
    return { ok: false, reason: 'unknown' };
  }
}

/** 清空（保留 BACKUP_KEY） */
export async function clearAll(): Promise<void> {
  const backend = await resolveBackend();
  if (!backend) return;
  try {
    await backend.remove(STORAGE_KEY);
  } catch {
    /* 忽略：清空失败不阻塞 UI */
  }
}

/** 原始字符串是否像一个"更高版本"的载荷（供只读保护判断） */
export function isFutureVersion(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const rec = asRecord(parsed);
    const version = Number(rec?.schemaVersion ?? 0);
    return Number.isFinite(version) && version > SCHEMA_VERSION;
  } catch {
    return false;
  }
}

/** 供测试与调试使用 */
export const __storageKeys = {
  STORAGE_KEY,
  BACKUP_KEY,
  SNAPSHOT_KEY,
  SNAPSHOT_PREV_KEY,
  DATE_KEY_PATTERN,
};
