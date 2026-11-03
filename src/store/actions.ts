import type {
  DateKey,
  DiaryEntry,
  ExamGoal,
  FilterMode,
  FocusSession,
  Habit,
  MonthCursor,
  Note,
  SaveState,
  Settings,
  Task,
  TaskTombstone,
  ThemeMode,
  TimeKey,
  ToastState,
  ViewId,
  WeekPlanItem,
} from '../types';
import type { DropTarget } from '../lib/drag';

/* ============================================================================
   全部 action 的联合类型（**唯一声明处**）

   为什么单独一个文件：reducer 已经按域拆成了 domains/*，而"系统里到底有哪些
   action"是跨域的事实。放在任何一个域文件里，另外几个域都要反过来 import 它，
   依赖方向就乱了。放这里，所有域只依赖 types + actions，没有环。

   ⚠️ 新增 action 必须同时：
   ① 加进这个联合；
   ② 在对应的 domains/*.ts 里写 case；
   ③ 加进 `lib/__tests__/p2Constraints.test.ts` 的 FROZEN_ACTIONS。
   漏 ③ 测试会红（这是故意的：action 面是契约，不该悄悄变）。
   ========================================================================= */

export type AppAction =
  /**
   * 整包替换。`diary` 可选：不传表示"这次不动日记"（比静默清空安全）。
   * ⚠️ 云同步路径**必须显式传**，否则同步回来的日记装不进状态里。
   */
  | {
      type: 'HYDRATE';
      tasks: Task[];
      settings: Settings;
      storageError: string | null;
      /**
       * 盘上可能有数据但没读出来 → 禁止落盘。
       * 不传 = false（正常装载，包括"新设备第一次启动"，那种情况本来就没有数据可覆盖）。
       */
      persistBlocked?: boolean;
      diary?: DiaryEntry[];
      /** 墓碑；不传表示"这次不动墓碑"（比静默清空安全） */
      tombstones?: TaskTombstone[];
      /** 专注记录；不传表示"这次不动"（比静默清空安全） */
      focusSessions?: FocusSession[];
      /** 记事本；不传表示"这次不动" */
      notes?: Note[];
    }
  | { type: 'TASK_ADD'; task: Task }
  | { type: 'TASK_PATCH'; id: string; patch: Partial<Task>; now: string }
  | { type: 'TASK_TOGGLE'; id: string; now: string }
  /** 删除：从 tasks 移除并留一条墓碑，让"删了"这件事能同步到别的设备 */
  | { type: 'TASK_DELETE'; id: string; now: string }
  /**
   * 撤销删除。
   *
   * `now` 用来**刷新恢复出来那条任务的 updatedAt** —— 这不是可选项：
   * 删除时留了墓碑（deletedAt = 删除那一刻），恢复时若沿用任务原来的旧
   * updatedAt（必然早于 deletedAt），云同步合并时 `applyTombstones` 会判
   * "这条已删" 把它再删一次 —— 用户以为撤销成功，结果下一秒真丢了。
   */
  | { type: 'TASK_RESTORE'; task: Task; index: number; now: string }
  /**
   * 拖拽落位（改日期 / 手动排序）。
   *
   * `target` 的三种形态见 lib/drag.ts 的 `DropTarget`：
   * `day` = 只改日期（保持目标日的自动排序）；`before` / `end` = 明确插到哪
   * → 目标日转为手动排序并连续编号。
   *
   * 子任务跟着父任务一起改日期（父改子不改，子会从父底下消失）。
   * 没有实际变化时 reducer 返回**同一个 state**（lib 层返回原数组引用）。
   */
  | { type: 'TASK_MOVE'; id: string; target: DropTarget; now: string }
  | { type: 'TASK_MOVE_TO_TODAY'; ids: string[]; targetDate: DateKey; now: string }
  /**
   * 撤销一次移动。`order` 可选：拖拽撤销带着它（排序位一起还原），
   * 「移到今天」不带（那种移动压根不动排序位）。
   */
  | {
      type: 'TASK_UNDO_MOVE';
      /**
       * `order` / `endDate` 都是可选的：
       * - 拖拽撤销带 `order`（排序位要一起还原）和 `endDate`（多天任务的区间）；
       * - 「移到今天」带 `endDate`（批量平移时区间跟着走了）；
       * - 字段**缺省**表示"这次不动它"，`null` 表示"还原成没有结束日" —— 两者不同，
       *   所以下面用 `in` 判断而不是 `??`。
       */
      moves: { id: string; from: DateKey; order?: number; endDate?: DateKey | null }[];
      now: string;
    }
  | { type: 'SET_FILTER'; mode?: FilterMode; category?: string | null }
  | { type: 'SET_VIEW'; view: ViewId }
  | { type: 'SET_DEFAULT_VIEW'; view: ViewId }
  | { type: 'SET_SELECTED_DATE'; date: DateKey }
  | { type: 'SHIFT_DATE'; delta: -1 | 1 }
  | { type: 'SHIFT_WEEK'; delta: -1 | 1 }
  | { type: 'SET_MONTH'; cursor: MonthCursor }
  | { type: 'SET_THEME'; theme: ThemeMode }
  | { type: 'SET_WEEK_START'; weekStart: 0 | 1 }
  | { type: 'TOGGLE_DONE_COLLAPSED' }
  | { type: 'SET_REMIND_ENABLED'; value: boolean }
  /** 番茄严格模式（F6） */
  | { type: 'SET_STRICT_FOCUS'; value: boolean }
  /** 番茄自动续接（F16）：专注↔休息全自动，不用手点 */
  | { type: 'SET_AUTO_CONTINUE'; value: boolean }
  /** 每日新卡上限（F9）；0 = 不限制 */
  | { type: 'SET_DAILY_NEW_CARD_LIMIT'; value: number }
  /** 每日专注目标（分钟）；0 = 不设目标 */
  | { type: 'SET_DAILY_FOCUS_GOAL'; minutes: number }
  /**
   * 作息打卡（F5）。只传要改的那一项，另一项保持原值；
   * 传 `null` 表示清除（点错了可以撤）。
   */
  | { type: 'SLEEP_LOG_SET'; date: DateKey; wakeAt?: TimeKey | null; sleepAt?: TimeKey | null }
  /**
   * 清理 `date < before` 的专注记录，并把水位线推到 `before`（2-6）。
   *
   * 为什么要水位线：专注记录在云同步里是**按 id 取并集**的只增流水，
   * 光删本地数组，下一次同步会原样并回来 —— 用户会觉得"清理没用"。
   */
  | { type: 'FOCUS_PRUNE'; before: DateKey }
  /** 周计划模板（F3）：往某一天加一条 */
  | { type: 'WEEK_PLAN_ADD'; weekday: number; item: WeekPlanItem }
  /** 周计划模板：删掉某一天的第 index 条 */
  | { type: 'WEEK_PLAN_REMOVE'; weekday: number; index: number }
  /**
   * 套用模板（F3）：把模板展开成任务。
   * 幂等——已在同一天存在同标题同分类的任务会被跳过，所以点两次不会出两份。
   */
  | { type: 'WEEK_PLAN_APPLY'; days: DateKey[]; now: string }
  /** 日界：一天从几点开始（0–6）。改动会立刻影响"今天"是哪一天 */
  | { type: 'SET_DAY_START'; hour: number }
  /** 一段专注多长（分钟，1–180） */
  | { type: 'SET_FOCUS_MINUTES'; minutes: number }
  /** 两段专注之间休息多久（分钟，0–60） */
  | { type: 'SET_BREAK_MINUTES'; minutes: number }
  /**
   * 目标倒计时列表（考试 / 截止日）。
   *
   * ⚠️ 这**不是新增业务实体**，而是 `settings` 里一个字段的整体替换 ——
   * 与 `SET_WEEK_START` / `SET_FOCUS_MINUTES` 同一类（settings 字段更新）。
   * 增 / 删 / 改都走它：UI 传"改完之后的那份数组"，reducer 只做兜底与去重
   * （`sanitizeGoals`）。这样就不会出现 ADD / REMOVE / PATCH 三个 action
   * 各写一份校验的局面。
   *
   * 为什么不做成 TASK_PATCH 那种"按 id 补一轮"：goals 的规模是个位数，
   * 整表替换的写盘/合并代价可以忽略，而代码路径只有一条。
   */
  | { type: 'SET_GOALS'; goals: ExamGoal[] }
  /**
   * 习惯配置整表替换（增 / 删 / 改名 / 归档共用一条）。
   *
   * 与 `SET_GOALS` 同一个模式：UI 传"改完之后的那份数组"，reducer 只做兜底
   * （`sanitizeHabits`）并顺手清掉被删习惯的打卡记录。
   * 为什么不拆成 ADD / REMOVE / RENAME 三条：那样每条都要各写一份校验，
   * 而习惯的规模是个位数，整表替换的代价可以忽略。
   */
  | { type: 'SET_HABITS'; habits: Habit[] }
  /**
   * 习惯打卡切换（幂等）。
   *
   * 打卡是"那天做了"这个事实，没有可编辑内容，所以不需要 `now` ——
   * 也就不需要在 reducer 里读时钟（保持"同输入同输出"）。
   */
  | { type: 'HABIT_TOGGLE_CHECK'; habitId: string; date: DateKey }
  /**
   * 收尾卡「已读」（F15-A）。记的是**被回顾的那一天**，不是今天 ——
   * 这样"昨天看过了"这个事实不会因为跨天而失效。
   */
  | { type: 'SET_RECAP_SEEN'; date: DateKey }
  /**
   * 为当天「开了自动生成」的习惯各建一条任务（长期迭代：习惯 ↔ 任务联动）。
   *
   * 与 `WEEK_PLAN_APPLY` 同一个模式：给日期 + now，**自己去读** settings 里的
   * 习惯与生成流水，而不是让 UI 把标题一坨传进来 —— 判定逻辑只该有一份。
   *
   * 幂等：已派过的习惯（流水里有 `habitId|date`）不会再派；全都派过 / 没有
   * 习惯开着开关 → 返回**同一个 state**（不写盘、不触发云推送）。
   */
  | { type: 'HABIT_TASK_GENERATE'; date: DateKey; now: string }
  /**
   * 周报自动生成开关。
   *
   * 为什么值得一条独立 action 而不是 `SET_WEEKLY_AUTO_REPORT` 只是
   * `patchSettings` 的糖：开关是**用户明确表态**"不要替我写"，
   * reducer 里做幂等判断（值没变不写盘）比让 UI 保证"只在真的变了才 dispatch"
   * 可靠 —— UI 那边是 checkbox，浏览器会给它一次多余的回调。
   */
  | { type: 'SET_WEEKLY_AUTO_REPORT'; value: boolean }
  /**
   * 记下"这一周的自动周报已经处理过了"（`startKey` = 那一周的起始日）。
   *
   * 为什么需要：用户把自动写进去的那段删掉之后，没有这条记录就会立刻被
   * 再写一遍 —— 删不掉的钉子。`habitTaskLog` 是同一套思路。
   *
   * ⚠️ 周报**正文**仍然走 `DIARY_UPSERT`（内容可变、一天一篇），
   * 这条只记日期，不存内容。
   */
  | { type: 'WEEKLY_REPORT_LOG_ADD'; startKey: DateKey }
  | { type: 'CATEGORY_ADD'; id: string; name: string }
  | { type: 'CATEGORY_RENAME'; id: string; name: string }
  | { type: 'CATEGORY_REMOVE'; id: string }
  /** 写日记：一天一篇，按 date 覆盖 */
  | { type: 'DIARY_UPSERT'; date: DateKey; content: string; now: string }
  /**
   * 删日记：**置空而不是移除**，让"删除"这个动作能同步到别的设备。
   * 真移除的话，手机上删了、电脑一同步又会从云端合并回来。
   * UI 渲染时过滤掉空条目即可（对用户等于这天没写）。
   */
  | { type: 'DIARY_DELETE'; date: DateKey; now: string }
  | { type: 'OPEN_DRAWER'; taskId: string; returnFocusId: string | null }
  | { type: 'CLOSE_DRAWER' }
  | { type: 'TOAST_SHOW'; toast: ToastState }
  | { type: 'TOAST_DISMISS'; id: string }
  | { type: 'NOTE_UPSERT'; note: Note; now: string }
  /** 删记事：软删除（内容置空 + 打时间戳），详见 domains/content.ts 的实现说明 */
  | { type: 'NOTE_DELETE'; id: string; now: string }
  | { type: 'UI_SAVE_STATE'; saveState: SaveState; error?: string | null }
  | { type: 'DATA_CLEAR_ALL' }
  | { type: 'DATA_IMPORT_DEMO'; tasks: Task[] }
  /**
   * 归档：删掉 `before` 之前且已完成的任务（控制数据体积）。
   * 用 `task.date` 而不是 `doneAt` 判定 —— 前者就是本地日期字符串，可直接比较；
   * doneAt 是 ISO 时间戳，涉及时区换算，容易差一天。
   */
  | { type: 'ARCHIVE_DONE'; before: DateKey; now: string }
  /** 记一段专注：由番茄钟结束时提交，已含 date 与 durationMs */
  | { type: 'FOCUS_LOG'; session: FocusSession }
  /** 删掉一条专注记录（记错了 / 误开），按 id 精确移除 */
  | { type: 'FOCUS_DELETE'; id: string }
  /**
   * 从回收站恢复一条已删任务。
   * 恢复时**必须同时清掉它的墓碑** —— 否则任务刚回来，下次合并又被删一次。
   */
  | { type: 'TOMBSTONE_RESTORE'; id: string; now: string }
  /** 清空回收站：墓碑全部丢弃（被删的任务从此不可恢复） */
  | { type: 'TOMBSTONE_CLEAR' };
