import type { Category, Priority, Repeat, Settings, ViewId } from './types';

/* ============================================================================
   存储
   ========================================================================= */
/** 单 key 整包存储（ARCHITECTURE §3.3） */
export const STORAGE_KEY = 'dt:app:v1';
export const BACKUP_KEY = 'dt:app:v1.backup';
/**
 * 快照 key：每次成功保存都镜像一份，主 key 被清掉时用它兜底恢复。
 * 注意它防不住"整个存储被清"（卸载 / 清除应用数据），那种情况只能靠导出的备份文件。
 */
export const SNAPSHOT_KEY = 'dt:app:v1.snapshot';
/**
 * 上一份快照（A/B 双快照）。
 *
 * 为什么需要：`SNAPSHOT_KEY` 每次保存都会被覆盖。如果某次写出去的内容是坏的
 * （序列化出错、内存里的数据已经被写坏），快照跟着一起坏 —— 唯一的自救机会就没了。
 * 所以写入新快照前，先把旧的那份挪到这里，形成"当前 / 上一份"两级。
 *
 * ⚠️ 体积保护见 `SNAPSHOT_PREV_MAX_BYTES`：三份大 JSON 会撞 localStorage 配额，
 * 那比"没有备份"更糟（主 key 都写不进去了）。
 */
export const SNAPSHOT_PREV_KEY = 'dt:app:v1.snapshot.prev';
/**
 * 上一份快照的体积上限（512 KB）。
 *
 * 超过就**跳过** prev 备份：localStorage 总量约 5 MB，主 key + 快照 + prev
 * 三份大 JSON 一旦撞配额，第一个失败的是主 key 的写入 —— 相当于为了备份
 * 把正本弄丢了。宁可少一份历史，也不能让正本写不进去。
 *
 * 桌面端（Electron 文件备份）不受这个限制，那边写的是文件。
 */
export const SNAPSHOT_PREV_MAX_BYTES = 512 * 1024;
/**
 * 进行中的专注计时（单独一个 key，不进主 payload）。
 *
 * 为什么不塞进 PersistedPayload：它是**设备本地**状态 —— 手机上在计时、
 * 电脑上没在计时，同步它只会让另一端莫名其妙弹出一个倒计时。
 * 但刷新页面不该丢，所以单独落盘。
 */
export const FOCUS_RUNNING_KEY = 'dt:app:v1.focus-running';
/**
 * 计时偏好（设备本地，独立于专注主 payload）。
 *
 * 只存"上次用哪个模式 + 提醒预设胶囊"，也是设备本地状态 ——
 * 手机上设的预设不该同步到电脑。走独立 key，和 FOCUS_RUNNING_KEY 同纪律。
 */
export const FOCUS_PREFS_KEY = 'dt:app:v1.focus-prefs';
/**
 * 笔记闹钟的「已提醒记录」（**设备本地**，独立于专注主 payload）。
 *
 * 存 `{ [dateKey: string]: string[] }`（noteId 列表），只保留最近 2 天。
 *
 * 为什么不进 payload：
 * 1. "今天响过没有"是**设备本地状态** —— 手机上响过、电脑上还没到点，
 *    同步它会让另一端莫名其妙少响一次；
 * 2. 更硬的一条：到点提醒时**绝对不能写 Note**。写 Note 会刷 `updatedAt`，
 *    于是每次响铃都变成一次业务数据变更 → 三端云同步 churn，
 *    还会把"提醒"污染成"笔记被编辑过"（列表排序乱跳）。
 *    所以响铃只写这个设备本地 key，一个字节都不碰载荷。
 */
export const NOTE_REMIND_LOG_KEY = 'dt:app:v1.note-remind-log';
/** 笔记闹钟记录的保留天数（今天 + 昨天）：只为了防止脏数据无限增长 */
export const NOTE_REMIND_LOG_KEEP_DAYS = 2;
/**
 * 离线写入队列（outbox）在**设备本地**的 key。
 *
 * 为什么不进 payload：它是"有没有东西还没送到云端"的传输态元数据，
 * 不是用户数据。塞进 payload 要动 SCHEMA_VERSION + 迁移链 + 备份格式，
 * 而且会跟着云同步来回传 —— 两台设备的队列混在一起毫无意义。
 */
export const OUTBOX_KEY = 'dt:app:v1.outbox';
/**
 * 队列最多保留多少条。
 *
 * 服务端是**快照式** API（一次推整包），所以重放时没必要逐条回放中间态
 * —— 那会把一堆过时的中间态推上去，让对端来回回滚。
 * 队列的价值是"我确实还有东西没送达"这个**事实**以及它的发生顺序；
 * 超过上限就折叠成计数（`dropped`），绝不无限增长把 localStorage 撑爆。
 */
export const OUTBOX_MAX_ENTRIES = 20;
/**
 * 载荷结构版本。
 * - 1：tasks + settings
 * - 2：新增 diary（日记）
 * - 3：新增 tombstones（已删除任务的墓碑，让删除能跨设备同步）
 * - 4：新增 focusSessions（专注时长记录，自习室统计）
 *
 * ⚠️ 升版本意味着**旧端读到新数据会判成 future-version**（只读保护，拒绝覆盖）。
 * 所以升级后三端（网页 / 桌面 / APK）都要更新，否则老端会一直拒绝同步。
 */
/** 作息记录只留最近这些天（90 天足够看出趋势，又不至于把载荷撑大） */
export const SLEEP_LOG_KEEP_DAYS = 90;

export const SCHEMA_VERSION = 5;
export const SAVE_DEBOUNCE_MS = 300;
/**
 * 原生端（APK）启动装载的超时兜底（毫秒）。
 * Preferences 是异步 API：`runNativeHydration` 用它和真实装载赛跑，
 * 超时则 dispatch 兜底空态 + 存储错误提示，迟到的真实结果丢弃（R5）。
 */
export const HYDRATE_TIMEOUT_MS = 2500;

/* ============================================================================
   分类预设（C3）
   ========================================================================= */
export const DEFAULT_CATEGORIES: Category[] = [
  { id: 'c_learn', name: '学习' },
  { id: 'c_work', name: '工作' },
  { id: 'c_life', name: '生活' },
  { id: 'c_other', name: '其他' },
];

/** 删除分类时的兜底分类名 */
export const FALLBACK_CATEGORY_NAME = '其他';

/* ============================================================================
   优先级元数据（单一来源，禁止在组件里写颜色/文案）
   ========================================================================= */
export const PRIORITY_META: Record<Priority, { label: string; rank: number; className: string }> = {
  high: { label: '高', rank: 0, className: 'text-warn' },
  medium: { label: '中', rank: 1, className: 'text-ink-2' },
  low: { label: '低', rank: 2, className: 'text-ink-3' },
};

/** 抽屉里优先级分段选择器的顺序 */
export const PRIORITY_ORDER: Priority[] = ['high', 'medium', 'low'];

/* ============================================================================
   重复周期元数据（与 PRIORITY_META 同源同规矩，禁止在组件里写死文案）
   ========================================================================= */
export const REPEAT_META: Record<Repeat, { label: string; hint: string }> = {
  none: { label: '不重复', hint: '一次性任务' },
  daily: { label: '每天', hint: '完成后自动生成明天的一份' },
  weekly: { label: '每周', hint: '完成后自动生成下周同一天的一份' },
  monthly: { label: '每月', hint: '完成后自动生成下月同日的一份' },
};

/** 抽屉里重复周期分段选择器的顺序 */
export const REPEAT_ORDER: Repeat[] = ['none', 'daily', 'weekly', 'monthly'];

/* ============================================================================
   校验与长度上限
   ========================================================================= */
export const TITLE_MAX = 120;
export const NOTE_MAX = 500;
/**
 * 单条任务「预计用时」的上限（分钟）。
 *
 * 9999 分钟 ≈ 166 小时，够表达"这本书整体还要 100 小时"这种粗估，
 * 又能挡住手滑多按几个 0（1e9 分钟会让今日预算显示成天文数字）。
 * 下限恒为 0 —— `0` 的语义是**未估时**，不是"零分钟的任务"。
 */
export const ESTIMATE_MINUTES_MAX = 9999;
/** 单篇日记正文上限（5 MB localStorage 总量下，单篇不该吃掉太多） */
export const DIARY_MAX = 5000;
export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
export const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/* ============================================================================
   间隔重复（SRS）参数 —— 改这里就能调整整个复习节奏
   ========================================================================= */
/**
 * 每天最多放进来多少张**新卡**。
 *
 * 为什么要限：一次把 200 条记事全变成"今天要复习"，用户看一眼就放弃了。
 * 10 张是"两三天能背完一门小抄"的量级，也不会把当天的番茄钟挤爆。
 * 老卡（已排期且到期）**不受此限**，见 lib/srs.ts::dueCount 的说明。
 */
export const NEW_CARD_DAILY_CAP = 10;
/** 单张卡的最大间隔（天）。再长就没有复习意义了（一年后谁还记得这张卡存在） */
export const MAX_INTERVAL_DAYS = 365;
/** reps 上限，纯防脏数据把数字撑爆 */
export const MAX_REPS = 9999;
/** 成熟卡门槛（天）：间隔 ≥ 7 天算"背下来了" */
export const MATURE_INTERVAL_DAYS = 7;
/**
 * 新建记事时是否自动加入复习。
 *
 * 主理人裁定 v1 = **显式开关**（false）：记事本里大部分是"配置片段 / 点子"，
 * 自动全变成卡片会把复习队列灌满噪音。将来若改成 true，只需改这一行 ——
 * 但请先想清楚上面这句话。
 */
export const AUTO_ENROLL_ON_CREATE = false;

/** 笔记闹钟的默认时间（用户点开「闹钟」开关时先给个早上七点半，绝大多数提醒是这个点） */
export const DEFAULT_NOTE_REMIND_TIME = '07:30';

/* ============================================================================
   周视图
   ========================================================================= */
/** 每列最多显示的条数，超出折叠为「+N 条」 */
export const WEEK_MAX_ROWS = 4;

/* ============================================================================
   视图与筛选
   ========================================================================= */
export const VIEW_ORDER = [
  'today',
  'week',
  'calendar',
  'focus',
  'diary',
  'notes',
  'settings',
] as const;

/**
 * 底部 Tab 只放这 6 个（v0.29.5）。
 *
 * 原来是 7 个，390px 下每格 55.7px、320px 下 45.7px —— 数字上还站得住，
 * 但已经是"每个字都在挤"的状态，再加任何一个功能就得动结构。
 *
 * 收掉的是**日历**：它不是"另一个地方"，而是"周"的缩放层级（周 ↔ 月）。
 * 两者看的是同一件事（时间安排），只是粒度不同，所以合成一个入口：
 * 底部留 6 格，日历从周视图右上角那个按钮进（`data-testid="week-to-calendar"`），
 * 在日历里也能一键切回周。
 *
 * 桌面端的侧栏仍然列全部 7 个（`VIEW_ORDER`）—— 那边横向空间不值钱，
 * 多一个入口反而少点一次。
 */
export const TAB_VIEWS = [
  'today',
  'week',
  'focus',
  'diary',
  'notes',
  'settings',
] as const satisfies readonly ViewId[];

/**
 * 全部视图的导航文案与图标。
 * 注意 `trash` 与 `review` 有元数据但**都不在 VIEW_ORDER 里**：
 * 回收站只能从设置页进入，复习会话只能从「今日」横幅 / 记事本进入。
 */
export const VIEW_META: Record<
  ViewId,
  { label: string; icon: 'list' | 'calendar-week' | 'calendar' | 'timer' | 'book' | 'note' | 'settings' | 'trash' }
> = {
  today: { label: '今日', icon: 'list' },
  week: { label: '周', icon: 'calendar-week' },
  calendar: { label: '日历', icon: 'calendar' },
  focus: { label: '专注', icon: 'timer' },
  diary: { label: '日记', icon: 'book' },
  notes: { label: '记事本', icon: 'note' },
  settings: { label: '设置', icon: 'settings' },
  trash: { label: '回收站', icon: 'trash' },
  review: { label: '复习', icon: 'book' },
};

/** 月历四态文案（图例 + 格子 aria-label 共用，禁止组件里再写一份中文） */
export const STATUS_LABEL: Record<'empty' | 'none-done' | 'partial' | 'all-done', string> = {
  empty: '无任务',
  'none-done': '全部未完成',
  partial: '部分完成',
  'all-done': '全部完成',
};

export const FILTER_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'open', label: '未完成' },
  { value: 'done', label: '已完成' },
] as const;

/* ============================================================================
   文案常量（组件里不写字面量中文，便于后续统一改词）
   ========================================================================= */
export const TEXT = {
  anytime: '随时',
  /** 复习时盖住图片的那层提示（F13：错题图片遮挡自测） */
  imageCoverHint: '点击显示图片',
  allCategories: '全部分类',
  emptyToday: '今天还没有任务',
  emptyOtherDay: '这一天还没有任务',
  emptyHint: '在上方输入框写点什么，回车即可添加',
  emptyFiltered: '没有符合条件的任务',
  emptyFilteredHint: '换个筛选条件或分类试试',
  overduePrefix: '逾期',
  overdueUnit: '项',
  moveToToday: '移到今天',
  doneGroup: '已完成',
  openGroup: '待办',
  collapse: '收起',
  expand: '展开',
  weekEmpty: '这周还没有安排',
  backToToday: '回到今天',
  emptyPercent: '—',
  emptyDiary: '还没有写过日记。在上面写一段，之后随时能翻回来。',
  searchPlaceholder: '搜索任务和日记…',
  searchHint: '输入关键词，同时搜索任务标题、备注和日记正文',
  emptySearch: '没有找到和',
  emptySearchTail: '相关的内容',

  /* ---------- 复习（F1 · 间隔重复） ---------- */
  /** 视图名（VIEW_META 之外的第二处文案来源：标题 / aria-label） */
  review: '复习',
  /** 今日横幅：`今日待复习 3 张 ›` */
  reviewBannerPrefix: '今日待复习',
  reviewBannerUnit: '张',
  /** 卡片进度的 `第 2 / 10 张` */
  reviewIndexPrefix: '第',
  reviewIndexMiddle: '/',
  reviewIndexSuffix: '张',
  reviewShowAnswer: '显示答案',
  reviewAgain: '忘了',
  reviewHard: '模糊',
  reviewGood: '记住',
  /** 三档按钮下方的一行小字：今天之后多久再见 */
  reviewAgainHint: '明天再来',
  reviewHardHint: '两天后',
  reviewGoodHint: '三天后',
  reviewUnenroll: '这题不再复习',
  reviewEmptyTitle: '今天没有要复习的卡片',
  reviewEmptyHint: '去记事本，给要背的内容点「加入复习」',
  reviewDoneTitle: '这一轮复习完成',
  reviewDoneRated: '本次复习',
  reviewDoneRemembered: '其中记住',
  reviewDoneNext: '下次到期',
  reviewDoneNextNone: '暂无排期',
  reviewBackToday: '回到今日',
  /** 记事本编辑器里的开关 */
  reviewJoin: '加入复习',
  reviewJoined: '已入队',
  reviewScheduled: '已排期',
  reviewDueBadge: '到期',
  reviewJoinHint: '加入后按「忘了 / 模糊 / 记住」自动安排下次复习',
  /** 队列健康度（周报里用，替代"本周复习了几张"这种虚荣指标） */
  reviewHealthTitle: '复习队列',
  reviewHealthCards: '卡片',
  reviewHealthScheduled: '已排期',
  reviewHealthMature: '成熟卡',
  reviewHealthUnit: '张',

  /* ---------- 周报复盘（F3） ---------- */
  weekly: '本周回顾',
  weeklyMarker: '## 本周回顾',
  weeklyNotGenerated: '尚未生成',
  weeklyGenerated: '已生成 · 点开修改',
  weeklyCollapsedHint: '点开填三句话，你的周报就成型了',
  weeklyWrite: '写入本周日记',
  /** 历史周补写时按钮前缀（后面拼目标日期，如「写入 10月18日」）—— 语义必须随档位变，否则"写入本周"写在历史周是错的 */
  weeklyWriteBackfill: '写入',
  weeklyWritten: '已写入本周日记',
  weeklyAnswerHarvest: '最大收获',
  weeklyAnswerProblem: '最大问题',
  weeklyAnswerNext: '下周最重要的一件事',
  weeklyAnswerHarvestPlaceholder: '这周最有用的一个方法 / 一个理解…',
  weeklyAnswerProblemPlaceholder: '哪一步卡住了？是时间不够还是方法不对？',
  weeklyAnswerNextPlaceholder: '只写一件，写完就去做',
  weeklyTruncated: '日记已到 5000 字上限，回顾被截断 —— 先精简前文再写一次',
  /**
   * 自动生成周报（长期迭代）。
   *
   * 措辞刻意避开"每周一"：真实触发是"每周**第一次打开应用**时补上上一周"——
   * 用户周一没开电脑、周二才开，周报也该在。写死"周一生成"会让人以为漏了。
   */
  weeklyAuto: '自动生成',
  weeklyAutoHint: '每周首次打开时，把上一周写进日记（写进去之后可改可删）',
  weeklyFocusThisWeek: '本周专注',
  weeklyFocusLastWeek: '上周专注',
  weeklyDone: '完成任务',
  weeklyRate: '完成率',
  weeklyPeakDay: '最高效的一天',
  weeklyPeakHour: '最高效的时段',
  weeklyByCategory: '时间去向',
  /** 「本周复习 N 张」—— 只在**区间内**评级过的卡片才算（靠 sr.last） */
  weeklyReviewed: '本周复习',
  weeklyReviewedUnit: '张',
  /** 周区间三档切换 */
  weeklyPrevWeek: '上一周',
  weeklyThisWeek: '本周',
  weeklyNextWeek: '下一周',
  /**
   * 可写范围：`weekOffset <= 0`（历史周 + 本周可写）。
   *
   * v0.8.1 起放开历史周（补写以前的周报），**只剩未来周只读** ——
   * 那一周还没发生，写它是编造。三档对应的文案因此拆成三句：
   * - 历史周可写：`weeklyWriteTarget`（把"将写入哪一天"明确说出来）
   * - 本周可写：沿用原有文案
   * - 未来周不可写：`weeklyFutureReadOnly` / `weeklyReadOnly`
   */
  weeklyFutureReadOnly: '未来周不可写入',
  weeklyReadOnly: '未来周只读',
  /** 补写历史周时的目标日提示前缀，后面拼 `formatDateTitle(目标日)` */
  weeklyWriteTarget: '将写入',

  /* ---------- 笔记闹钟（不进复习队列） ---------- */
  remindTitle: '闹钟',
  remindOn: '已开启',
  remindOff: '未开启',
  remindOnce: '仅一次',
  remindDaily: '每天',
  /** 列表项上的小闹钟标记：`07:30 每天` */
  remindAtLabel: '闹钟',
  remindHint: '到点响铃提醒，但不进复习队列',
  remindNotificationSuffix: '的提醒',
  remindDefaultTitle: '笔记提醒',

  /* ---------- 自动备份（F4） ---------- */
  backup: '自动备份',
  backupDesktopOnly: '桌面版每天自动存一份 JSON 到本机文件夹，保留最近 14 份；网页 / 安卓用本机快照兜底。',
  backupOpenDir: '打开备份文件夹',
  backupRefresh: '刷新列表',
  backupNone: '暂无自动备份（启动后会自动生成当天的一份）',
  backupRestore: '恢复',
  backupConfirm: '确认恢复？本机当前数据会被覆盖',
  backupRestored: '已从备份恢复',
  backupInvalid: '这个备份文件无法识别，本机数据未改动',
  backupFailed: '备份失败（不影响使用）',
  backupCounts: '这份备份包含：',
  backupCountTasks: '任务',
  backupCountDiary: '日记',
  backupCountNotes: '记事',
  backupCountFocus: '专注记录',
  backupCountUnit: '条',

  /* ---------- 任务 ↔ 专注（F2） ---------- */
  startFocus: '开始专注',
  focusBusy: '正在专注另一项，先结束它',
  focusContinuing: '继续专注中',
  focusSummaryPrefix: '专注',
  focusSummaryUnit: '次',
  uncategorized: '未分类',
  freeFocus: '自由专注',

  /* ---------- 任务估时 / 今日时间预算（F1） ---------- */
  /** 抽屉与 QuickAdd 的字段名 */
  estimateLabel: '预计用时（分钟）',
  /** QuickAdd 里的占位文案（窄屏只剩这一行） */
  /**
   * 占位文案只能是两个字：这个输入框在 390px 上只有 56px（`w-14`），
   * 写「预计 min」会被裁成「预计 r」—— 半截词比没有更糟，看着像渲染出错。
   * 完整语义放在 `estimateLabel`（aria-label / title）里。
   */
  estimatePlaceholder: '分钟',
  /** 任务行摘要前缀：`预计 30min` */
  estimateSummaryPrefix: '预计',
  /** 估时校准（F10）：有预计也有实际时，把后者的前缀换掉，形成对比 */
  actualSummaryPrefix: '实际',
  /**
   * 任务行摘要里的分钟单位。
   * 用 `min` 而不是「分钟」：一行里要同时塞下「专注 50min · 预计 30min」，
   * 中文单位会把行宽撑爆（窄屏直接换行）。
   */
  estimateMinutesUnit: 'min',
  /** 今日预算行三段的前缀 / 后缀：`预计 … · 已专注 … · 2 项未估时` */
  budgetEstimatedPrefix: '预计',
  budgetFocusedPrefix: '已专注',
  budgetUnestimatedSuffix: '项未估时',

  /* ---------- 目标倒计时（F2） ---------- */
  /** 设置页区块标题 */
  goalsTitle: '目标倒计时',
  goalsHint: '填考试或截止日，最近的那个会显示在今日页顶部；过期后自动隐藏',
  /** 一个目标都没有时的空态 */
  goalsEmpty: '还没有目标。加一个考试或截止日，今日页会显示还有几天。',
  goalNamePlaceholder: '目标名称（如 考研初试）',
  goalDateLabel: '目标日期',
  goalAdd: '添加目标',
  goalDelete: '删除目标',
  /** 横幅第一段：`距 {name} 还有 {N} 天` */
  goalCountdownPrefix: '距',
  goalCountdownMiddle: '还有',
  goalCountdownSuffix: '天',
  /** `days === 0`：`{name} 就是今天` */
  goalTodaySuffix: '就是今天',
  /** 设置页列表里的状态：已过期的目标不再进今日横幅 */
  goalExpired: '已过期',

  /* ---------- 错题笔记模板（F3） ---------- */
  /** 记事本列表头部的显式入口按钮（与「新建」并列） */
  noteMistake: '记错题',
  /** 编辑器里"这条分类不在清单内"时的兜底提示（错题模板会用到） */
  noteCustomCategory: '自定义分类',
} as const;

/* ============================================================================
   Toast 时长
   ========================================================================= */
export const TOAST_TIMEOUT = {
  undo: 5000,
  info: 3200,
  error: 6000,
} as const;

/* ============================================================================
   默认设置
   ========================================================================= */
/** 番茄钟默认时长（分钟） */
export const DEFAULT_FOCUS_MINUTES = 25;
/** 番茄之间的休息时长（分钟） */
export const DEFAULT_BREAK_MINUTES = 5;
/**
 * 墓碑保留天数，超期丢弃。
 * 取舍：留太久 → 一直堆积；太短 → 长时间没同步的设备看不到删除动作、把任务复活。
 * 90 天对日常使用足够安全。
 */
export const TOMBSTONE_KEEP_DAYS = 90;
/**
 * 日界可选范围的上限（小时）。
 * 只放到凌晨 6 点：再往后就变成"上午也算前一天"了，没人需要这种口径。
 */
export const DAY_START_MAX = 6;

export function createDefaultSettings(today: string): Settings {
  return {
    schemaVersion: 1,
    theme: 'system',
    defaultView: 'today',
    weekStart: 1,
    categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
    lastSelectedDate: today,
    lastView: 'today',
    filterMode: 'all',
    filterCategory: null,
    doneCollapsed: true,
    remindEnabled: false,
    strictFocus: false,
    /** 与 Anki 默认一致：一天 20 张新卡 */
    dailyNewCardLimit: 20,
    /** 0 = 不设每日专注目标（不给人凭空派一个"每天 3 小时"的压力） */
    dailyFocusGoalMinutes: 0,
    /** 自动续接默认关：让它默默替你开一段 25 分钟的计时，是一种越权 */
    autoContinue: false,
    sleepLog: [],
    /** 习惯打卡（F12）：默认空数组，空态由今日页表达（整块不渲染） */
    habits: [],
    habitChecks: [],
    /**
     * 习惯 → 今日任务的生成流水（默认空）。
     * 没有习惯开 autoTask 时它一直是空数组，不影响任何既有行为。
     */
    habitTaskLog: [],
    /**
     * 周报自动生成：默认**开**。
     *
     * 写进去的是日记里一个 `## 本周回顾` 区块，幂等替换、可改可删；
     * 而"每周手动点一次"在真实使用里几乎不会发生 —— 默认关等于功能不存在。
     * 不想要的人（或想自己写周报的人）在日记页那个开关上一点就关。
     */
    weeklyAutoReport: true,
    /** 已自动生成过周报的周起始日（只增流水）；空 = 一周都没生成过 */
    weeklyReportLog: [],
    /** 收尾卡从没看过（第一次打开就会回顾前一天） */
    lastRecapSeen: null,
    focusPrunedBefore: null,
    weekPlanTemplate: null,
    // 0 = 午夜翻页；熬夜用户可改成 3~4，避免凌晨 1 点被算成"明天"
    dayStartHour: 0,
    focusMinutes: DEFAULT_FOCUS_MINUTES,
    breakMinutes: DEFAULT_BREAK_MINUTES,
    /**
     * 目标倒计时：默认空数组（不是 undefined）。
     * 空态由 UI 表达（设置页给提示、今日横幅整行不渲染），数据层永远是一个数组 ——
     * 这样云合并 / 备份 / migrate 都不必判空。
     */
    goals: [],
  };
}
