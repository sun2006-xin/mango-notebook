import {
  DAY_START_MAX,
  DEFAULT_BREAK_MINUTES,
  DEFAULT_FOCUS_MINUTES,
  FALLBACK_CATEGORY_NAME,
} from '../../constants';
import { addDays, isValidDateKey, monthOfKey } from '../../lib/date';
import { nextOrderForDate } from '../../lib/drag';
import { FOCUS_GOAL_MAX_MINUTES } from '../../lib/focus';
import { sanitizeGoals } from '../../lib/goal';
import { sameSleepEntry, upsertSleepLog } from '../../lib/sleep';
import { createTask } from '../../lib/task';
import { sanitizeWeeklyReportLog } from '../../lib/weekly';
import { WEEK_PLAN_MAX_PER_DAY, emptyWeekPlan, weekPlanToTasks } from '../../lib/weekPlan';
import type { AppAction } from '../actions';
import { patchSettings, sameGoals } from '../helpers';
import type { AppState, Category, Task } from '../../types';

/* ============================================================================
   设置域：视图/日期/主题/番茄参数/目标/分类/周计划模板/作息

   本文件的 case 一律只动 `settings`（少数会连带 `ui.monthCursor` /
   `ui.stickyDoneIds`，因为"换了日期"在 UI 上是必须联动的一件事）。
   例外：CATEGORY_RENAME / CATEGORY_REMOVE 会改 tasks 上的 category 字段 ——
   分类改名如果不跟改任务，那些任务会立刻变成"不属于任何分类"的孤儿。
   ========================================================================= */

export function reduceSettings(state: AppState, action: AppAction): AppState | null {
  switch (action.type) {
    case 'SET_FILTER':
      return {
        ...state,
        settings: {
          ...state.settings,
          filterMode: action.mode ?? state.settings.filterMode,
          filterCategory:
            action.category === undefined ? state.settings.filterCategory : action.category,
        },
      };

    case 'SET_VIEW':
      return patchSettings(state, { lastView: action.view });

    // §3.4 漏列了这个 action，但 M2-8 的「默认视图（四档）」需要它
    case 'SET_DEFAULT_VIEW':
      return patchSettings(state, { defaultView: action.view });

    case 'SET_SELECTED_DATE':
      return {
        ...state,
        settings: { ...state.settings, lastSelectedDate: action.date },
        ui: { ...state.ui, stickyDoneIds: [], monthCursor: monthOfKey(action.date) },
      };

    case 'SHIFT_DATE':
    case 'SHIFT_WEEK': {
      const step = action.type === 'SHIFT_WEEK' ? action.delta * 7 : action.delta;
      const date = addDays(state.settings.lastSelectedDate, step);
      return {
        ...state,
        settings: { ...state.settings, lastSelectedDate: date },
        ui: { ...state.ui, stickyDoneIds: [], monthCursor: monthOfKey(date) },
      };
    }

    case 'SET_THEME':
      return patchSettings(state, { theme: action.theme });

    case 'SET_WEEK_START':
      return patchSettings(state, { weekStart: action.weekStart });

    case 'TOGGLE_DONE_COLLAPSED':
      return {
        ...state,
        settings: { ...state.settings, doneCollapsed: !state.settings.doneCollapsed },
        ui: { ...state.ui, stickyDoneIds: [] },
      };

    case 'SET_REMIND_ENABLED':
      if (state.settings.remindEnabled === action.value) return state;
      return patchSettings(state, { remindEnabled: action.value });

    case 'SET_STRICT_FOCUS':
      if (state.settings.strictFocus === action.value) return state;
      return patchSettings(state, { strictFocus: action.value });

    case 'SET_AUTO_CONTINUE':
      if (state.settings.autoContinue === action.value) return state;
      return patchSettings(state, { autoContinue: action.value });

    case 'SET_DAILY_NEW_CARD_LIMIT': {
      /**
       * 夹紧到 0–200。设置会经云同步从别的设备过来，
       * 一个 99999 会把整个复习队列一次性倒出来。
       * 幂等：值没变就返回同一个 state，避免无谓写盘 + 云推送。
       */
      const value = Number.isFinite(action.value)
        ? Math.min(200, Math.max(0, Math.trunc(action.value)))
        : state.settings.dailyNewCardLimit;
      if (state.settings.dailyNewCardLimit === value) return state;
      return patchSettings(state, { dailyNewCardLimit: value });
    }

    /**
     * 每日专注目标。夹紧到 0–24 小时；0 = 不设目标。
     * 幂等：值没变就返回同一个 state（settings 会触发写盘 + 云推送）。
     */
    case 'SET_DAILY_FOCUS_GOAL': {
      const minutes = Number.isFinite(action.minutes)
        ? Math.min(FOCUS_GOAL_MAX_MINUTES, Math.max(0, Math.trunc(action.minutes)))
        : state.settings.dailyFocusGoalMinutes;
      if (state.settings.dailyFocusGoalMinutes === minutes) return state;
      return patchSettings(state, { dailyFocusGoalMinutes: minutes });
    }

    /**
     * 三个专注相关的数值设置都在 reducer 里夹紧范围。
     * UI 已经限制了可选项，但设置会经云同步从别的设备过来 ——
     * 一个 dayStartHour=99 会让"今天"直接算到 4 天前，属于灾难级脏数据。
     */
    case 'SET_DAY_START': {
      const hour = Number.isFinite(action.hour)
        ? Math.min(DAY_START_MAX, Math.max(0, Math.trunc(action.hour)))
        : 0;
      if (state.settings.dayStartHour === hour) return state;
      return patchSettings(state, { dayStartHour: hour });
    }

    case 'SET_FOCUS_MINUTES': {
      const minutes = Number.isFinite(action.minutes)
        ? Math.min(180, Math.max(1, Math.trunc(action.minutes)))
        : DEFAULT_FOCUS_MINUTES;
      if (state.settings.focusMinutes === minutes) return state;
      return patchSettings(state, { focusMinutes: minutes });
    }

    case 'SET_BREAK_MINUTES': {
      const minutes = Number.isFinite(action.minutes)
        ? Math.min(60, Math.max(0, Math.trunc(action.minutes)))
        : DEFAULT_BREAK_MINUTES;
      if (state.settings.breakMinutes === minutes) return state;
      return patchSettings(state, { breakMinutes: minutes });
    }

    /**
     * 目标倒计时整表替换（增 / 删 / 改共用一条）。
     * 兜底走 lib/goal 的 sanitizeGoals：非法项丢弃、同 id 去重、按日期升序 ——
     * 与 storage.sanitizeSettings 读到磁盘时用的是**同一个函数**，
     * 所以"界面上刚加的"和"冷启动后读回的"永远是同一种形状。
     */
    case 'SET_GOALS': {
      const goals = sanitizeGoals(action.goals);
      // 内容没变就返回同一个 state：settings 是 persistDeps 的一员，
      // 无谓的新对象会白白触发一次写盘 + 一次云推送
      if (sameGoals(state.settings.goals, goals)) return state;
      return patchSettings(state, { goals });
    }

    case 'CATEGORY_ADD': {
      const name = action.name.trim();
      if (!name) return state;
      const exists = state.settings.categories.some((c) => c.name === name || c.id === action.id);
      if (exists) return state;
      const category: Category = { id: action.id, name };
      return {
        ...state,
        settings: { ...state.settings, categories: [...state.settings.categories, category] },
      };
    }

    case 'CATEGORY_RENAME': {
      const name = action.name.trim();
      if (!name) return state;
      const target = state.settings.categories.find((c) => c.id === action.id);
      if (!target || target.name === name) return state;
      if (state.settings.categories.some((c) => c.id !== action.id && c.name === name)) return state;
      const oldName = target.name;
      return {
        ...state,
        tasks: state.tasks.map((task) =>
          task.category === oldName ? { ...task, category: name } : task,
        ),
        settings: {
          ...state.settings,
          categories: state.settings.categories.map((c) =>
            c.id === action.id ? { ...c, name } : c,
          ),
          filterCategory:
            state.settings.filterCategory === oldName ? name : state.settings.filterCategory,
        },
      };
    }

    case 'CATEGORY_REMOVE': {
      const categories = state.settings.categories;
      const target = categories.find((c) => c.id === action.id);
      if (!target || categories.length <= 1) return state;
      const rest = categories.filter((c) => c.id !== action.id);
      const fallback =
        rest.find((c) => c.name === FALLBACK_CATEGORY_NAME)?.name ??
        (rest[0] as Category).name;
      return {
        ...state,
        tasks: state.tasks.map((task) =>
          task.category === target.name ? { ...task, category: fallback } : task,
        ),
        settings: {
          ...state.settings,
          categories: rest,
          filterCategory:
            state.settings.filterCategory === target.name
              ? fallback
              : state.settings.filterCategory,
        },
      };
    }

    case 'WEEK_PLAN_ADD': {
      const base = state.settings.weekPlanTemplate ?? emptyWeekPlan();
      const day = Math.trunc(action.weekday);
      if (!Number.isInteger(day) || day < 0 || day > 6) return state;
      const items = base.days[day] ?? [];
      if (items.length >= WEEK_PLAN_MAX_PER_DAY) return state;
      const days = base.days.map((list, index) => (index === day ? [...items, action.item] : list));
      return { ...state, settings: { ...state.settings, weekPlanTemplate: { days } } };
    }

    case 'WEEK_PLAN_REMOVE': {
      const base = state.settings.weekPlanTemplate;
      if (!base) return state;
      const day = Math.trunc(action.weekday);
      const items = base.days[day];
      if (!items || action.index < 0 || action.index >= items.length) return state;
      const nextItems = items.filter((_, index) => index !== action.index);
      const days = base.days.map((list, index) => (index === day ? nextItems : list));
      // 删空 = 没有模板（与 sanitize 的口径一致）
      const template = days.every((list) => list.length === 0) ? null : { days };
      return { ...state, settings: { ...state.settings, weekPlanTemplate: template } };
    }

    /**
     * 套用模板（F3）：读模板、写任务。
     *
     * 为什么放在设置域而不是任务域：它读的是 `settings.weekPlanTemplate`，
     * 和 WEEK_PLAN_ADD / WEEK_PLAN_REMOVE 是一组。拆到两个文件里，
     * 改模板格式时要跳着看三处。
     */
    case 'WEEK_PLAN_APPLY': {
      const planned = weekPlanToTasks(
        state.settings.weekPlanTemplate,
        action.days,
        state.tasks,
      );
      if (planned.length === 0) return state;
      const created: Task[] = [];
      for (const input of planned) {
        try {
          // createTask 负责 id / createdAt / 标题校验 / 估时夹紧
          const task = createTask(
            {
              title: input.title,
              date: input.date,
              category: input.category,
              time: input.time,
              estimatedMinutes: input.estimatedMinutes,
            },
            action.now,
            input.date,
          );
          /**
           * 排序位要按"**已经加上这一批**"的现状算：
           * 同一天会一次性落好几条，用 state.tasks 算的话它们会拿到同一个号，
           * 之后谁在前全看 id —— 顺序变成随机的。
           */
          created.push({
            ...task,
            order: nextOrderForDate([...state.tasks, ...created], task.date),
          });
        } catch {
          /* 单条失败（标题空）不该挡住整批 */
        }
      }
      if (created.length === 0) return state;
      return { ...state, tasks: [...state.tasks, ...created] };
    }

    case 'SLEEP_LOG_SET': {
      const existing = state.settings.sleepLog.find((item) => item.date === action.date);
      const next = {
        date: action.date,
        wakeAt: action.wakeAt !== undefined ? action.wakeAt : (existing?.wakeAt ?? null),
        sleepAt: action.sleepAt !== undefined ? action.sleepAt : (existing?.sleepAt ?? null),
      };
      // 幂等：点了两次同一个时间，不写盘也不触发云推送
      if (sameSleepEntry(existing, next)) return state;
      return patchSettings(state, { sleepLog: upsertSleepLog(state.settings.sleepLog, next) });
    }

    /**
     * 周报自动生成开关（长期迭代）。
     * 幂等：checkbox 会为一次点击回调一次，值没变就返回同一个 state。
     */
    case 'SET_WEEKLY_AUTO_REPORT':
      if (state.settings.weeklyAutoReport === action.value) return state;
      return patchSettings(state, { weeklyAutoReport: action.value });

    /**
     * 记下"这一周处理过了"。
     *
     * 收口走 `sanitizeWeeklyReportLog`：它负责格式校验 / 去重 / 升序 / 超量丢最旧，
     * 与冷启动读盘、云同步合并用的是**同一个函数** —— 所以"刚记的"和
     * "重启后读回的"永远是同一种形状。
     *
     * 幂等：已经记过就返回同一个 state（调用方会在每次挂载时探一次，
     * 不幂等的话每开一次应用就多一次写盘 + 云推送）。
     */
    case 'WEEKLY_REPORT_LOG_ADD': {
      /**
       * 幂等判据是"**这一周是否已经在流水里**"，不是"长度有没有变"。
       *
       * 用长度判会有一个只在长期使用后出现的坑：`sanitizeWeeklyReportLog`
       * 满 `WEEKLY_REPORT_LOG_KEEP_MAX`（60 周，约一年）后会丢掉最旧的一条，
       * 于是"加新的"和"丢旧的"同时发生、长度不变 → 判成无变化直接返回原 state。
       * 结果：第 61 周起永远记不进流水，用户删掉那段自动周报后每次启动又会被写回来
       * （每次还附带一次保存 + 一次云推送）。满一年才复发，几乎不可能靠手测发现。
       */
      // 非法日期直接拒绝（不写脏数据，也不产生一次无意义的 patch）
      if (!isValidDateKey(action.startKey)) return state;
      if (state.settings.weeklyReportLog.includes(action.startKey)) return state;
      const log = sanitizeWeeklyReportLog([...state.settings.weeklyReportLog, action.startKey]);
      return patchSettings(state, { weeklyReportLog: log });
    }

    default:
      return null;
  }
}
