/**
 * 全工程唯一的类型真相源（ARCHITECTURE §3.1）。
 * 只有类型，没有运行时代码 —— 因此本文件不 import 任何东西。
 */

/* ---------- 基础联合类型 ---------- */
/** 'YYYY-MM-DD'，本地时区安全（禁 toISOString().slice） */
export type DateKey = string;
/** 'HH:mm'，24 小时制 */
export type TimeKey = string;
export type Priority = 'high' | 'medium' | 'low';
/** 重复周期；'none' = 一次性任务（老数据缺省就是它） */
export type Repeat = 'none' | 'daily' | 'weekly' | 'monthly';
/**
 * 今日 / 周 / 日历 / 专注 / 日记 / 记事本 / 设置 —— 导航里的七档。
 *
 * `'trash'`（回收站）**故意不在导航里**：它是个"出了问题才去"的页面，
 * 常驻入口只会占位置。入口放在设置页的「数据」区块 + 删除后的 Toast。
 *
 * `'review'`（复习会话）**同理故意不在导航 / VIEWS 白名单里**（照抄 trash 的模式）：
 * 它是从「今日」横幅或记事本「加入复习」进入的**临时会话**，
 * 记住它会让用户下次冷启动直接落在复习页（而那天可能一张卡都不该复习）。
 * 因此：`VIEW_META.review` 有元数据（Record<ViewId, _> 要求穷举），
 * 但 `VIEW_ORDER` 与 `storage.ts` 的 `VIEWS` 白名单里都没有它。
 */
export type ViewId =
  | 'today'
  | 'week'
  | 'calendar'
  | 'focus'
  | 'diary'
  | 'notes'
  | 'settings'
  | 'trash'
  | 'review';
export type ThemeMode = 'light' | 'dark' | 'system';
export type FilterMode = 'all' | 'open' | 'done';
export type DayStatus = 'empty' | 'none-done' | 'partial' | 'all-done';
export type SaveState = 'idle' | 'saving' | 'saved' | 'error';
export type TaskDensity = 'default' | 'compact';

export interface MonthCursor {
  /** 2026 */
  year: number;
  /** 0-11（与 Date 一致，展示时 +1） */
  month: number;
}

/* ---------- 任务 ---------- */
export interface Task {
  /** crypto.randomUUID()；撤销删除复用同一 id */
  id: string;
  /** trim 后 1–120 字符 */
  title: string;
  /** '' 或 ≤500 字符，允许换行 */
  note: string;
  /** 归属日，逾期判定依据 */
  date: DateKey;
  /**
   * 结束日（**含**）；`null` / 缺省 = 只有 `date` 这一天（绝大多数任务）。
   *
   * 「多天任务」的口径（三条，全站统一，别再各自解释）：
   * - `date` = **开始日**，`endDate` = **最后一天**，闭区间。永远是 `endDate >= date`。
   * - **在区间内的每一天都出现在列表里**，并且**每一天都计入那天的进度分母**
   *   （"今天共 4 项"里有 1 项是持续中的任务 —— 那确实是今天要做的事）。
   *   代价是中间那几天的完成率会被拉低，这是**诚实的**：事确实还没做完。
   * - **逾期按最后一天算**：`endDate` 过了还没完成才算逾期。
   *   按开始日算的话，一个 30 天的任务从第 2 天起就挂在"逾期区"，等于逼人拆任务。
   *
   * 为什么用可选字段：老数据（含云端旧载荷、旧导出文件）没有它，
   * 可选能让它们原样通过类型检查，由 `sanitizeTasks` 统一补 `null`。
   * 读取一律走 `taskLastDate(t)` / `taskCoversDate(t, date)`，不要在业务代码里手写比较。
   */
  endDate?: DateKey | null;
  /** null = 「随时」 */
  time: TimeKey | null;
  /** 重复周期；完成任务时自动生成下一份（老任务缺省 'none'） */
  repeat: Repeat;
  priority: Priority;
  /** 存分类 name（首版），清单在 settings.categories */
  category: string;
  done: boolean;
  /** ISO，用于已完成组排序与统计 */
  doneAt: string | null;
  createdAt: string;
  /** 每次编辑刷新 */
  updatedAt: string;
  /**
   * 父任务 id；`null` = 顶层任务。
   *
   * 只支持一层嵌套（父子两级）：学习流里"一门技术 → 几个步骤"已经够用，
   * 再深会让列表缩进、勾选联动、拖拽排序的复杂度失控。
   * 父任务的 `done` 由子任务推导，不手动勾选（见 reducer）。
   */
  parentId: string | null;
  /**
   * 预计用时（分钟）。范围 0–9999，**`0` = 未估时**（不是"0 分钟的任务"）。
   *
   * 为什么不设成可选：可选会让"没填"和"填了 0"变成两种状态，
   * 而它们的业务含义完全一样（今日预算里都算"未估时"）。
   * 老数据缺这个字段时由 `sanitizeTasks` 归一成 0，所以这里必须是必填的 number。
   *
   * ⚠️ 墓碑（TaskTombstone）不保留这个字段：回收站里恢复出来的任务
   * `estimatedMinutes` 恒为 0 —— 与 priority / repeat / note 同样不保留
   * （墓碑只存 id / title / date / index，见 TaskTombstone 的注释）。
   */
  estimatedMinutes: number;
  /**
   * 手动排序位（拖拽排序用）。**0 或缺省 = 未手动排过**，走自动排序
   * （有时间者在前 → 时间升序 → 优先级 → 创建时间）。
   *
   * 语义（三条，都是为了让"自动"和"手动"不打架）：
   * - `0` = 自动。**绝不能给自动区里的任务发非 0 的号**，否则一个没被拖过的
   *   任务会突然压到被拖过的任务上面。
   * - 一旦某天被拖过，那一天的所有顶层任务会被**连续编号成 1..n**
   *   （`applyTaskMove` 负责），于是"这一天排过序"这件事从数据本身就能看出来，
   *   不需要额外的标记位。
   * - 之后往这天新加的任务拿 `max + 1` → 落在末尾（见 reducer 的 TASK_ADD）。
   *   这是**可预期的**：排过序就是"我自己说了算"，新来的排队尾。
   *
   * 为什么可选：老数据（含云端载荷、旧版导出文件）没有这个字段，
   * 可选能让它们原样通过类型检查，由 `sanitizeTasks` 统一补 0。
   * 读取一律走 `taskOrder(t)`（lib/drag.ts），不要在业务代码里散落 `?? 0`。
   */
  order?: number;
  /**
   * **字段级时钟**：每个可同步字段最后一次被改动的时间（ISO）。
   *
   * 为什么需要：云同步原来是"整条任务 updatedAt 新者胜"。两台设备同时改**同一条任务的
   * 不同字段**（电脑改标题、手机改备注），合并时整条只有一个赢家 → 另一方的改动
   * 无声消失。有了逐字段时间戳就能"按字段择优"，两边的改动都留下。
   *
   * 三条纪律：
   * - **没有它就退回旧行为**（整条 LWW）。老数据 / 老客户端推上来的任务没有这个字段，
   *   此时按 `updatedAt` 整条取舍并**补齐时钟**，下一次合并就自动进入字段级。
   *   所以**不需要**升 SCHEMA_VERSION：老端读到它只会忽略（sanitizeTasks 会丢弃），
   *   升版本反而会让老端把整份数据判成 future-version 拒绝同步。
   * - 由 `store/fieldClock.ts` 的 reducer 收尾统一打点，**不是**各 action 自己写
   *   （46 个 action 手写必然漏，漏了不报错，只在"另一台设备的改动被吃掉"时暴露）。
   * - `doneAt` 不单独记时钟：它永远跟着 `done` 走（见 merge 的字段分组）。
   */
  fieldAt?: TaskFieldAt;
}

/**
 * 可跨设备合并的任务字段。
 *
 * 只列**用户可编辑且有语义**的字段：`createdAt` 不参与（取更早的）、
 * `updatedAt` 不参与（由合并结果推出）、`doneAt` 不参与（跟随 `done`）、
 * `fieldAt` 自己当然也不参与。
 */
export type TaskSyncField =
  | 'title'
  | 'note'
  | 'date'
  | 'endDate'
  | 'time'
  | 'repeat'
  | 'priority'
  | 'category'
  | 'done'
  | 'parentId'
  | 'estimatedMinutes'
  | 'order';

/** 字段 → 最后修改时间。缺项 = 该字段从未被单独改动过，回落到任务的 updatedAt */
export type TaskFieldAt = Partial<Record<TaskSyncField, string>>;

/**
 * 已删除任务的墓碑。
 *
 * 为什么需要：多端合并是「按 id 取并集」（mergeTasks）。删除如果直接把任务从
 * 数组里抹掉，就**没有任何信息能告诉对端"这条是被删了"** —— 对端那份还在
 * 数组里，一取并集就原地复活。用户看到的正是这个现象：网页上删掉记录，
 * 点同步数据又回来了。
 *
 * 墓碑让"删除"变成一次**带时间戳的写入**，于是能参与 updatedAt 新者胜：
 * 本机删了 → 墓碑 updatedAt 更新 → 合并时本机赢 → 对端也删掉。
 *
 * 复活判定：若某端在墓碑之后**又编辑过**同一条（task.updatedAt > tombstone.deletedAt），
 * 视为用户把它要回来了，任务保留、墓碑清除。
 */
export interface TaskTombstone {
  id: string;
  deletedAt: string;
  /**
   * 删除时任务的标题。
   *
   * 回收站要给人看"删的是哪条"，而任务本体已经被移除了 ——
   * 不在这里留一份标题，回收站就只剩一串 uuid，等于没有。
   */
  title: string;
  /** 删除时它归属的日期；恢复时放回原处 */
  date: DateKey;
  /** 删除时在兄弟节点中的位置；恢复时按原位插回 */
  index: number;
}

/* ---------- 专注记录（持久化） ---------- */
export interface FocusSession {
  id: string;
  /** 关联的任务 id；`null` = 不挂任务的自由专注 */
  taskId: string | null;
  /**
   * 归属日（**已按日界换算**，不是 startedAt 的自然日）。
   *
   * 为什么存下来而不是用时再推：日界是可改的设置，
   * 改了之后不该让历史记录跟着跳到另一天去 ——
   * 一次凌晨 1 点的专注，就该永远记在它当时所属的那天。
   */
  date: DateKey;
  startedAt: string;
  endedAt: string;
  /** 实际专注毫秒数：只累加"真的在跑"的时间，暂停不计入 */
  durationMs: number;
  /**
   * 科目（= 关联任务的分类名）；自由专注 / 老记录没有这个字段。
   *
   * 为什么要冗余存一份：统计按科目聚合时若靠 `taskId` 反查，
   * **任务一删，那段专注就从"科目维度"里消失了** —— 而历史投入不该被删任务抹掉。
   */
  category?: string;
}

/** 新建任务的表单入参（缺省值由 createTask 补齐） */
export interface TaskInput {
  title: string;
  note?: string;
  date?: DateKey;
  /** 结束日（含）；不传 / 非法 / 早于 date → 单天任务 */
  endDate?: DateKey | null;
  time?: TimeKey | null;
  repeat?: Repeat;
  priority?: Priority;
  category?: string;
  /** 预计用时（分钟）。不传 / 留空 / 非法 → 0（未估时） */
  estimatedMinutes?: number;
}

/* ---------- 日记（持久化） ---------- */
/** 周计划模板里的一条（F3） */
export interface WeekPlanItem {
  title: string;
  category: string;
  time: TimeKey | null;
  estimatedMinutes: number;
}

/**
 * 周计划模板（F3）：7 个槽，索引 0 = 周日 … 6 = 周六（与 `Date.getDay()` 对齐）。
 * `null` = 还没配过模板。
 */
export interface WeekPlanTemplate {
  days: WeekPlanItem[][];
}

/** 一天的作息（F5）。`null` = 那一项还没打卡 */
export interface SleepEntry {
  date: DateKey;
  wakeAt: TimeKey | null;
  sleepAt: TimeKey | null;
}

/**
 * 一个习惯（F12）。打卡记录单独存成 `HabitCheck`，不挂在习惯对象上 ——
 * 习惯是**账号级**的配置（改个名字要同步到所有设备），打卡是**只增的流水**
 * （按 `habitId + date` 取并集）。两者混在一起，改一次名字就等于把整段历史重写一遍。
 */
export interface Habit {
  id: string;
  /** 1–16 字，如「背单词」「跑步」 */
  name: string;
  createdAt: string;
  /**
   * 归档时间；`null` = 在用。
   *
   * 为什么不直接删：连续打卡的天数是攒出来的，「不做了」和「不小心删了」
   * 得能分开。归档 = 从今日页消失但历史保留。
   */
  archivedAt: string | null;
  /**
   * 每天自动在「今日」生成一条同名任务（默认关）。
   *
   * 「背 50 词」这类事在待办清单和习惯打卡里各出现一次，用户得维护两处；
   * 打开这个开关后，习惯负责**定义**，任务负责**执行与排时间**。
   *
   * 三条取舍：
   * - 默认关：不请自来地往用户清单里塞任务是越权（与 autoContinue 同一原则）。
   * - 只生成一次：靠 `settings.habitTaskLog` 去重，**不是**靠"今天有没有同名任务"
   *   —— 后者在用户手动删掉那条之后会立刻再生成，变成删不掉的钉子。
   * - 单向：任务完成**不会**回头替你打卡（联动方向单一，避免"勾了任务习惯也
   *   自动算过"这种惊喜）。要打卡仍然自己点。
   */
  autoTask?: boolean;
}

/** 一次打卡：哪天做了哪个习惯。用「habitId + date」做主键，所以重复打卡是幂等的 */
export interface HabitCheck {
  habitId: string;
  date: DateKey;
}

/**
 * 「这个习惯在这一天已经生成过任务了」。
 *
 * 与 `HabitCheck` 形状相同但**语义相反**：check 是"做了"，这里是"派过"。
 * 合成一张表会让两件事互相污染（打卡一次就再也不会生成任务），所以分开。
 */
export interface HabitTaskLogEntry {
  habitId: string;
  date: DateKey;
}

export interface DiaryEntry {
  /**
   * 主键：**一天一篇**，'YYYY-MM-DD'。
   * 用日期而不是 uuid 做主键，是为了让"同一天在两台设备上各写一段"能被合并逻辑
   * 认成同一篇、按 updatedAt 取新，而不是变成两篇打架。
   */
  date: DateKey;
  /** 正文，trim 后 ≤ DIARY_MAX；空正文的条目不落盘（等于没写） */
  content: string;
  createdAt: string;
  /** 每次编辑刷新；多设备合并时新者胜 */
  updatedAt: string;
}

/* ---------- 设置（持久化） ---------- */
export interface Category {
  /** 'c_learn' 等稳定 id，重命名不影响任务 */
  id: string;
  /** 显示名，任务侧存 name */
  name: string;
}

/**
 * 一个「目标倒计时」（考试 / 截止日）。
 *
 * 为什么是 settings 里的**数组**而不是新的顶层集合：
 * - 它是纯展示用的元数据，不参与任务 / 日记 / 复习的任何计算；
 * - 挂在 settings 里意味着**不需要动 PersistedPayload、SCHEMA_VERSION、
 *   persistDeps 与 MIGRATIONS**（加字段不加版本，与 focusMinutes 同待遇）；
 * - 代价是合并策略要单独处理：settings 整体取"较新一方"，若不按 id 取并集，
 *   较旧一方新加的目标会在首次合并时凭空消失（见 cloudSync.mergeGoals）。
 *
 * 为什么 `date` 用 DateKey 而不是 ISO 时间戳：倒计时是"还有几天"，
 * 只跟本地日期有关；ISO 时间戳会引入时区换算，容易差一天。
 */
export interface ExamGoal {
  id: string;
  /** 显示名，trim 后 1–40 字符 */
  name: string;
  /** 目标日 'YYYY-MM-DD'（本地时区安全） */
  date: DateKey;
}

export interface Settings {
  schemaVersion: 1;
  theme: ThemeMode;
  defaultView: ViewId;
  /** 1 = 周一 */
  weekStart: 0 | 1;
  categories: Category[];
  /** 冷启动落在这个日期 */
  lastSelectedDate: DateKey;
  /** 记住上次视图（PRD Q1） */
  lastView: ViewId;
  filterMode: FilterMode;
  /** null = 全部分类 */
  filterCategory: string | null;
  /** 已完成组是否收起（默认 true） */
  doneCollapsed: boolean;
  /** 到期提醒（系统通知）；默认 false —— 首次开启时才向用户要通知权限 */
  remindEnabled: boolean;
  /**
   * 番茄严格模式（F6）：专注期间离开本页超过 5 秒视为中断，这段不记录。
   *
   * 番茄ToDo 的经验 —— 有价值的是这个**开关**，而不是常驻锁机：
   * 锁机要权限、要后台常驻，代价大得多；而"离开就不算"已经足够对付刷手机。
   */
  strictFocus: boolean;
  /**
   * 每日新卡上限（F9）。0 = 不限制。
   *
   * Anki 的默认值是 20 —— 考前积压的真正原因不是"复习不完"，
   * 而是新卡无上限地把队列撑爆。默认沿用 20，可调。
   */
  dailyNewCardLimit: number;
  /**
   * 每日专注目标（分钟）。`0` = 不设目标（默认）。
   *
   * 番茄钟只告诉你"这段 25 分钟结束了"，而备考要管的是"今天总共学够没有"。
   * 目标一旦可见，晚上还剩 40 分钟这件事会自己推着人坐下 —— 比提醒有效。
   *
   * 上限 24 小时（`FOCUS_GOAL_MAX_MINUTES`）：设置会经云同步从别的设备过来，
   * 一个 99999 会让进度条永远停在 0.1%。
   */
  dailyFocusGoalMinutes: number;
  /**
   * 番茄自动续接（F16）：专注结束→自动进休息→休息结束→**自动开始下一段**。
   *
   * 默认关。开了之后整条链路不用手点，代价是**人走了它也照跑**：
   * 只要页面还可见，一段接一段都会如实记录（`isAbandonedFocus` 只挡
   * "跨了 3 倍时长且超过 1 小时"的极端情况）。所以：
   * - 页面不可见（切标签 / 锁屏）时**不续接**，直接回 idle —— 这是防假数据的底线；
   * - 设置页的说明里必须把这句话讲清楚，不能只写"省手"。
   */
  autoContinue: boolean;
  /**
   * 作息打卡（F5）：一天一条，只留最近 90 天。
   *
   * 为什么值得做：用户是凌晨 2 点睡、11 点起的人，而"晚睡"这件事在他自己的
   * 数据里**本来是隐形的** —— 热力图只记专注时长，看不出"我每天几点睡"。
   * 打卡让这件事可见，但**不做说教**（不评分、不催促）。
   */
  sleepLog: SleepEntry[];
  /**
   * 习惯打卡（F12）。放在 settings 里而不是新的顶层集合 ——
   * 与 `sleepLog` / `goals` / `weekPlanTemplate` 同一档：规模小、跟着账号走。
   *
   * ⚠️ 新增**顶层**集合（payload 多一个 key）是完全另一件事：那要动
   * SCHEMA_VERSION、migrate 链、备份文件格式，并且旧端一律判成
   * future-version 拒绝同步。所以习惯刻意留在 settings 内部。
   */
  habits: Habit[];
  /** 打卡流水；按 `habitId + date` 唯一，合并时取并集 */
  habitChecks: HabitCheck[];
  /**
   * 「习惯 → 今日任务」的生成记录（只增流水）。
   *
   * 为什么必须记流水，而不是每次打开应用时"看今天有没有同名任务"：
   * 用户把自动生成的任务**删掉**之后，那个判断会立刻再生成一条 ——
   * 删不掉的钉子。有了流水，删了就是删了，第二天才可能有新的。
   *
   * 与 `habitChecks` 同一待遇：合并时**取并集**（漏了它会让另一台设备
   * 已经生成过的习惯在那台机器上又生成一遍）。
   */
  habitTaskLog: HabitTaskLogEntry[];
  /**
   * 周报自动生成开关（默认**开**）。
   *
   * 为什么默认开：写进日记是幂等替换（同一个 `## 本周回顾` 区块），
   * 用户可以随时改、随时删；而"每周手动点一次生成"在真实使用里几乎不会发生 ——
   * 默认关等于这个功能不存在。不想被写的话，日记页那个开关一点就关。
   */
  weeklyAutoReport: boolean;
  /**
   * 已自动生成过周报的**周起始日**（`startKey`，只增流水，合并取并集）。
   *
   * 作用与 `habitTaskLog` 完全相同：用户把自动写进去的周报删掉后，
   * 没有这条记录就会被反复写回去。有它 = 这一周处理过了，不再管。
   */
  weeklyReportLog: DateKey[];
  /**
   * 每日收尾卡「已经看过」到哪一天（F15-A）。
   *
   * 收尾卡回顾的是**昨天**，一天只该出现一次。没有这个标记的话，
   * 每次刷新 / 冷启动它都会再弹一遍 —— 第二天早上被同一张卡拦住三次，
   * 用户会开始讨厌它。`null` = 从没看过。
   */
  lastRecapSeen: DateKey | null;
  /**
   * 专注记录的**清理水位线**（2-6）。
   *
   * 专注记录是"按 id 取并集"的只增流水 —— 本地删掉一条，下一次云同步会把它
   * 原样并回来。所以清理不能只是删数组元素，必须同时记下"这个日期之前的我都
   * 不要了"，合并时按水位线过滤。水位线**只增不减**（两台设备取较晚的那个）。
   */
  focusPrunedBefore: DateKey | null;
  /** 周计划模板（F3）：`null` = 没配过 */
  weekPlanTemplate: WeekPlanTemplate | null;
  /**
   * 一天从几点开始（0–6）。`0` = 午夜翻页。
   *
   * 给熬夜的人准备的：凌晨 1 点还在学，不该已经被算进"明天" ——
   * 否则进度条会突然清零、昨晚的任务集体变逾期。
   * 设 4 表示凌晨 4 点前都还算前一天。
   */
  dayStartHour: number;
  /** 番茄钟默认时长（分钟） */
  focusMinutes: number;
  /** 番茄之间的休息时长（分钟） */
  breakMinutes: number;
  /**
   * 目标倒计时（考试 / 截止日）。**必填数组，默认 `[]`**（不设可选）。
   *
   * 为什么不用 `goals?: ExamGoal[]`：可选会让每一处读取都要写 `?? []`，
   * 迟早漏一处（漏在合并里就是"目标凭空消失"）。靠 `createDefaultSettings`
   * 给 `[]`、靠 `sanitizeSettings` 兜底，比到处判空安全。
   *
   * ⚠️ 它住在 settings 内部 —— 所以 `PersistedPayload` / `SCHEMA_VERSION` /
   * `persistDeps` / `MIGRATIONS` **一个都不用动**。
   */
  goals: ExamGoal[];
}

/* ---------- Toast / 撤销 ---------- */
export type UndoPayload =
  | { kind: 'delete'; task: Task; index: number }
  | {
      kind: 'move-to-today';
      /** `endDate` 记录被搬走之前的结束日；批量平移会改它，撤销必须能还原 */
      moves: { id: string; from: DateKey; endDate?: DateKey | null }[];
    }
  /**
   * 拖拽落位。与 `move-to-today` 的区别只有两点：
   * ① 它带 `order`（排序位也要还原）—— 落位会把目标日整段重新编号，
   *    只还原日期的话那一天会留下两个相同编号，顺序退化成自动排序；
   * ② `moves` 里**不止被拖的那一条**，凡是编号被改动的都要还原。
   */
  | { kind: 'drag'; moves: { id: string; from: DateKey; order: number }[] };

export interface ToastAction {
  /** '撤销' */
  label: string;
  undo: UndoPayload;
}

export interface ToastState {
  /** 每次新 toast 换 id，用于 key 重播入场动画 */
  id: string;
  /** '已删除「数学真题」' */
  message: string;
  tone: 'default' | 'warn' | 'danger';
  action: ToastAction | null;
  /** 5000（撤销类）/ 3200（提示类）/ 6000（错误类） */
  timeoutMs: number;
}

/* ---------- 瞬时 UI 状态（不持久化） ---------- */
export interface UIState {
  /** null = 抽屉关闭 */
  drawerTaskId: string | null;
  /** 关闭后归还焦点的任务行 id */
  drawerReturnFocusId: string | null;
  /** 日历视图当前展示月 */
  monthCursor: MonthCursor;
  toast: ToastState | null;
  /** 本次会话刚勾选、需「原地停留」的 id（C5） */
  stickyDoneIds: string[];
  saveState: SaveState;
  /** 非 null 时 Toast 提示且不阻塞操作 */
  storageError: string | null;
  /**
   * 原生端（APK）启动 hydration 门控：true 时 StoreProvider 只渲染 BootSplash，
   * children 不挂载。会话级字段，**不落盘**（装载完成后 HYDRATE 置回 false）。
   * 网页 / 桌面端恒为 false（同步装载，无门控）。
   */
  hydrating: boolean;
  /**
   * 盘上可能**有数据、但这次没读出来**（APK 冷启动超时 / 存储临时不可用）。
   *
   * 置 true 之后 `usePersist` 一律不写盘、云同步也不推 —— 因为内存里是空态，
   * 一旦允许落盘，用户随手加一条任务就会把盘上那份真实数据整包覆盖。
   * 这是全应用唯一能"一次点击丢光所有数据"的路径，所以单独给它一个标志，
   * 而不是复用 `storageError`（那只是一句话，用户划走就忘了，也拦不住写盘）。
   *
   * 解除条件：下一次装载成功（重启应用）。
   */
  persistBlocked: boolean;
}

/* ---------- 根状态 ---------- */
export interface AppState {
  tasks: Task[];
  /** 记事本：不绑日期的知识沉淀，与 tasks / diary 平级持久化 */
  notes: Note[];
  settings: Settings;
  /** 日记，一天一篇；与 tasks 平级持久化 */
  diary: DiaryEntry[];
  /** 已删除任务的墓碑；跨设备同步删除用，见 TaskTombstone 注释 */
  tombstones: TaskTombstone[];
  /** 专注记录（自习室时长统计的数据源） */
  focusSessions: FocusSession[];
  ui: UIState;
}


/* ---------- 记事本 ----------
 * 与日记的区别：日记按天组织、一天一篇；记事不绑日期，
 * 是"我知道什么"的沉淀 —— 配置片段、报错与解法、点子、考点。
 */
/**
 * 一条记事的复习进度（间隔重复）。
 *
 * 为什么挂在 Note 上而不是另建一张"卡片表"：
 * 卡片的正文就是记事正文，两者永远同步；分开存意味着"删了记事忘了删卡片"、
 * 云同步时还要维护两份数据的一致性。挂在一起，`NOTE_UPSERT` 一条路径就能覆盖
 * 新建 / 编辑 / 评级 / 退出复习四种动作（**不需要新增任何 reducer action**）。
 */
export interface NoteSr {
  /** 下次到期日 'YYYY-MM-DD'；新卡 = 入队当天 */
  due: string;
  /**
   * 当前间隔（天）。
   * **`0` = 已入队但还没学过的新卡** —— 这个 0 是有语义的，不能当"没设置"处理。
   */
  ivl: number;
  /** 复习过多少次（含 again）；只增不减，用于展示投入量 */
  reps: number;
  /**
   * **最近一次评级的 ISO 时间**（与同一份 sr 的 note.updatedAt 是同一个值）。
   *
   * 为什么必须落库而不是"用时现推"：周报要回答"本周复习了几张卡"，
   * 而 `due` / `ivl` 都是**未来**的信息（下次什么时候再来），反推不出
   * "上一次是哪天学的" —— 一张 30 天间隔的卡，昨天学还是 20 天前学，
   * due 都是同一天。只有记下这次评级的时间，才能统计"投入量"。
   *
   * 可选：老数据（v0.8 之前评过级的卡）没有这个字段，统计时按"未复习"处理，
   * 绝不会因为缺它而丢掉 sr、更不会丢掉 note（见 srs.ts::sanitizeSr）。
   */
  last?: string;
}

/**
 * 一条记事的**闹钟**（提醒到点响一次，但**不进复习队列**）。
 *
 * 场景来自用户原话：「他可能就是个提醒要刷牙的小事，不是知识点不需要复习，
 * 不过可以加个闹钟提醒类似事情」。
 *
 * 所以它和 `sr` 是**两条完全独立的路**：
 * - `sr` = 这张卡要背，按间隔重复排期（进复习队列）；
 * - `remind` = 这条记事只是个生活提醒（到点响铃），永远不进队列。
 *
 * 判定"是不是卡片"的唯一依据仍然是"有没有 sr 键"（见 lib/srs.ts::isCard），
 * 所以给一条记事加闹钟**不会**把它变成复习卡。
 */
export interface NoteRemind {
  /** 'HH:mm'（24 小时制，形如 '07:30'）；本地时间比较用 */
  at: TimeKey;
  /** 'none' = 仅一次（响过就算）；'daily' = 每天同一时间响 */
  repeat: 'none' | 'daily';
}

export interface Note {
  id: string;
  title: string;
  /** Markdown 正文 */
  content: string;
  /** 分类 id，与任务共用同一套分类（空串 = 未分类） */
  category: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  /**
   * 复习进度。**有没有这个键 = 这条记事是不是复习卡片**：
   * - 无此键 → 普通记事，完全不进复习队列；
   * - `ivl === 0` → 已入队未学习的新卡；
   * - `ivl > 0` → 已排期的卡，`due <= 今天` 即到期。
   *
   * 所以"退出复习"必须是**删掉这个键**（见 lib/srs.ts::unenroll），
   * 而不是把它置 null / undefined —— 留着键会让一条普通记事被当成卡片。
   */
  sr?: NoteSr;
  /**
   * 闹钟（到点响铃，不进复习队列）。**有没有这个键 = 这条记事有没有闹钟**：
   * 关掉闹钟必须是删掉这个键（同 sr 的纪律），不是置 null。
   *
   * 与 sr 的区别：`sr` 影响复习队列，`remind` 只影响设备本地的一次响铃 ——
   * 它是一条**业务数据**（会在三端之间同步），但"今天响过没有"只记在设备本地
   * （见 hooks/useNoteReminders.ts 的 NOTE_REMIND_LOG_KEY）。
   */
  remind?: NoteRemind;
}

/* ---------- 持久化载荷 ---------- */
export interface PersistedPayload {
  /** 当前 5（1=tasks+settings，2=diary，3=tombstones，4=focusSessions，5=notes） */
  schemaVersion: number;
  savedAt: string;
  tasks: Task[];
  settings: Settings;
  /** 2 起才有；迁移老数据时补空数组 */
  diary: DiaryEntry[];
  /** 3 起才有；迁移老数据时补空数组 */
  tombstones: TaskTombstone[];
  /** 4 起才有；迁移老数据时补空数组 */
  focusSessions: FocusSession[];
  /** 5 起才有；迁移老数据时补空数组 */
  notes: Note[];
}

/* ---------- 派生视图模型 ---------- */
export interface DayCell {
  key: DateKey;
  /** 1-31 */
  day: number;
  /** 是否属于当前展示月（补位格为 false） */
  inMonth: boolean;
  isToday: boolean;
  /** 0-6（0=周日，与 Date.getDay 一致） */
  weekday: number;
}

export interface DayProgress {
  done: number;
  total: number;
  /** total === 0 时为 null（UI 显示 '—'） */
  percent: number | null;
}

export interface DayGroup {
  /** 逾期（由 OverdueSection 独立渲染，不进 TaskList 的「待办/已完成」两段） */
  overdue: Task[];
  /** 待办渲染序：未完成 + 本次会话刚勾选的 sticky 项，混排于同一 compareOpenTasks 比较器 */
  open: Task[];
  /** 已完成（不含 sticky） */
  done: Task[];
  /** open 中属于 sticky 的子集（仅用于 isSticky 样式与「已完成 · N」的增量计数） */
  sticky: Task[];
  /**
   * 子任务索引：parentId → 子任务（已排序）。
   *
   * 为什么放在 DayGroup 里而不是让 TaskList 自己 filter：
   * 待办/已完成两段是**分开渲染**的，子任务该跟着父任务所在的那一段走。
   * 由 groupDayTasks 一次性算好，渲染层就不必再理解"父子"这件事。
   */
  childrenByParent: Record<string, Task[]>;
}

/* ---------- 周视图派生模型 ---------- */
export interface WeekColumn {
  key: DateKey;
  /** 1-31 */
  day: number;
  isToday: boolean;
  /** === settings.lastSelectedDate */
  isSelected: boolean;
  /** 已按 compareWeekColumnTasks 排序后切出的前 maxRows 条 */
  tasks: Task[];
  /** 超出 maxRows 的条数（UI 显示「+N 条」），0 表示不显示 */
  overflow: number;
  /** 列底 `3/5` + 极细进度条，与侧栏/今日视图同源 */
  progress: DayProgress;
  /** 该日无任何任务 → 显示极淡「—」 */
  isEmpty: boolean;
}

/* ---------- 存储层错误 ---------- */
export type StorageLoadError = 'unavailable' | 'corrupt' | 'future-version';

export interface LoadResult {
  payload: PersistedPayload | null;
  error: StorageLoadError | null;
  backupCreated: boolean;
}

export type SaveResult =
  | { ok: true }
  | { ok: false; reason: 'quota' | 'unavailable' | 'unknown' };
