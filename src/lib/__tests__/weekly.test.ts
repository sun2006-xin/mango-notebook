import { describe, expect, it } from 'vitest';
import {
  buildWeeklyMarkdown,
  buildWeeklyStats,
  upsertWeeklySection,
  type WeeklyStats,
} from '../weekly';
import { DIARY_MAX, TEXT } from '../../constants';
import type { FocusSession, Note, Task } from '../../types';

/* ============================================================================
   周报复盘（F3）

   最贵的一段是 `upsertWeeklySection` 的**幂等替换**：
   写错一次，用户每周点一次「写入本周日记」，日记里就会堆一份新的周报，
   几周后正文全是重复内容且无法一键清掉。
   所以这里逐条钉住：连写两次长度不翻倍、前后用户内容不动、`### ` 不误终止、
   标题被用户改过之后走追加而不是吞掉别的内容。
   ========================================================================= */

const TODAY = '2026-10-24'; // 周五（weekStart=1 → 本周 10-19 起）

function task(id: string, date: string, done: boolean, category = '学习'): Task {
  return {
    id,
    title: id,
    note: '',
    date,
    time: null,
    repeat: 'none',
    priority: 'medium',
    category,
    done,
    doneAt: done ? `${date}T10:00:00.000Z` : null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    parentId: null,
    estimatedMinutes: 0,
  };
}

function focus(id: string, date: string, startHour: number, minutes: number, taskId: string | null = null): FocusSession {
  const start = `${date}T${String(startHour).padStart(2, '0')}:00:00`;
  const endDate = new Date(Date.parse(start) + minutes * 60_000);
  return {
    id,
    taskId,
    date,
    startedAt: new Date(Date.parse(start)).toISOString(),
    endedAt: endDate.toISOString(),
    durationMs: minutes * 60_000,
  };
}

const card = (id: string, ivl: number): Note => ({
  id,
  title: id,
  content: `${id} 正文`,
  category: '',
  pinned: false,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  sr: { due: '2026-10-20', ivl, reps: 2 },
});

describe('buildWeeklyStats', () => {
  it('空数据不抛，各项为 0 / null', () => {
    const stats = buildWeeklyStats({
      tasks: [],
      focusSessions: [],
      notes: [],
      today: TODAY,
      weekStart: 1,
    });
    expect(stats.startKey).toBe('2026-10-19');
    expect(stats.endKey).toBe('2026-10-25');
    expect(stats.focusMs).toBe(0);
    expect(stats.prevFocusMs).toBe(0);
    expect(stats.focusDeltaPercent).toBeNull();
    expect(stats.doneCount).toBe(0);
    expect(stats.totalCount).toBe(0);
    expect(stats.doneRate).toBeNull();
    expect(stats.peakDay).toBeNull();
    expect(stats.peakHour).toBeNull();
    expect(stats.byCategory).toEqual([]);
    expect(stats.review).toEqual({ total: 0, scheduled: 0, mature: 0 });
    // 脏数据也不抛
    expect(() =>
      buildWeeklyStats({
        tasks: null as unknown as Task[],
        focusSessions: null as unknown as FocusSession[],
        notes: null as unknown as Note[],
        today: TODAY,
        weekStart: 1,
      }),
    ).not.toThrow();
  });

  it('本周 / 上周专注 + 环比 + 完成率', () => {
    const stats = buildWeeklyStats({
      tasks: [task('a', '2026-10-20', true), task('b', '2026-10-21', false), task('c', '2026-10-12', true)],
      focusSessions: [
        focus('f1', '2026-10-20', 9, 60),
        focus('f2', '2026-10-21', 9, 30),
        focus('f3', '2026-10-13', 9, 60), // 上周
      ],
      notes: [],
      today: TODAY,
      weekStart: 1,
    });
    expect(stats.focusMs).toBe(90 * 60_000);
    expect(stats.prevFocusMs).toBe(60 * 60_000);
    expect(stats.focusDeltaPercent).toBe(50);
    // 「按 task.date 归日」：本周只有 a/b 两条，c 落在上周
    expect(stats.totalCount).toBe(2);
    expect(stats.doneCount).toBe(1);
    expect(stats.doneRate).toBe(50);
  });

  it('最高效日 / 时段 / 分类去向 / 复习健康度', () => {
    const stats = buildWeeklyStats({
      tasks: [task('t1', '2026-10-20', false, '学习'), task('t2', '2026-10-21', false, '工作')],
      focusSessions: [
        focus('f1', '2026-10-20', 9, 30, 't1'),
        focus('f2', '2026-10-21', 21, 120, 't2'),
      ],
      notes: [card('n1', 0), card('n2', 8), card('n3', 30)],
      today: TODAY,
      weekStart: 1,
    });
    expect(stats.peakDay).toEqual({ date: '2026-10-21', ms: 120 * 60_000 });
    expect(stats.peakHour?.ms).toBe(120 * 60_000);
    expect(stats.byCategory.map((row) => row.category)).toEqual(['工作', '学习']);
    expect(stats.review).toEqual({ total: 3, scheduled: 2, mature: 2 });
  });
});

describe('buildWeeklyMarkdown', () => {
  const stats: WeeklyStats = buildWeeklyStats({
    tasks: [task('a', '2026-10-20', true)],
    focusSessions: [focus('f1', '2026-10-20', 9, 60)],
    notes: [card('n1', 8)],
    today: TODAY,
    weekStart: 1,
  });

  it('以 `## 本周回顾 · 区间` 开头（marker 必须能按前缀命中）', () => {
    const md = buildWeeklyMarkdown(stats, { harvest: 'A', problem: 'B', next: 'C' }, '2026-10-24T12:30:00.000Z');
    expect(md.startsWith(`${TEXT.weeklyMarker} · ${stats.rangeLabel}`)).toBe(true);
  });

  it('三句话写进 `### ` 小标题下；空白答案落成「—」而不是空段落', () => {
    const md = buildWeeklyMarkdown(stats, { harvest: '坚持了晨读', problem: '  ', next: '' }, '');
    expect(md).toContain(`### ${TEXT.weeklyAnswerHarvest}`);
    expect(md).toContain('坚持了晨读');
    expect(md).toContain(`### ${TEXT.weeklyAnswerProblem}`);
    // 问题 / 下周目标都空 → 两处「—」
    expect(md.split('\n').filter((line) => line === '—')).toHaveLength(2);
  });

  it('队列健康度代替"复习了几张"（成熟卡带百分比）', () => {
    const md = buildWeeklyMarkdown(stats, { harvest: '', problem: '', next: '' }, '');
    expect(md).toContain(TEXT.reviewHealthTitle);
    expect(md).toContain('（100%）');
    expect(md).not.toContain('复习了');
  });
});

describe('upsertWeeklySection：幂等替换', () => {
  const marker = TEXT.weeklyMarker;
  const section = `## 本周回顾 · 10月19日 – 25日\n\n- 专注：1小时\n\n### 最大收获\nA\n\n### 最大问题\nB\n\n### 下周最重要的一件事\nC`;

  it('正文为空 → 直接等于区块', () => {
    const result = upsertWeeklySection('', section, marker);
    expect(result.replaced).toBe(false);
    expect(result.content).toBe(section);
    expect(result.truncated).toBe(false);
  });

  it('连写两次只有一份区块，长度不翻倍', () => {
    const once = upsertWeeklySection('今天写了点东西。', section, marker).content;
    const twice = upsertWeeklySection(once, section, marker).content;
    expect(twice).toBe(once);
    expect(twice.length).toBeLessThan(once.length * 2);
    expect(twice.split(marker)).toHaveLength(2); // marker 只出现一次
  });

  it('区块前后的用户内容都保留', () => {
    const existing = `开头的话\n\n${section}\n\n## 别的区块\n\n保留我\n`;
    const result = upsertWeeklySection(existing, `${section}\n\n- 新增一行`, marker);
    expect(result.replaced).toBe(true);
    expect(result.content.startsWith('开头的话')).toBe(true);
    expect(result.content).toContain('## 别的区块');
    expect(result.content).toContain('保留我');
    expect(result.content).toContain('新增一行');
  });

  it('`### ` 不会误判成区块结束（自己的小标题不会把自己截断）', () => {
    const result = upsertWeeklySection(section, `${section}\n\n- 追加`, marker);
    expect(result.content).toContain('### 最大收获');
    expect(result.content).toContain('### 下周最重要的一件事');
    expect(result.content).toContain('C');
  });

  it('标题被人改过（不再以 marker 开头）→ 追加一份，不吞掉任何原内容', () => {
    const existing = `我的正文\n\n## 本周小结（旧标题）\n\n旧内容`;
    const result = upsertWeeklySection(existing, section, marker);
    expect(result.replaced).toBe(false);
    expect(result.content).toContain('我的正文');
    expect(result.content).toContain('## 本周小结（旧标题）');
    expect(result.content).toContain('旧内容');
    expect(result.content).toContain(marker);
  });

  /**
   * v0.12：超出上限时**放弃写入**（原样返回），不再"写半截"。
   * 写半截会把 marker 切掉 → 下次判定成"还没有周报" → 又追加一份。
   */
  it('超出 DIARY_MAX → 放弃写入，原文不动', () => {
    const huge = 'x'.repeat(DIARY_MAX - 10);
    const result = upsertWeeklySection(huge, section, marker);
    expect(result.truncated).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.content.length).toBe(DIARY_MAX - 10);
  });

  it('脏参数（null / undefined 正文）不抛', () => {
    expect(() => upsertWeeklySection(null as unknown as string, section, marker)).not.toThrow();
    expect(upsertWeeklySection(null as unknown as string, section, marker).content).toBe(section);
  });
});
