import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, createDefaultSettings } from '../../constants';
import { migrate, sanitizeSettings } from '../storage';
import { mergeSnapshots } from '../cloudSync';
import type { PersistedPayload, Settings } from '../../types';

/* ============================================================================
   settings 的**全字段通路审查**

   为什么要这条：settings 有 18 个字段、穿四道管道（sanitize / 存盘 / 云合并 /
   导入导出），而 `sanitizeSettings` 是**逐字段重建**（不是 `...rec` 展开）——
   新增字段忘了补那一行，编译不报错，只在"我的设置每次启动都变回去"时暴露。

   这条用例不逐个列举字段名（列了就会漏），而是给一份**全字段非默认值**的
   settings 走一遍管道，整体断言相等。以后加字段如果漏了任何一处，它立刻红。
   ========================================================================= */

const FULL: Settings = {
  ...createDefaultSettings('2026-10-29'),
  schemaVersion: 1,
  theme: 'dark',
  defaultView: 'week',
  weekStart: 0,
  categories: [{ id: 'c_learn', name: '学习' }],
  lastSelectedDate: '2026-10-28',
  lastView: 'notes',
  filterMode: 'open',
  filterCategory: '学习',
  doneCollapsed: false,
  remindEnabled: true,
  strictFocus: true,
  dailyNewCardLimit: 35,
  dailyFocusGoalMinutes: 180,
  autoContinue: true,
  dayStartHour: 4,
  focusMinutes: 50,
  breakMinutes: 10,
  goals: [{ id: 'g1', name: '转本', date: '2027-03-15' }],
  sleepLog: [{ date: '2026-10-29', wakeAt: '11:05', sleepAt: '02:10' }],
  /* 习惯打卡（F12）：配置 + 流水两个字段都要给非默认值，
     否则漏掉任何一处这条测试仍然是绿的（等于没守住） */
  habits: [
    { id: 'h1', name: '背单词', createdAt: '2026-10-01T00:00:00.000Z', archivedAt: null },
    { id: 'h2', name: '跑步', createdAt: '2026-10-01T00:00:00.000Z', archivedAt: '2026-10-20T00:00:00.000Z' },
  ],
  habitChecks: [
    { habitId: 'h1', date: '2026-10-28' },
    { habitId: 'h1', date: '2026-10-29' },
  ],
  lastRecapSeen: '2026-10-29',
  focusPrunedBefore: '2026-01-01',
  weekPlanTemplate: {
    days: [
      [],
      [{ title: '高数第三章', category: '学习', time: '09:00', estimatedMinutes: 30 }],
      [],
      [],
      [],
      [],
      [],
    ],
  },
};

describe('sanitizeSettings：全字段必须原样存活', () => {
  it('一份"每个字段都不是默认值"的 settings 走一遍清洗，整体不变', () => {
    expect(sanitizeSettings(FULL)).toEqual(FULL);
  });

  it('老载荷（只有最基础字段）不会凭空造出新字段的值', () => {
    const legacy = sanitizeSettings({ theme: 'light' });
    expect(legacy.strictFocus).toBe(false);
    expect(legacy.dailyNewCardLimit).toBe(20);
    expect(legacy.sleepLog).toEqual([]);
    expect(legacy.focusPrunedBefore).toBeNull();
    expect(legacy.weekPlanTemplate).toBeNull();
  });
});

describe('migrate：整包往返不丢字段', () => {
  it('JSON 往返 + migrate 之后 settings 与原文一致', () => {
    const payload: PersistedPayload = {
      schemaVersion: SCHEMA_VERSION,
      savedAt: '2026-10-29T10:00:00.000Z',
      tasks: [],
      settings: FULL,
      diary: [],
      tombstones: [],
      focusSessions: [],
      notes: [],
    };
    const roundTripped = migrate(JSON.parse(JSON.stringify(payload)));
    expect(roundTripped?.settings).toEqual(FULL);
  });
});

describe('mergeSnapshots：云合并不丢字段', () => {
  it('本机更新时，settings 的每个字段都还在', () => {
    const local: PersistedPayload = {
      schemaVersion: SCHEMA_VERSION,
      savedAt: '2026-10-29T10:00:00.000Z',
      tasks: [{ id: 't1', title: 'x', note: '', date: '2026-10-29', time: null, repeat: 'none', priority: 'medium', category: '学习', done: false, doneAt: null, createdAt: '2026-10-29T00:00:00.000Z', updatedAt: '2026-10-29T00:00:00.000Z', parentId: null }] as PersistedPayload['tasks'],
      settings: FULL,
      diary: [],
      tombstones: [],
      focusSessions: [],
      notes: [],
    };
    const remote: PersistedPayload = { ...local, savedAt: '2026-10-29T09:00:00.000Z' };

    const merged = mergeSnapshots(local, remote);

    // 设备级三个 + 我们新加的那些，一个都不能丢
    expect(merged.settings).toMatchObject({
      theme: 'dark',
      lastView: 'notes',
      remindEnabled: true,
      strictFocus: true,
      dailyNewCardLimit: 35,
      dailyFocusGoalMinutes: 180,
      autoContinue: true,
      dayStartHour: 4,
      sleepLog: FULL.sleepLog,
      habits: FULL.habits,
      habitChecks: FULL.habitChecks,
      lastRecapSeen: '2026-10-29',
      focusPrunedBefore: '2026-01-01',
      weekPlanTemplate: FULL.weekPlanTemplate,
    });
  });
});

/* ============================================================================
   两处视图层逻辑（源码契约）
   ========================================================================= */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '');
}

describe('视图层逻辑守护', () => {
  it('作息打卡写的是 today，不是当前选中日（翻到前天点一下不会污染历史）', () => {
    const src = stripComments(readFileSync(new URL('../../views/TodayView.tsx', import.meta.url), 'utf8'));
    expect(src).toContain("type: 'SLEEP_LOG_SET', date: today");
    expect(src).toContain("settings.sleepLog.find((item) => item.date === today)");
  });

  it('套用周模板只填今天及以后（不会把任务填进已经过完的日子）', () => {
    const src = stripComments(readFileSync(new URL('../../views/WeekView.tsx', import.meta.url), 'utf8'));
    expect(src).toContain('days.filter((day) => day >= today)');
    expect(src).toContain("type: 'WEEK_PLAN_APPLY', days: planDays");
  });
});
