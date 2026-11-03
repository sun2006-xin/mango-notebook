import { useEffect } from 'react';
import { TEXT } from '../constants';
import { addDays, getWeekRange, nowIso } from '../lib/date';
import { planWeeklyAutoReport, upsertWeeklySection } from '../lib/weekly';
import { useAppDispatch, useAppState } from '../store/StoreContext';
import type { DateKey } from '../types';

/* ============================================================================
   自动周报（长期迭代「周报自动生成」）

   触发时机：挂载时 + 跨天时。判定的目标是**上一周**，所以一周里第一次打开
   应用就会补上，不用正好卡在周一零点（用户周一没开电脑、周二才开也该有）。

   三道闸，顺序不能换 —— 每一道都便宜得多，用来挡住后面的开销：
   ① `weeklyAutoReport` 关着 → 什么都不做（用户明确说了不要）；
   ② 上一周的 `startKey` 已经在 `weeklyReportLog` 里 → 连统计都不算；
   ③ 交给 `planWeeklyAutoReport` 做真正的判定（空周 / 已经写过）。

   ⚠️ 落库必须走 `upsertWeeklySection`，**不能**直接把生成好的 Markdown
   `DIARY_UPSERT` 覆盖上去：周报落在「那一周最后一天」，而用户可能那天
   也写了日记。整篇替换 = 静默吃掉用户写的东西。
   ========================================================================= */

export function useWeeklyAutoReport(today: DateKey): void {
  const { tasks, settings, diary, focusSessions, notes } = useAppState();
  const dispatch = useAppDispatch();
  const { weeklyAutoReport, weeklyReportLog, weekStart } = settings;

  useEffect(() => {
    if (!weeklyAutoReport) return;

    /**
     * 闸 ②：上一周是否处理过。
     * 只算"上一周"是因为 `planWeeklyAutoReport` 恒用 `weekOffset: -1` ——
     * 两边口径必须一致，否则闸 ② 会拦住闸 ③ 想处理的那一周。
     */
    const { startKey } = getWeekRange(addDays(today, -7), weekStart);
    if (weeklyReportLog.includes(startKey)) return;

    const now = nowIso();
    const plan = planWeeklyAutoReport({
      tasks,
      focusSessions,
      notes,
      diary,
      today,
      weekStart,
      log: weeklyReportLog,
      now,
    });

    if (plan.kind === 'skip') {
      /**
       * `already-written`：用户那边已经有一份（手写的或上一轮生成的），
       * 把它记进流水才算处理完 —— 不记的话每次启动都会重新检查一遍，
       * 而且用户删掉周报之后会被立刻写回去。`empty` 不记（理由见 lib/weekly.ts）。
       */
      if (plan.reason === 'already-written') {
        dispatch({ type: 'WEEKLY_REPORT_LOG_ADD', startKey: plan.startKey });
      }
      return;
    }

    /**
     * 合并而不是覆盖：`plan.content` 只是周报那一段，目标日可能还有用户
     * 自己写的正文。`upsertWeeklySection` 负责把它拼进去（同样靠 marker 幂等）。
     */
    const existing = diary.find((entry) => entry.date === plan.writeDate);
    const merged = upsertWeeklySection(
      existing?.content ?? '',
      plan.content,
      TEXT.weeklyMarker,
    );
    // 空间不足（日记到上限）时 upsert 会原样返回并标 skipped：这次不写，
    // 也**不记流水** —— 用户精简日记之后下次启动还能补上
    if (!merged.skipped) {
      dispatch({ type: 'DIARY_UPSERT', date: plan.writeDate, content: merged.content, now });
      dispatch({ type: 'WEEKLY_REPORT_LOG_ADD', startKey: plan.startKey });
    }
  }, [
    dispatch,
    weeklyAutoReport,
    weeklyReportLog,
    weekStart,
    today,
    tasks,
    focusSessions,
    notes,
    diary,
  ]);
}
