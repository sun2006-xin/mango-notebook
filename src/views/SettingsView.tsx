import { useCallback, useMemo } from 'react';
import { WeekPlanEditor } from '../components/settings/WeekPlanEditor';
import { HabitsEditor } from '../components/settings/HabitsEditor';
import { SettingRow } from '../components/settings/SettingRow';
import { SettingsGroup } from '../components/settings/SettingsGroup';
import { CategoriesEditor } from '../components/settings/CategoriesEditor';
import { GoalsEditor } from '../components/settings/GoalsEditor';
import { CloudSection } from '../components/settings/CloudSection';
import { DataSection } from '../components/settings/DataSection';
import { HabitCalendar } from '../components/settings/HabitCalendar';
import { MonthlyReportCard } from '../components/settings/MonthlyReportCard';
import { UpdateSection } from '../components/settings/UpdateSection';
import { Segmented } from '../components/common/Segmented';
import { TrendChart } from '../components/common/TrendChart';
import { TEXT, TOAST_TIMEOUT } from '../constants';
import { useToast } from '../hooks/useToast';
import { formatDateTitle, nowIso } from '../lib/date';
import { requestNotificationPermission } from '../hooks/useReminders';
import { buildCompletionTrend, getDayProgress } from '../lib/task';
import { useAppDispatch, useAppState } from '../store/StoreContext';
import { useCloudAccount } from '../hooks/useCloudAccount';
import type { DateKey } from '../types';

export interface SettingsViewProps {
  /** 当前真实今天 */
  today: DateKey;
}

const THEME_OPTIONS = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
] as const;

const WEEK_START_OPTIONS = [
  { value: '1', label: '周一' },
  { value: '0', label: '周日' },
] as const;

const DEFAULT_VIEW_OPTIONS = [
  { value: 'today', label: '今日' },
  { value: 'week', label: '周' },
  { value: 'calendar', label: '日历' },
  { value: 'focus', label: '专注' },
  { value: 'diary', label: '日记' },
  { value: 'settings', label: '设置' },
] as const;

/** 日界可选项：0 点（默认）+ 凌晨 1–6 点 */
const DAY_START_OPTIONS = ['0', '1', '2', '3', '4', '5', '6'].map((hour) => ({
  value: hour,
  label: hour === '0' ? '0 点' : `${hour} 点`,
}));

const FOCUS_MINUTES_OPTIONS = ['15', '25', '30', '45', '50'].map((minutes) => ({
  value: minutes,
  label: `${minutes} 分`,
}));

/** 新卡上限选项：Anki 默认 20；0 = 不限制 */
const NEW_CARD_LIMIT_OPTIONS = ['0', '10', '20', '30', '50'].map((value) => ({
  value,
  label: value === '0' ? '不限' : `${value} 张`,
}));

const BREAK_MINUTES_OPTIONS = ['0', '5', '10', '15'].map((minutes) => ({
  value: minutes,
  label: minutes === '0' ? '不休息' : `${minutes} 分`,
}));

/**
 * 每日专注目标的档位。
 *
 * 为什么用档位而不是自由数字：备考的人对"今天要学几小时"没有稳定答案，
 * 给一个数字输入框等于逼人先做一道估算题。60 / 120 / 180 / 240 是四档
 * 常见的节奏（一小时 / 两小时 / 三小时 / 四小时），选一个就行。
 */
const FOCUS_GOAL_OPTIONS = ['0', '60', '120', '180', '240'].map((minutes) => ({
  value: minutes,
  label: minutes === '0' ? '不设' : `${Number(minutes) / 60} 小时`,
}));

/**
 * 设置视图（M2-8）：统计三卡 + 外观 / 每周起始日 / 默认视图 / 分类增删改 / 数据。
 * 分类重命名会**级联**重写所有任务的 category（reducer 里做），删除回落「其他」。
 * 清空数据是两段式确认（第二次点击才真正执行，3 秒后自动收回）。
 */
export function SettingsView({ today }: SettingsViewProps) {
  const state = useAppState();
  const { tasks, settings, focusSessions } = state;
  const dispatch = useAppDispatch();
  const toast = useToast();

  /* ---------- 云同步：可用性 / 登录态 / 同步状态（见 hooks/useCloudAccount） ----------
     整份交 `CloudSection`，这里只取页脚要用的两项 —— 注意**必须是同一个实例**：
     登出时组件里 setAccount(null)，页脚要立刻跟着变。 */
  const cloud = useCloudAccount();
  const { cloudAvailable, account } = cloud;

  const todayProgress = useMemo(() => getDayProgress(tasks, today), [tasks, today]);
  const trend = useMemo(() => buildCompletionTrend(tasks, today, 14), [tasks, today]);
  const weekRate = useMemo(() => {
    let done = 0;
    let total = 0;
    for (let i = 0; i < 7; i += 1) {
      const d = new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)));
      d.setDate(d.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const p = getDayProgress(tasks, key);
      done += p.done;
      total += p.total;
    }
    return total === 0 ? null : Math.round((done / total) * 100);
  }, [tasks, today]);


  /* 存储占用 / 数据备份 / 导出导入 / 归档清理 → components/settings/DataSection.tsx */

  /**
   * 到期提醒开关：**开启时**才去要通知权限（而不是一进设置页就要）。
   * 用户拒绝 → 开关保持关闭，并说清原因；不能默默开着不弹，那更让人困惑。
   */
  const onRemindToggle = useCallback(async () => {
    const next = !settings.remindEnabled;
    if (next && !(await requestNotificationPermission())) {
      toast.show('未能开启提醒：系统通知权限未授予', null, TOAST_TIMEOUT.info, 'warn');
      return;
    }
    dispatch({ type: 'SET_REMIND_ENABLED', value: next });
    toast.show(next ? '到期提醒已开启' : '到期提醒已关闭', null, TOAST_TIMEOUT.info);
  }, [dispatch, settings.remindEnabled, toast]);

  return (
    <section aria-labelledby="settingsTitle" className="flex flex-col">
      <h1 id="settingsTitle" className="text-h1 font-bold leading-h1 tracking-[-0.02em] sm:text-date sm:leading-date">
        统计 · 设置
      </h1>

      {/*
        三个数做成**一行三格**。
        原来是三张 104px 高的卡片竖向堆叠（手机上 `grid-cols-1`），光这三张就
        占掉近半屏 —— 而它们加起来只有三个数字，是"一眼扫完就该翻页"的东西。
        一行之后 60px 都不到，省下的高度全给了下面的设置本身。

        标签用短名（今日 / 近 7 日 / 全部）而不是原句：95px 宽的格子里放不下
        "近 7 日完成率"，硬塞就会换行、把三格撑成三行。完整说法放 title。
      */}
      <div className="mt-4 grid grid-cols-3 gap-2">
        <div className="card px-3 py-2.5" title="今日完成 / 今日安排">
          <div className="truncate text-label font-semibold tracking-[0.04em] text-ink-2">今日</div>
          <div className="tnum mt-1 font-num text-h2 font-bold leading-none tracking-[-0.02em]">
            {todayProgress.done}/{todayProgress.total}
          </div>
        </div>
        <div className="card px-3 py-2.5" title="近 7 日完成率">
          <div className="truncate text-label font-semibold tracking-[0.04em] text-ink-2">近 7 日</div>
          <div className="tnum mt-1 font-num text-h2 font-bold leading-none tracking-[-0.02em]">
            {weekRate === null ? TEXT.emptyPercent : `${weekRate}%`}
          </div>
        </div>
        <div className="card px-3 py-2.5" title="任务总数">
          <div className="truncate text-label font-semibold tracking-[0.04em] text-ink-2">全部</div>
          <div className="tnum mt-1 font-num text-h2 font-bold leading-none tracking-[-0.02em]">
            {tasks.length}
          </div>
        </div>
      </div>

      <div className="mt-5 border-t border-line">
        <SettingsGroup
          title="外观与显示"
          summary="主题 · 每周起始 · 默认视图 · 一天的起点"
          defaultOpen
          testId="settings-group-appearance"
        >
        <SettingRow
          label="外观"
          hint="深色模式夜间更省眼，默认跟随系统"
        >
          <Segmented
            ariaLabel="外观"
            value={settings.theme}
            options={THEME_OPTIONS}
            onChange={(value) => dispatch({ type: 'SET_THEME', theme: value })}
          />
        </SettingRow>

        <SettingRow
          label="每周起始日"
          hint="影响月历列头、周视图起止日"
        >
          <Segmented
            ariaLabel="每周起始日"
            value={String(settings.weekStart)}
            options={WEEK_START_OPTIONS}
            onChange={(value) => dispatch({ type: 'SET_WEEK_START', weekStart: value === '0' ? 0 : 1 })}
          />
        </SettingRow>

        <SettingRow
          label="默认视图"
          hint="冷启动时优先落在这个视图"
        >
          <Segmented
            ariaLabel="默认视图"
            value={settings.defaultView}
            options={DEFAULT_VIEW_OPTIONS}
            onChange={(value) => {
              dispatch({ type: 'SET_DEFAULT_VIEW', view: value });
              toast.show(`默认视图已设为「${DEFAULT_VIEW_OPTIONS.find((o) => o.value === value)?.label ?? value}」`, null, TOAST_TIMEOUT.info);
            }}
          />
        </SettingRow>

        </SettingsGroup>

        <SettingsGroup
          title="提醒与专注"
          summary="到期提醒 · 番茄时长 · 严格模式 · 新卡上限 · 每日目标"
          testId="settings-group-focus"
        >
        <SettingRow
          label="到期提醒"
          hint={<>
            任务到点后发系统通知（应用需保持打开；网页版需允许通知权限）
          </>}
        >
          <button
            type="button"
            data-testid="remind-toggle"
            aria-pressed={settings.remindEnabled}
            onClick={() => void onRemindToggle()}
            className={`btn shrink-0 ${settings.remindEnabled ? 'btn-primary' : 'btn-outlined'}`}
          >
            {settings.remindEnabled ? '已开启' : '已关闭'}
          </button>
        </SettingRow>

        <SettingRow
          label="一天的起点"
          hint={<>
            熬夜党的刚需：设成 4 点，凌晨 3 点做的事仍算前一天
          </>}
        >
          <Segmented
            ariaLabel="一天的起点"
            value={String(settings.dayStartHour)}
            options={DAY_START_OPTIONS}
            onChange={(value) => {
              dispatch({ type: 'SET_DAY_START', hour: Number(value) });
              toast.show(
                value === '0' ? '已改为午夜翻页' : `已改为凌晨 ${value} 点翻页`,
                null,
                TOAST_TIMEOUT.info,
              );
            }}
          />
        </SettingRow>

        <SettingRow
          label="专注时长"
          hint={<>
            番茄钟一段多长；太短容易被打断，太长容易放弃
          </>}
        >
          <Segmented
            ariaLabel="专注时长"
            value={String(settings.focusMinutes)}
            options={FOCUS_MINUTES_OPTIONS}
            onChange={(value) => dispatch({ type: 'SET_FOCUS_MINUTES', minutes: Number(value) })}
          />
        </SettingRow>

        <SettingRow
          label="休息时长"
          hint="每段专注结束后自动进入的休息时间"
        >
          <Segmented
            ariaLabel="休息时长"
            value={String(settings.breakMinutes)}
            options={BREAK_MINUTES_OPTIONS}
            onChange={(value) => dispatch({ type: 'SET_BREAK_MINUTES', minutes: Number(value) })}
          />
        </SettingRow>

        {/* 严格模式（F6）：番茄ToDo 的做法 —— 给一个开关，不做常驻锁机 */}
        <SettingRow
          label="番茄严格模式"
          hint={<>
            专注期间离开本应用超过 5 秒就算中断，这段不计入统计（切到应用内其它页面不算）
          </>}
        >
          <button
            type="button"
            data-testid="strict-focus-toggle"
            aria-pressed={settings.strictFocus}
            onClick={() => dispatch({ type: 'SET_STRICT_FOCUS', value: !settings.strictFocus })}
            className={`btn shrink-0 ${settings.strictFocus ? 'btn-primary' : 'btn-outlined'}`}
          >
            {settings.strictFocus ? '已开启' : '已关闭'}
          </button>
        </SettingRow>

        {/* 番茄自动续接（F16）：一整条链路不用手点 —— 但必须把代价说清楚 */}
        <SettingRow
          label="番茄自动续接"
          hint={<>
            专注结束自动开始休息，休息结束自动开始下一段。
            <br />
            人离开（切标签页 / 锁屏）时会自动停下，不会替你记下没在学的时长。
          </>}
        >
          <button
            type="button"
            data-testid="auto-continue-toggle"
            aria-pressed={settings.autoContinue}
            onClick={() => dispatch({ type: 'SET_AUTO_CONTINUE', value: !settings.autoContinue })}
            className={`btn shrink-0 ${settings.autoContinue ? 'btn-primary' : 'btn-outlined'}`}
          >
            {settings.autoContinue ? '已开启' : '已关闭'}
          </button>
        </SettingRow>

        {/* 每日新卡上限（F9）：Anki 的经验 —— 考前积压不是复习不完，是新卡把队列撑爆 */}
        <SettingRow
          label="每日新卡上限"
          hint={<>
            每天最多放多少张新卡进复习队列；已有的到期卡不受影响（0 = 不限制）
          </>}
        >
          <Segmented
            ariaLabel="每日新卡上限"
            value={String(settings.dailyNewCardLimit)}
            options={NEW_CARD_LIMIT_OPTIONS}
            onChange={(value) => dispatch({ type: 'SET_DAILY_NEW_CARD_LIMIT', value: Number(value) })}
          />
        </SettingRow>

        {/* 每日专注目标（F11）：番茄钟管"这一段"，目标管"今天总共" */}
        <SettingRow
          label="每日专注目标"
          hint={<>
            在「专注」页显示今天的目标进度；超额会照实显示（不封顶成 100%）
          </>}
        >
          <Segmented
            ariaLabel="每日专注目标"
            value={String(settings.dailyFocusGoalMinutes)}
            options={FOCUS_GOAL_OPTIONS}
            onChange={(value) => dispatch({ type: 'SET_DAILY_FOCUS_GOAL', minutes: Number(value) })}
          />
        </SettingRow>

        </SettingsGroup>

        <SettingsGroup
          title="习惯与周计划"
          summary="打卡项 · 打卡日历 · 每周模板"
          testId="settings-group-habits"
        >
        {/* 习惯打卡（F12）：配置在这一域，打卡入口在今日页 */}
        <div className="border-b border-line py-4">
          <HabitsEditor
            habits={settings.habits}
            onChange={(habits) => dispatch({ type: 'SET_HABITS', habits })}
            now={nowIso}
          />
          {/* 打卡日历（F15-B）：连续天数只记得住最近，日历才看得见漏在哪天 */}
          <HabitCalendar
            habits={settings.habits}
            habitChecks={settings.habitChecks}
            weekStart={settings.weekStart}
            today={today}
          />
        </div>

        {/* 周计划模板（F3）：周日 5 分钟排完下周骨架 */}
        <div className="border-b border-line py-4">
          <WeekPlanEditor
            template={settings.weekPlanTemplate}
            categories={settings.categories}
            onAdd={(weekday, item) => dispatch({ type: 'WEEK_PLAN_ADD', weekday, item })}
            onRemove={(weekday, index) => dispatch({ type: 'WEEK_PLAN_REMOVE', weekday, index })}
          />
        </div>

        </SettingsGroup>

        <SettingsGroup
          title="统计"
          summary="近 14 天趋势 · 月报"
          testId="settings-group-stats"
        >
        <div className="border-b border-line py-4">
          <div className="text-body font-semibold">完成率趋势</div>
          <div className="mt-1 text-label text-ink-2">最近 14 天 · 没安排任务的日子画成细线（不是 0%）</div>
          <div className="mt-3">
            <TrendChart points={trend} />
          </div>
        </div>

        {/* 月报（F14）：14 天趋势看节奏，一个月看结论 */}
        <div className="border-b border-line py-4">
          <MonthlyReportCard tasks={tasks} focusSessions={focusSessions} today={today} />
        </div>

        </SettingsGroup>

        <SettingsGroup
          title="分类与目标"
          summary="分类增删改 · 考试/项目倒计时"
          testId="settings-group-meta"
        >
        <CategoriesEditor />

        <GoalsEditor today={today} />

        </SettingsGroup>

        <SettingsGroup
          title="云同步"
          summary="登录 · 立即同步 · 历史版本 · 清空云端"
          testId="settings-group-cloud"
        >
        <CloudSection cloud={cloud} />

        </SettingsGroup>

        {/*
          「数据」默认展开：来设置页的人十有八九是为了导出备份 / 换机恢复 ——
          藏起来等于让人多点一次才找得到最常用的功能。
        */}
        <SettingsGroup
          title="数据"
          summary="导出 · 导入 · 回收站 · 归档 · 清空"
          defaultOpen
          testId="settings-group-data"
        >
        {/* 数据：备份 / 导入导出 / 回收站 / 归档 / 清空（见 DataSection） */}
        <DataSection today={today} />
        </SettingsGroup>

        <UpdateSection />
      </div>

      <p className="mt-6 text-label leading-relaxed text-ink-2">
        当前选中日：{formatDateTitle(settings.lastSelectedDate)} ·{' '}
        {!cloudAvailable || account === null
          ? '全部数据只保存在这台设备上，不登录则无任何网络请求。'
          : '数据保存在本机，登录后额外同步一份到云端。'}
      </p>

    </section>
  );
}
