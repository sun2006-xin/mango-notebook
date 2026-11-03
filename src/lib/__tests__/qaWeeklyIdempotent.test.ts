import { describe, expect, it } from 'vitest';
import { buildWeeklyMarkdown, buildWeeklyStats, upsertWeeklySection } from '../weekly';
import { renderMarkdown } from '../markdown';
import { DIARY_MAX, TEXT } from '../../constants';
import type { FocusSession, Task } from '../../types';

/* ============================================================================
   QA 独立验证（v0.8 · F3）：周报的幂等与口径

   最贵的两个失败模式：
   ① 幂等破了 → 用户每点一次「写入本周日记」，日记里就多一份周报（很快堆满 5000 字）；
   ② 替换范围算错 → 把用户写在周报前后的正文吃掉。
   这两条都用"连写多次 + 保留性"直接钉住，不依赖注释。
   ========================================================================= */

const TODAY = '2026-10-24';

function session(
  id: string,
  date: string,
  startHour: number,
  minutes: number,
  taskId: string | null = null,
): FocusSession {
  const pad = (n: number) => String(n).padStart(2, '0');
  const start = `${date}T${pad(startHour)}:00:00`;
  const endHour = startHour + Math.floor(minutes / 60);
  const end = `${date}T${pad(endHour)}:${pad(minutes % 60)}:00`;
  return { id, taskId, date, startedAt: start, endedAt: end, durationMs: minutes * 60000 };
}

const task = (id: string, date: string, done: boolean, category = '学习'): Task => ({
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
  createdAt: `${date}T08:00:00.000Z`,
  updatedAt: `${date}T08:00:00.000Z`,
  parentId: null,
  estimatedMinutes: 0,
});

const stats = (over: Partial<Parameters<typeof buildWeeklyStats>[0]> = {}) =>
  buildWeeklyStats({
    tasks: [],
    focusSessions: [],
    notes: [],
    today: TODAY,
    weekStart: 1,
    ...over,
  });

const section = buildWeeklyMarkdown(
  stats({ focusSessions: [session('s1', '2026-10-21', 9, 90)] }),
  { harvest: '把 SRS 的阶梯想清楚了', problem: '', next: '刷三套真题' },
  '2026-10-24T22:00:00.000Z',
);

describe('upsertWeeklySection：幂等', () => {
  it('连写 5 次：内容逐字相同、长度不变、marker 只有一处', () => {
    const base = '今天把 I2C 时序调通了。\n\n## 其他小节\n- 保留这一行';
    const first = upsertWeeklySection(base, section, TEXT.weeklyMarker);
    let latest = first.content;
    for (let i = 0; i < 4; i += 1) {
      const again = upsertWeeklySection(latest, section, TEXT.weeklyMarker);
      expect(again.content).toBe(first.content);
      expect(again.replaced).toBe(true);
      expect(again.truncated).toBe(false);
      latest = again.content;
    }
    expect(latest.split(TEXT.weeklyMarker)).toHaveLength(2); // 只出现一次
    expect(latest.length).toBe(first.content.length);
  });

  it('区块前的用户正文与区块后的 `## 其他小节` 都完整保留', () => {
    const base = '第一段：今天学了单调栈。\n第二段：还差两道题。\n\n## 其他小节\n- 明天的安排';
    const result = upsertWeeklySection(base, section, TEXT.weeklyMarker);
    expect(result.content.startsWith('第一段：今天学了单调栈。\n第二段：还差两道题。')).toBe(true);
    expect(result.content).toContain('## 其他小节\n- 明天的安排');
    // 用户正文只出现一次（没有被复制成两份）
    expect(result.content.split('第一段：今天学了单调栈。')).toHaveLength(2);
  });

  it('`### ` 小标题不会把自己截断（区块内的三句话都在）', () => {
    const result = upsertWeeklySection('', section, TEXT.weeklyMarker);
    for (const title of [
      TEXT.weeklyAnswerHarvest,
      TEXT.weeklyAnswerProblem,
      TEXT.weeklyAnswerNext,
    ]) {
      expect(result.content).toContain(`### ${title}`);
    }
    expect(result.content).toContain('刷三套真题');
  });

  it('标题被用户改过（不再以 marker 开头）→ 追加一份，原文一个字都不丢，replaced=false', () => {
    const renamed = '## 我的周报（改过标题）\n\n旧的三句话';
    const result = upsertWeeklySection(renamed, section, TEXT.weeklyMarker);
    expect(result.replaced).toBe(false);
    expect(result.content).toContain(renamed);
    expect(result.content).toContain(section);
    expect(result.truncated).toBe(false);
  });

  /**
   * v0.12 修正：超过 DIARY_MAX 时**放弃写入**，不再"写半截"。
   *
   * 旧行为是照写再 slice 截断 —— 而周报区块在尾巴上，marker 会被切掉，
   * 下一次判定成"还没有周报"又追加一份，同一篇日记里攒出好几份半截周报。
   * 现在：原文一个字都不动，只把 truncated 置真让 UI 提示"先精简前文"。
   */
  it('超过 DIARY_MAX → 放弃写入（原样返回，不写半截）', () => {
    const longEnough = 'x'.repeat(DIARY_MAX - 10);
    const result = upsertWeeklySection(longEnough, section, TEXT.weeklyMarker);
    expect(result.truncated).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.content).toHaveLength(DIARY_MAX - 10);
    expect(result.content).not.toContain(TEXT.weeklyMarker);
  });

  it('空正文 → 内容就是区块本身（replaced=false）', () => {
    const result = upsertWeeklySection('', section, TEXT.weeklyMarker);
    expect(result.replaced).toBe(false);
    expect(result.content).toBe(section);
  });

  it('脏入参（null / undefined）不抛', () => {
    expect(() =>
      upsertWeeklySection(null as unknown as string, section, TEXT.weeklyMarker),
    ).not.toThrow();
    expect(() =>
      upsertWeeklySection(undefined as unknown as string, section, TEXT.weeklyMarker),
    ).not.toThrow();
  });
});

describe('替换后的正文仍然是合法 Markdown（区块前后不粘连成一段）', () => {
  it('`## 其他小节` 仍被渲染成二级标题，用户正文仍是独立段落', () => {
    const base = '第一段：今天学了单调栈。\n\n## 本周回顾 · 10月19日 – 25日\n\n旧周报\n\n## 其他小节\n- 明天的安排';
    const { content } = upsertWeeklySection(base, section, TEXT.weeklyMarker);
    const html = renderMarkdown(content);
    expect(html).toContain('<p>第一段：今天学了单调栈。</p>');
    expect(html).toContain('<h2>其他小节</h2>');
    expect(html).toContain(`<h2>${TEXT.weeklyMarker.replace('## ', '')}`);
    // marker 转义后再断言会失真，这里直接确认旧的「旧周报」已经不在
    expect(content).not.toContain('旧周报');
  });
});

describe('buildWeeklyStats：口径与边界', () => {
  it('weekStart=1（周一）vs 0（周日）：同一份数据、不同的周区间与最高效日', () => {
    // 2026-10-25 是周日：周一制把它算进 10-19~10-25，周日制算进 10-25~10-31
    const sunday = '2026-10-25';
    const sessions = [
      session('big', '2026-10-19', 9, 120), // 周一制这周里的 2 小时
      session('small', '2026-10-26', 9, 30), // 周日制这周里的 30 分钟
    ];
    const mondayFirst = buildWeeklyStats({
      tasks: [],
      focusSessions: sessions,
      notes: [],
      today: sunday,
      weekStart: 1,
    });
    const sundayFirst = buildWeeklyStats({
      tasks: [],
      focusSessions: sessions,
      notes: [],
      today: sunday,
      weekStart: 0,
    });

    expect([mondayFirst.startKey, mondayFirst.endKey]).toEqual(['2026-10-19', '2026-10-25']);
    expect([sundayFirst.startKey, sundayFirst.endKey]).toEqual(['2026-10-25', '2026-10-31']);

    expect(mondayFirst.focusMs).toBe(120 * 60000);
    expect(sundayFirst.focusMs).toBe(30 * 60000);
    expect(mondayFirst.peakDay?.date).toBe('2026-10-19');
    expect(sundayFirst.peakDay?.date).toBe('2026-10-26');
    // 同一个"今天"，两种口径的区间一定不同 —— 否则设置里的 weekStart 是死的
    expect(mondayFirst.startKey).not.toBe(sundayFirst.startKey);
  });

  it('0 任务 / 0 专注 / 0 卡片：不抛，指标为 0 或 null（UI 显示占位）', () => {
    const s = stats();
    expect(s).toMatchObject({
      focusMs: 0,
      prevFocusMs: 0,
      focusDeltaPercent: null,
      doneCount: 0,
      totalCount: 0,
      doneRate: null,
      peakDay: null,
      peakHour: null,
      byCategory: [],
      review: { total: 0, scheduled: 0, mature: 0 },
    });
    const md = buildWeeklyMarkdown(s);
    expect(md.startsWith(`${TEXT.weeklyMarker} · ${s.rangeLabel}`)).toBe(true);
    expect(md).toContain('—'); // 峰值占位
    expect(md).toContain(TEXT.emptyPercent); // 完成率占位
    expect(md).toContain(`${TEXT.reviewHealthCards} 0`);
  });

  it('完成任务按 task.date 归日（不是 doneAt）：跨周的任务不算进本周', () => {
    const tasks = [
      task('t1', '2026-10-20', true),
      task('t2', '2026-10-21', false),
      task('t3', '2026-10-10', true), // 上一周
    ];
    const s = buildWeeklyStats({
      tasks,
      focusSessions: [],
      notes: [],
      today: TODAY,
      weekStart: 1,
    });
    expect(s.doneCount).toBe(1);
    expect(s.totalCount).toBe(2);
    expect(s.doneRate).toBe(50);
  });

  it('脏数据（null 集合 / 缺 startedAt）不抛', () => {
    expect(() =>
      buildWeeklyStats({
        tasks: null as unknown as Task[],
        focusSessions: [{ id: 'x' } as unknown as FocusSession],
        notes: null as unknown as [],
        today: TODAY,
        weekStart: 1,
      }),
    ).not.toThrow();
  });
});

/* ============================================================================
   v0.12：日记快满时写周报必须「放弃」，不能写半截
   —— 写半截会把 marker 截掉，下一次判定成"还没有周报"又追加一份，
      用户点几次就攒出几份半截周报。
   ========================================================================= */

describe('周报：空间不足时放弃写入（幂等优先）', () => {
  const MARKER = '## 本周回顾';
  const section = `${MARKER}\n\n- 完成 3 条\n`;

  it('正文接近上限 → skipped=true 且原样返回，绝不产生半截区块', () => {
    const existing = 'x'.repeat(DIARY_MAX - 5);
    const result = upsertWeeklySection(existing, section, MARKER);
    expect(result.skipped).toBe(true);
    expect(result.replaced).toBe(false);
    expect(result.content).toBe(existing); // 原文一个字都没动
  });

  it('放弃之后再点一次，仍然不会追加出第二份', () => {
    const existing = 'x'.repeat(DIARY_MAX - 5);
    const first = upsertWeeklySection(existing, section, MARKER);
    const second = upsertWeeklySection(first.content, section, MARKER);
    expect(second.skipped).toBe(true);
    expect(second.content).toBe(existing);
  });

  it('空间够时正常写入并标记 replaced', () => {
    const first = upsertWeeklySection('今天的正文', section, MARKER);
    expect(first.skipped).toBe(false);
    expect(first.content).toContain(MARKER);
    const second = upsertWeeklySection(first.content, section, MARKER);
    expect(second.skipped).toBe(false);
    expect(second.replaced).toBe(true);
  });
});
