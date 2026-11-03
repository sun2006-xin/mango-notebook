import { describe, expect, it } from 'vitest';
import { planWeeklyAutoReport } from '../weekly';
import { TEXT } from '../../constants';
import type { DiaryEntry, FocusSession, Task } from '../../types';

/* ============================================================================
   自动周报（长期迭代「周报自动生成」）
   ----------------------------------------------------------------------------
   这个函数决定"**要不要**替用户写日记"。它答错的两种方式都很贵：
   - 该写不写 → 功能等于没做；
   - 不该写乱写 → 覆盖用户自己写的东西（所以真正落库还得经 `upsertWeeklySection`，
     本文件只验证它给出的"要不要 / 写哪天 / 写什么"）。
   还有一条隐形的：**只处理上一周**。周报如果去算本周，等于在周三就宣布
   "这周学了 2 小时" —— 那是编造。
   ========================================================================= */

const TODAY = '2026-10-24'; // 周五；weekStart=1 → 本周 10-19 起，上一周 10-12 ~ 10-18
const NOW = '2026-10-24T09:00:00.000Z';

function task(id: string, date: string, done: boolean): Task {
  return {
    id,
    title: id,
    note: '',
    date,
    time: null,
    repeat: 'none',
    priority: 'medium',
    category: '学习',
    done,
    doneAt: done ? `${date}T10:00:00.000Z` : null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    parentId: null,
    estimatedMinutes: 0,
  };
}

function focus(id: string, date: string, minutes: number): FocusSession {
  const start = `${date}T09:00:00`;
  return {
    id,
    taskId: null,
    date,
    startedAt: new Date(Date.parse(start)).toISOString(),
    endedAt: new Date(Date.parse(start) + minutes * 60_000).toISOString(),
    durationMs: minutes * 60_000,
  };
}

function diary(date: string, content: string): DiaryEntry {
  return { date, content, createdAt: `${date}T20:00:00.000Z`, updatedAt: `${date}T20:00:00.000Z` };
}

function plan(overrides: Partial<Parameters<typeof planWeeklyAutoReport>[0]> = {}) {
  return planWeeklyAutoReport({
    tasks: [],
    focusSessions: [],
    notes: [],
    diary: [],
    today: TODAY,
    weekStart: 1,
    log: [],
    now: NOW,
    ...overrides,
  });
}

describe('planWeeklyAutoReport · 什么时候写', () => {
  it('上一周有专注 → 写，落在上一周最后一天', () => {
    const result = plan({ focusSessions: [focus('f1', '2026-10-14', 60)] });
    expect(result.kind).toBe('write');
    if (result.kind !== 'write') return;
    expect(result.startKey).toBe('2026-10-12');
    expect(result.writeDate).toBe('2026-10-18');
    expect(result.content).toContain(TEXT.weeklyMarker);
    expect(result.content).toContain(NOW.slice(0, 10)); // 「生成于」用的是传进来的 now
  });

  /** 三条判据任一非零就算"有内容"：只看专注会把"只勾了任务"的人判成空周 */
  it('上一周只完成了任务、没开计时 → 也要写', () => {
    const result = plan({ tasks: [task('t1', '2026-10-13', true)] });
    expect(result.kind).toBe('write');
  });

  it('上一周三条全零 → 不写（empty 不记流水，以后同步进来数据还能补）', () => {
    const result = plan({ tasks: [task('t1', '2026-10-13', false)] });
    expect(result.kind).toBe('skip');
    if (result.kind !== 'skip') return;
    expect(result.reason).toBe('empty');
  });

  it('本周有大量数据也不写（只结上周，不在周三宣布这周的结果）', () => {
    const result = plan({
      focusSessions: [focus('f1', '2026-10-22', 300), focus('f2', '2026-10-23', 300)],
      tasks: [task('t1', '2026-10-22', true)],
    });
    expect(result.kind).toBe('skip');
    if (result.kind !== 'skip') return;
    expect(result.startKey).toBe('2026-10-12'); // 判定的仍然是上一周
    expect(result.reason).toBe('empty');
  });
});

describe('planWeeklyAutoReport · 什么时候不写（防重复）', () => {
  it('这一周已经处理过 → logged', () => {
    const result = plan({
      focusSessions: [focus('f1', '2026-10-14', 60)],
      log: ['2026-10-12'],
    });
    expect(result.kind).toBe('skip');
    if (result.kind !== 'skip') return;
    expect(result.reason).toBe('logged');
  });

  /** 目标日已经有周报区块（手写的或上一轮生成的）→ 不覆盖，但要告诉调用方去记流水 */
  it('目标日已经有周报 → already-written（调用方据此记流水，免得反复检查）', () => {
    const result = plan({
      focusSessions: [focus('f1', '2026-10-14', 60)],
      diary: [diary('2026-10-18', `${TEXT.weeklyMarker} · 10月12日–10月18日\n\n手写的` )],
    });
    expect(result.kind).toBe('skip');
    if (result.kind !== 'skip') return;
    expect(result.reason).toBe('already-written');
    expect(result.startKey).toBe('2026-10-12');
  });

  /**
   * 目标日有**别的**日记（不含周报标记）→ 仍然要写。
   * 这条保证"用户那天写了点东西"不会把周报挤掉 —— 真正合并时由
   * `upsertWeeklySection` 拼进去，不会覆盖正文。
   */
  it('目标日有别的日记但没有周报 → 仍然写', () => {
    const result = plan({
      focusSessions: [focus('f1', '2026-10-14', 60)],
      diary: [diary('2026-10-18', '今天和同学聊了很久')],
    });
    expect(result.kind).toBe('write');
  });

  it('日志里是别的周 → 不影响这一周', () => {
    const result = plan({
      focusSessions: [focus('f1', '2026-10-14', 60)],
      log: ['2026-10-05', '2026-09-28'],
    });
    expect(result.kind).toBe('write');
  });
});

describe('planWeeklyAutoReport · 周起始日跟着设置走', () => {
  it('weekStart=0（周日为一周开始）→ 上周区间整体平移一天', () => {
    const result = plan({
      focusSessions: [focus('f1', '2026-10-14', 60)],
      weekStart: 0,
    });
    expect(result.kind).toBe('write');
    if (result.kind !== 'write') return;
    // 周日开始：本周 10-18 起，上一周 10-11 ~ 10-17
    expect(result.startKey).toBe('2026-10-11');
    expect(result.writeDate).toBe('2026-10-17');
  });
});

describe('planWeeklyAutoReport · 纯函数', () => {
  it('同一输入两次结果一致（不读时钟、不写状态）', () => {
    const args = {
      tasks: [task('t1', '2026-10-13', true)],
      focusSessions: [focus('f1', '2026-10-14', 60)],
    };
    const first = plan(args);
    const second = plan(args);
    expect(second).toEqual(first);
  });
});
