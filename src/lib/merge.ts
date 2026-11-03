import { SCHEMA_VERSION } from '../constants';
import { TASK_SYNC_FIELDS, fieldClockOf, fullFieldClock, toMillis } from './fieldClock';
import { mergeHabitChecks, mergeHabitTaskLog, mergeHabits } from './habits';
import { mergeSleepLog } from './sleep';
import { migrate } from './storage';
import { mergeWeeklyReportLog } from './weekly';
import type {
  DiaryEntry,
  ExamGoal,
  FocusSession,
  Note,
  PersistedPayload,
  Settings,
  Task,
  TaskFieldAt,
  TaskTombstone,
} from '../types';

/* ============================================================================
   合并策略（纯函数，可单测）
   ----------------------------------------------------------------------------
   从 cloudSync.ts 抽出来：这里全是"两份数据怎么合成一份"的纯逻辑，
   不碰网络、不碰 localStorage、不认识"登录态"。
   和传输层分开之后，改合并规则不用在一个 1400 行的文件里翻。

   三条贯穿全文件的纪律：
   ① 入参可能是脏数据（云端 / 手改 JSON）——**绝不抛异常**，抛了会让
      自动推送变成未处理的 rejection（同步静默停摆）；
   ② 只按内容判断，不按时间戳拍脑袋（"空"是危险状态，不是中性）；
   ③ 删除必须靠墓碑/水位线传播，**光从数组里删掉等于没删**。
   ========================================================================= */

/**
 * 合并同一条任务的两份副本 —— **字段级 LWW**（v0.27.0 起的核心变更）。
 *
 * 背景（这是云同步最后一块已知缺陷）：
 * 合并在相当长时间里是"整条任务比 `updatedAt`，新者整条胜"。两台设备同时改
 * **不同字段**（电脑改标题、手机改备注）时只有一个赢家，另一方的改动无声消失。
 * 用户看到的是"我在手机上写的备注，回到家打开电脑就没了"。
 *
 * 现规则：
 * - **两侧都有 `fieldAt`** → 逐字段比时钟，谁的字段更新取谁的值（平局取本机，
 *   与旧行为一致，保证确定性）；某侧"没有这个字段的记录"按 `createdAt` 算
 *   （= 至少从建任务起没动过，见 `fieldClockOf`）。`updatedAt` 取两侧较晚者，
 *   保证"结果不比任一侧旧"（墓碑复活判定 `task.updatedAt > deletedAt` 依赖这一点）。
 * - **任一侧没有 `fieldAt`**（老数据 / 老客户端推上来的 / 从回收站恢复的新对象）
 *   → 退回整条 LWW，并顺手把胜者补齐时钟，让**下一次**合并自动进入字段级。
 *   这是刻意的保守：没有逐字段信息时，无法区分"对端没改这个字段"和
 *   "对端改成了同样的值"，猜错就是又一次静默丢改动。代价是这一次合并有损，
 *   且只发生在"还有设备没升级"的过渡期。
 *
 * `doneAt` 永远跟随 `done` 的赢家，不单独比时钟 —— 否则会出现
 * "已完成、但没有完成时间"或"未完成、却带着完成时间"的组合。
 */
export function mergeTaskPair(local: Task, remote: Task): Task {
  const localAt = toMillis(local.updatedAt);
  const remoteAt = toMillis(remote.updatedAt);

  if (!local.fieldAt || !remote.fieldAt) {
    const winner = localAt >= remoteAt ? local : remote;
    // 胜者已经有完整时钟就别再复制一份对象（合并里每次少一次分配）
    if (winner.fieldAt) return winner;
    return { ...winner, fieldAt: fullFieldClock(winner.updatedAt) };
  }

  /** 打底取较新的一条：`createdAt`、以及将来新增的、暂未纳入字段清单的键都跟着它 */
  const base = localAt >= remoteAt ? local : remote;
  const out: Record<string, unknown> = { ...(base as unknown as Record<string, unknown>) };
  const clock: TaskFieldAt = {};

  for (const field of TASK_SYNC_FIELDS) {
    const localClock = fieldClockOf(local, field);
    const remoteClock = fieldClockOf(remote, field);
    const useLocal = toMillis(localClock) >= toMillis(remoteClock);
    const source = useLocal ? local : remote;
    out[field] = (source as unknown as Record<string, unknown>)[field];
    clock[field] = useLocal ? localClock : remoteClock;
  }

  /** `doneAt` 跟 `done` 同源（写在循环之后，避免被循环里的遍历顺序影响） */
  const doneFromLocal = toMillis(fieldClockOf(local, 'done')) >= toMillis(fieldClockOf(remote, 'done'));
  const doneSource = doneFromLocal ? local : remote;
  out.done = doneSource.done;
  out.doneAt = doneSource.done ? doneSource.doneAt : null;

  /**
   * 创建时间取**更早**的那个：两端各自记的 createdAt 理论相同，
   * 但"从回收站恢复"会重写它。取更早 = 尽量保留最初创建的时刻，
   * 而且结果与传入顺序无关（可交换，合并才稳定）。
   */
  const created = [local.createdAt, remote.createdAt].filter((at) => toMillis(at) > 0);
  out.createdAt = created.length > 0 ? created.reduce((a, b) => (toMillis(a) <= toMillis(b) ? a : b)) : base.createdAt;

  out.fieldAt = clock;
  out.updatedAt = localAt >= remoteAt ? local.updatedAt : remote.updatedAt;
  return out as unknown as Task;
}

/**
 * 任务级合并：按 id 取并集，同 id 走 `mergeTaskPair`（字段级 LWW）。
 * 返回数组顺序：云端任务在前，本机独有任务追加在后。
 * 入参做数组兜底：云端 payload 可能是脏数据，合并**绝不抛异常**——
 * 抛了会让自动推送变成未处理的 rejection（同步静默停摆）。
 */
export function mergeTasks(local: Task[], remote: Task[]): Task[] {
  const localList = Array.isArray(local) ? local : [];
  const remoteList = Array.isArray(remote) ? remote : [];
  const byId = new Map<string, Task>();
  for (const task of remoteList) {
    if (task && typeof task.id === 'string' && task.id) byId.set(task.id, task);
  }
  for (const task of localList) {
    if (!task || typeof task.id !== 'string' || !task.id) continue;
    const prev = byId.get(task.id);
    byId.set(task.id, prev ? mergeTaskPair(task, prev) : task);
  }
  return [...byId.values()];
}

/**
 * 日记合并：按 date 取并集，updatedAt 新者胜（相等取本机，保证确定性）。
 *
 * 与任务同款语义：任一侧写过的日记都必须活下来，绝不按时间整包互盖 ——
 * 否则"手机上写的日记，电脑一同步就被整包盖掉"，就是刚修过的那类事故换个字段重演。
 *
 * 入参做数组兜底：另一侧可能根本没有 diary（老版本载荷），合并**绝不抛异常**。
 */
export function mergeDiary(local: DiaryEntry[], remote: DiaryEntry[]): DiaryEntry[] {
  const localList = Array.isArray(local) ? local : [];
  const remoteList = Array.isArray(remote) ? remote : [];
  const byDate = new Map<string, DiaryEntry>();
  for (const entry of remoteList) {
    if (entry && typeof entry.date === 'string' && entry.date) byDate.set(entry.date, entry);
  }
  for (const entry of localList) {
    if (!entry || typeof entry.date !== 'string' || !entry.date) continue;
    const prev = byDate.get(entry.date);
    if (!prev || toMillis(entry.updatedAt) >= toMillis(prev.updatedAt)) byDate.set(entry.date, entry);
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** 墓碑合并：按 id 取并集，deletedAt 新者胜（与任务、日记同款语义） */
export function mergeTombstones(
  local: TaskTombstone[],
  remote: TaskTombstone[],
): TaskTombstone[] {
  const localList = Array.isArray(local) ? local : [];
  const remoteList = Array.isArray(remote) ? remote : [];
  const byId = new Map<string, TaskTombstone>();
  for (const stone of remoteList) {
    if (stone && typeof stone.id === 'string' && stone.id) byId.set(stone.id, stone);
  }
  for (const stone of localList) {
    if (!stone || typeof stone.id !== 'string' || !stone.id) continue;
    const prev = byId.get(stone.id);
    if (!prev || toMillis(stone.deletedAt) >= toMillis(prev.deletedAt)) byId.set(stone.id, stone);
  }
  return [...byId.values()];
}

/**
 * 应用墓碑：把已删的任务从任务集里剔除。
 *
 * 复活判定：如果对端在删除之后**又编辑过**这条（task.updatedAt 晚于 deletedAt），
 * 说明用户把它要回来了 —— 保留任务。删除时不动 updatedAt，所以这个比较是可靠的。
 */
export function applyTombstones(tasks: Task[], tombstones: TaskTombstone[]): Task[] {
  const list = Array.isArray(tasks) ? tasks : [];
  const stones = Array.isArray(tombstones) ? tombstones : [];
  const dead = new Map<string, number>();
  for (const stone of stones) {
    if (stone && typeof stone.id === 'string' && stone.id) dead.set(stone.id, toMillis(stone.deletedAt));
  }
  return list.filter((task) => {
    if (!task || typeof task.id !== 'string' || !task.id) return true;
    const at = dead.get(task.id);
    return at === undefined || toMillis(task.updatedAt) > at;
  });
}

/**
 * 专注记录合并：按 id 取并集，新的在前。
 *
 * 只增不改的流水，不需要 updatedAt 比较 —— 同一段专注在任何设备上
 * 记下来的 id 与时长都一样，去重即可。
 */
/** 两个 dateKey 取较晚的一个（任一为空则取另一个） */
function laterDate(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

/** 丢掉早于水位线的专注记录（水位线为空则原样返回） */
function filterByWatermark(sessions: FocusSession[], watermark: string | null): FocusSession[] {
  if (!watermark) return sessions;
  return sessions.filter((session) => session && session.date >= watermark);
}

export function mergeFocusSessions(
  local: FocusSession[],
  remote: FocusSession[],
): FocusSession[] {
  const localList = Array.isArray(local) ? local : [];
  const remoteList = Array.isArray(remote) ? remote : [];
  const byId = new Map<string, FocusSession>();
  for (const session of remoteList) {
    if (session && typeof session.id === 'string' && session.id) {
      byId.set(session.id, session);
    }
  }
  for (const session of localList) {
    if (session && typeof session.id === 'string' && session.id) {
      byId.set(session.id, session);
    }
  }
  return [...byId.values()].sort((a, b) => toMillis(b.startedAt) - toMillis(a.startedAt));
}

/**
 * 记事合并：按 id 取并集，**updatedAt 新者胜**。
 *
 * 与专注记录（只增不改，按 id 去重即可）不同，记事是会被编辑的，
 * 所以必须比较 updatedAt —— 但要注意 reducer 统一打点，
 * 两端各自编辑时后保存的一端胜出，与任务的合并语义一致。
 */
export function mergeNotes(local: Note[], remote: Note[]): Note[] {
  const localList = Array.isArray(local) ? local : [];
  const remoteList = Array.isArray(remote) ? remote : [];
  const byId = new Map<string, Note>();
  const put = (note: Note) => {
    if (!note || typeof note.id !== 'string' || !note.id) return;
    const existing = byId.get(note.id);
    if (!existing) {
      byId.set(note.id, note);
      return;
    }
    byId.set(note.id, toMillis(note.updatedAt || '') >= toMillis(existing.updatedAt || '') ? note : existing);
  };
  for (const note of remoteList) put(note);
  for (const note of localList) put(note); // 本机后放：平局时本机胜
  return [...byId.values()].sort((a, b) => toMillis(b.updatedAt || '') - toMillis(a.updatedAt || ''));
}

/**
 * 目标倒计时合并：**按 id 取并集**，同 id 保留 `base`（较新一方）的那条。
 *
 * 为什么必须做并集，而不是"跟着较新一方的 settings 走"：
 * `settings` 整体是按 `savedAt` 取新的，而两台设备各自加目标时，
 * **较旧一方加的那条会直接被丢掉** —— 用户看到的是"我在手机上加了考试倒计时，
 * 电脑一同步就没了"。分类（categories）早就是这个待遇，goals 必须一致。
 *
 * 已知取舍（与 categories 完全相同）：**删除不会跨端传播** ——
 * 一端删掉的目标，会因为另一端还留着而在下次合并时回来。
 * 要根治得给目标也做墓碑，那是"另一个决策"（会动 payload 形状），本轮不做。
 *
 * 入参做数组兜底：老版本载荷里没有 goals，合并**绝不抛异常**。
 */
export function mergeGoals(base: ExamGoal[], other: ExamGoal[]): ExamGoal[] {
  const primary = Array.isArray(base) ? base : [];
  const extra = Array.isArray(other) ? other : [];
  const byId = new Map<string, ExamGoal>();
  for (const goal of primary) {
    if (goal && typeof goal.id === 'string' && goal.id) byId.set(goal.id, goal);
  }
  for (const goal of extra) {
    if (!goal || typeof goal.id !== 'string' || !goal.id) continue;
    // 同 id 保留 base 那方的版本（它是"较新一方的 settings"）
    if (byId.has(goal.id)) continue;
    byId.set(goal.id, goal);
  }
  // 按日期升序：列表与横幅都按"最近的在前"读，顺序必须确定
  return [...byId.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * 整包合并：任务按 id 取并集，再用墓碑剔除已删的；savedAt 取较新一侧
 * （让"刚合并过的稳态"能被 decideSyncAction 的等时间分支识别，避免每次手动
 * 同步都白写一次）；设置整体取 savedAt 较新的一侧，但 categories 与 goals
 * 按 id 取并集——任一侧新增的分类/目标都必须活下来，否则合并进来的任务会
 * 引用悬空分类、用户新加的倒计时会凭空消失。
 *
 * 对脏数据（tasks / settings / categories / goals 缺失或类型不对）全面兜底，
 * 任何情况下都不抛异常。
 */
export function mergeSnapshots(
  local: PersistedPayload,
  remote: PersistedPayload,
): PersistedPayload {
  const remoteTasks = Array.isArray(remote?.tasks) ? remote.tasks : [];
  const remoteSettings: Settings = remote?.settings ?? local.settings;
  const localNewer = toMillis(local.savedAt) >= toMillis(remote?.savedAt ?? '');

  const base: Settings = localNewer ? local.settings : remoteSettings;
  /**
   * 专注记录的清理水位线：两台设备取较晚的那个。
   * 它是"我已经清理到这一天"的承诺，只能往后推 —— 取较早的会让已清理的记录复活。
   */
  const focusPrunedBefore = laterDate(
    local.settings?.focusPrunedBefore ?? null,
    remote?.settings?.focusPrunedBefore ?? null,
  );
  const other: Settings = localNewer ? remoteSettings : local.settings;
  const categories = Array.isArray(base.categories) ? [...base.categories] : [];
  const otherCategories = Array.isArray(other.categories) ? other.categories : [];
  for (const category of otherCategories) {
    if (category && !categories.some((c) => c.id === category.id)) categories.push(category);
  }
  /**
   * 目标倒计时同理：**不做并集，较旧一方加的目标会在首次合并时凭空消失**
   * （多设备必踩）。见 mergeGoals 的说明。
   */
  const goals = mergeGoals(base.goals, other.goals);
  /**
   * 习惯打卡同理，而且更要紧：它是**攒出来的连续天数**。
   * 不做并集的话，较旧一方那天打的卡会被整包覆盖 —— 用户会发现
   * "我昨天在手机打过卡，今天在电脑上同步一下连续 12 天变 11 天"。
   * 习惯配置按 id 取并集、打卡按 habitId+date 取并集（只增不改的事实）。
   */
  const habits = mergeHabits(base.habits, other.habits);
  const habitChecks = mergeHabitChecks(base.habitChecks, other.habitChecks);
  /**
   * 「习惯 → 今日任务」的生成流水：**同样必须取并集**。
   *
   * 只跟着 base 走的话，较旧一方派过的记录会消失 → 那台设备下次启动
   * 会把同一个习惯的任务**再派一遍**（用户看到"背单词"一天出现两条）。
   */
  const habitTaskLog = mergeHabitTaskLog(base.habitTaskLog, other.habitTaskLog);
  /**
   * 周报生成记录同理：漏了它，两台设备会各自以为"这周还没生成"，
   * 于是同一周的周报在日记里被写两次（幂等替换只能挡住同一台设备上的重复）。
   */
  const weeklyReportLog = mergeWeeklyReportLog(base.weeklyReportLog, other.weeklyReportLog);
  /**
   * 作息打卡**同样**是只增不改的流水，和 habitChecks 一个待遇。
   * 漏了它的后果：手机记的起床时间，电脑同步一次就没了（电脑 savedAt 更新
   * → base 取电脑 → 手机那条消失，还会被推上云端）。见 sleep.ts 的说明。
   */
  const sleepLog = mergeSleepLog(base.sleepLog, other.sleepLog);

  /**
   * 墓碑先取并集，再拿它过滤合并出来的任务 —— 任一端删过，结果里就不该有它。
   * 顺序不能反：先并集后过滤，才能同时满足「A 删了 B 没删」和
   * 「B 删后 A 又改回来（复活）」两种情形。
   */
  const stones = mergeTombstones(local.tombstones, remote?.tombstones);
  const tasks = applyTombstones(mergeTasks(local.tasks, remoteTasks), stones);
  // 被救回来的任务要从墓碑里摘掉，否则下次合并又会被删一次
  const alive = new Set(tasks.map((task) => task.id));
  const tombstones = stones.filter((stone) => !alive.has(stone.id));

  const merged: PersistedPayload = {
    schemaVersion: SCHEMA_VERSION,
    savedAt: localNewer ? local.savedAt : (remote?.savedAt || local.savedAt),
    tasks,
    /**
     * **设备级设置保留本机**：`theme` / `lastView` / `remindEnabled`。
     *
     * 这三个绑的是"这台设备上这个人的习惯"，被另一台设备整包覆盖会变成
     * "我在电脑上用深色，手机改了点东西之后电脑变浅色"。
     * v0.11.0 起后台每 60 秒同步一次，这条路径被放大到几乎必然发生。
     *
     * 其余（分类、目标、日界、默认视图、周起始日）继续随云端 ——
     * 它们是"账号级"偏好，跨设备一致才合理。
     */
    settings: {
      ...base,
      categories,
      goals,
      habits,
      habitChecks,
      habitTaskLog,
      weeklyReportLog,
      sleepLog,
      theme: local.settings?.theme ?? base.theme,
      lastView: local.settings?.lastView ?? base.lastView,
      remindEnabled: local.settings?.remindEnabled ?? base.remindEnabled,
      /** 水位线只增不减：取两台设备里更晚的那个，绝不让旧设备把它改回去 */
      focusPrunedBefore,
    },
    diary: mergeDiary(local.diary, remote?.diary),
    tombstones,
    /**
     * 专注记录按 id 取并集（新者优先）。
     * 它是**只增不改**的流水：一段专注一旦记下就不会被编辑，
     * 所以不需要 updatedAt 比较，按 id 去重即可。
     */
    /**
     * 专注记录：按 id 取并集后，**再按清理水位线过滤**（2-6）。
     *
     * 只做并集的话，本机清理掉的旧记录会被云端原样并回来 ——
     * 用户会觉得"清理按钮没用"。水位线是"这个日期之前的我都不要了"，
     * 两台设备取较晚的那个（只增不减），所以谁的清理进度靠前就以谁为准。
     */
    focusSessions: filterByWatermark(
      mergeFocusSessions(local.focusSessions, remote?.focusSessions),
      focusPrunedBefore,
    ),
    /**
     * 记事本：updatedAt 新者胜。**漏了它 = 云端和本机的记事永远合不到一起**，
     * 而且一端新建的记事会在另一端消失 —— 和任务/日记一个待遇，一个都不能少。
     */
    notes: mergeNotes(local.notes, remote?.notes),
  };
  // 合并结果过一次字段级兜底：保证「推上云端的」与「hydrate 回本机的」是同一份内容。
  // 否则云端里的坏任务（如空标题）会被 mergeTasks 按 id 保留、却被 sanitizeTasks
  // 丢弃，sameTaskSet 永远判不等 → 自动推送反复 hydrate→保存→推送，churn 不自终止。
  return migrate(merged) ?? merged;
}
