import { describe, expect, it } from 'vitest';
import {
  buildWeeklyMarkdown,
  buildWeeklyStats,
  weeklyWriteDate,
  type WeeklyStatsArgs,
} from '../weekly';
import { addDays, diffDays, formatWeekTitle } from '../date';
import { TEXT } from '../../constants';
import type { FocusSession, Note, NoteSr, Task } from '../../types';

/* ============================================================================
   周报的「上一周 / 本周 / 下一周」三档（v0.9 议题 3）+「本周复习 N 张」（议题 5）

   两条最贵的约束：
   1. **offset 只平移整周**：`weekStart` 仍然由 settings.weekStart + today 算出，
      offset 只负责 ±7 天。写反了就会出现"周一为一周起点，但上一周从周日开始"，
      区间与侧栏周视图错开一天，用户对不上账。
   2. **区间与指标必须同源**：6 个指标全部落在 [startKey, endKey] 里，
      不能出现"区间写着 10/12–18、专注却统计了本周"这种错位。

   全部用固定的 TODAY = 2026-10-24（周五）断言，不读系统时钟。
   ========================================================================= */

const TODAY = '2026-10-24'; // 周五

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

function focus(id: string, date: string, startHour: number, minutes: number): FocusSession {
  const start = `${date}T${String(startHour).padStart(2, '0')}:00:00`;
  const startedAt = new Date(Date.parse(start)).toISOString();
  const endedAt = new Date(Date.parse(start) + minutes * 60_000).toISOString();
  return { id, taskId: null, date, startedAt, endedAt, durationMs: minutes * 60_000 };
}

/** 一张卡：`last` 用**本地时间**构造，避免断言依赖运行机器的时区 */
function card(id: string, ivl: number, lastLocal?: [number, number, number]): Note {
  const sr: NoteSr = { due: '2026-10-30', ivl, reps: 2 };
  if (lastLocal) {
    const [y, m, d] = lastLocal;
    // 正午构造：任何时区下都落在同一天，跨时区不会翻转日期
    sr.last = new Date(y, m - 1, d, 12, 0, 0).toISOString();
  }
  return {
    id,
    title: id,
    content: `${id} 正文`,
    category: '',
    pinned: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    sr,
  };
}

function stats(args: Partial<WeeklyStatsArgs> & Pick<WeeklyStatsArgs, 'weekOffset'>) {
  return buildWeeklyStats({
    tasks: [],
    focusSessions: [],
    notes: [],
    today: TODAY,
    weekStart: 1,
    ...args,
  });
}

const TASKS = [
  task('prev', '2026-10-13', true, '学习'), // 上一周（周一）
  task('this-open', '2026-10-20', false, '学习'), // 本周
  task('this-done', '2026-10-21', true, '工作'), // 本周
  task('next', '2026-10-27', false, '学习'), // 下一周
];

const SESSIONS = [
  focus('f-prev', '2026-10-13', 9, 30),
  focus('f-this-1', '2026-10-20', 9, 60),
  focus('f-this-2', '2026-10-21', 21, 15),
  focus('f-next', '2026-10-27', 9, 45),
];

const NOTES = [
  card('n-prev', 8, [2026, 10, 13]),
  card('n-this-1', 3, [2026, 10, 19]), // 本周第一天（端点）
  card('n-this-2', 3, [2026, 10, 25]), // 本周最后一天（端点）
  card('n-next', 3, [2026, 10, 27]),
  card('n-never', 0), // 入队但没学过：没有 last
];

describe('weekOffset：区间只平移整周', () => {
  it('weekStart=1（周一）：-1 / 0 / +1 三档起止正确', () => {
    const prev = stats({ weekOffset: -1 });
    const cur = stats({ weekOffset: 0 });
    const next = stats({ weekOffset: 1 });

    expect([cur.startKey, cur.endKey]).toEqual(['2026-10-19', '2026-10-25']);
    expect([prev.startKey, prev.endKey]).toEqual(['2026-10-12', '2026-10-18']);
    expect([next.startKey, next.endKey]).toEqual(['2026-10-26', '2026-11-01']);
  });

  it('offset 只平移整周（相差正好 7 天，绝不改变"从周几开始"）', () => {
    const cur = stats({ weekOffset: 0 });
    const prev = stats({ weekOffset: -1 });
    const next = stats({ weekOffset: 1 });

    expect(diffDays(cur.startKey, prev.startKey)).toBe(7);
    expect(diffDays(next.startKey, cur.startKey)).toBe(7);
    // 三个 startKey 都是周一（weekStart=1）：周一 = getDay() === 1
    for (const key of [prev.startKey, cur.startKey, next.startKey]) {
      expect(new Date(`${key}T00:00:00`).getDay()).toBe(1);
    }
    // 每档都恰好 7 天（endKey = startKey + 6），且 weekOffset 如实回传
    expect([prev.weekOffset, cur.weekOffset, next.weekOffset]).toEqual([-1, 0, 1]);
    for (const s of [prev, cur, next]) {
      expect(diffDays(s.endKey, s.startKey)).toBe(6);
    }
  });

  it('weekStart=0（周日）时同样只平移整周：上一周从周日开始', () => {
    const cur = buildWeeklyStats({ tasks: [], focusSessions: [], notes: [], today: TODAY, weekStart: 0, weekOffset: 0 });
    const prev = buildWeeklyStats({ tasks: [], focusSessions: [], notes: [], today: TODAY, weekStart: 0, weekOffset: -1 });
    expect([cur.startKey, cur.endKey]).toEqual(['2026-10-18', '2026-10-24']);
    expect([prev.startKey, prev.endKey]).toEqual(['2026-10-11', '2026-10-17']);
    expect(new Date(`${cur.startKey}T00:00:00`).getDay()).toBe(0); // 周日
    expect(new Date(`${prev.startKey}T00:00:00`).getDay()).toBe(0);
  });

  it('区间文案跟着 offset 变（rangeLabel 与起止同源）', () => {
    for (const offset of [-1, 0, 1]) {
      const s = stats({ weekOffset: offset });
      expect(s.rangeLabel).toBe(formatWeekTitle(s.startKey, s.endKey));
    }
    expect(stats({ weekOffset: -1 }).rangeLabel).toBe('10月12日 – 18日');
    expect(stats({ weekOffset: 0 }).rangeLabel).toBe('10月19日 – 25日');
    expect(stats({ weekOffset: 1 }).rangeLabel).toBe('10月26日 – 11月1日');
  });

  it('脏 offset（NaN / 小数 / 超界）收敛，绝不抛', () => {
    expect(stats({ weekOffset: Number.NaN }).startKey).toBe('2026-10-19');
    expect(stats({ weekOffset: 1.7 }).weekOffset).toBe(1);
    expect(stats({ weekOffset: -1.7 }).weekOffset).toBe(-1);
    // undefined = 本周（默认值）
    expect(
      buildWeeklyStats({ tasks: [], focusSessions: [], notes: [], today: TODAY, weekStart: 1 }).startKey,
    ).toBe('2026-10-19');
  });

  it('offset 与"往整数周上取整"无关：同一周内的任意 today 都得到同一组区间', () => {
    const monday = buildWeeklyStats({ tasks: [], focusSessions: [], notes: [], today: '2026-10-19', weekStart: 1, weekOffset: -1 });
    const sunday = buildWeeklyStats({ tasks: [], focusSessions: [], notes: [], today: '2026-10-25', weekStart: 1, weekOffset: -1 });
    expect(monday.startKey).toBe(sunday.startKey);
    expect(monday.endKey).toBe(sunday.endKey);
  });
});

describe('weekOffset：六个指标跟着哪一周走', () => {
  it('专注 / 完成数 / 完成率 / 最高效日 / 复习数 全部落在所选区间', () => {
    const prev = stats({ weekOffset: -1, tasks: TASKS, focusSessions: SESSIONS, notes: NOTES });
    const cur = stats({ weekOffset: 0, tasks: TASKS, focusSessions: SESSIONS, notes: NOTES });
    const next = stats({ weekOffset: 1, tasks: TASKS, focusSessions: SESSIONS, notes: NOTES });

    // 专注毫秒
    expect(prev.focusMs).toBe(30 * 60_000);
    expect(cur.focusMs).toBe(75 * 60_000);
    expect(next.focusMs).toBe(45 * 60_000);

    // 完成任务：只有落在该区间的任务参与口径
    expect([prev.doneCount, prev.totalCount]).toEqual([1, 1]);
    expect([cur.doneCount, cur.totalCount]).toEqual([1, 2]);
    expect([next.doneCount, next.totalCount]).toEqual([0, 1]);

    // 最高效日 = 区间内专注最多的一天
    expect(cur.peakDay?.date).toBe('2026-10-20');
    expect(prev.peakDay?.date).toBe('2026-10-13');
    expect(next.peakDay?.date).toBe('2026-10-27');

    // 环比：offset 变了，"上一周"也跟着平移（不是永远拿本周比上周）
    // prev 档的上一周是 10/05–10/11 → 没有记录 → 0
    expect(prev.prevFocusMs).toBe(0);
    expect(prev.focusDeltaPercent).toBeNull();
    // cur 档的上一周正是 prev 档本身 → 30 分钟
    expect(cur.prevFocusMs).toBe(30 * 60_000);
    expect(cur.focusDeltaPercent).toBe(150);
  });

  it('「本周复习 N 张」按区间统计（含端点、排除没学过的卡）', () => {
    expect(stats({ weekOffset: -1, notes: NOTES }).reviewedCount).toBe(1);
    expect(stats({ weekOffset: 0, notes: NOTES }).reviewedCount).toBe(2); // 10/19 与 10/25 两个端点
    expect(stats({ weekOffset: 1, notes: NOTES }).reviewedCount).toBe(1);
    // 队列健康度与区间无关（它描述"现在"，不是"那一周"）
    expect(stats({ weekOffset: 0, notes: NOTES }).review).toEqual({ total: 5, scheduled: 4, mature: 1 });
  });
});

describe('buildWeeklyMarkdown：新增「本周复习 N 张」但保留队列健康度', () => {
  const markdown = buildWeeklyMarkdown(
    stats({ weekOffset: 0, tasks: TASKS, focusSessions: SESSIONS, notes: NOTES }),
    { harvest: '', problem: '', next: '' },
    '',
  );

  it('两行都在：一行说投入量，一行说队列堵不堵', () => {
    expect(markdown).toContain(`${TEXT.weeklyReviewed}：2 ${TEXT.weeklyReviewedUnit}`);
    expect(markdown).toContain(TEXT.reviewHealthTitle);
    expect(markdown).toContain(`${TEXT.reviewHealthCards} 5 ${TEXT.reviewHealthUnit}`);
  });

  it('复习数那行是独立一行（不挤进别的行里）', () => {
    const line = markdown.split('\n').find((row) => row.startsWith(`- ${TEXT.weeklyReviewed}：`));
    expect(line).toBe(`- ${TEXT.weeklyReviewed}：2 ${TEXT.weeklyReviewedUnit}`);
  });

  it('标题仍是 `## 本周回顾 · 区间`（marker 靠前缀命中，改不得）', () => {
    expect(markdown.startsWith(`${TEXT.weeklyMarker} · `)).toBe(true);
  });
});

describe('区间工具自检（防止断言本身写错）', () => {
  it('addDays 用于跨月：10/26 + 6 = 11/01', () => {
    expect(addDays('2026-10-26', 6)).toBe('2026-11-01');
  });
});

/* ============================================================================
   写入目标日 = min(today, 那一周最后一天)（v0.8.1 放开历史周写入）

   为什么必须有这条单测：目标日是"写进哪一篇日记"的唯一决定项。
   规则写错一次就是数据事故 —— 补写历史周却覆盖了今天的日记，
   而 UI 上完全看不出来。所以它必须是一个纯函数，而不是埋在 JSX 里。
   ========================================================================= */
describe('weeklyWriteDate：写入目标 = min(today, 周最后一天)', () => {
  it('本周（endKey >= today）→ 写今天', () => {
    expect(weeklyWriteDate('2026-10-24', '2026-10-25')).toBe('2026-10-24');
  });

  it('今天正好是周日（endKey === today）→ 仍写今天，不算"历史周"', () => {
    expect(weeklyWriteDate('2026-10-25', '2026-10-25')).toBe('2026-10-25');
  });

  it('历史周（endKey < today）→ 写那一周的最后一天', () => {
    expect(weeklyWriteDate('2026-10-24', '2026-10-18')).toBe('2026-10-18');
    expect(weeklyWriteDate('2026-10-24', '2026-10-12')).toBe('2026-10-12');
  });

  it('未来周也不会把字写进未来：结果恒 <= today', () => {
    expect(weeklyWriteDate('2026-10-24', '2026-11-01')).toBe('2026-10-24');
  });

  it('跨年 / 跨月按定长字符串比较仍然成立（不用解析 Date，无时区坑）', () => {
    expect(weeklyWriteDate('2027-01-02', '2026-12-31')).toBe('2026-12-31');
    expect(weeklyWriteDate('2027-01-02', '2027-01-03')).toBe('2027-01-02');
    expect(weeklyWriteDate('2026-10-01', '2026-09-30')).toBe('2026-09-30');
  });

  it('与 buildWeeklyStats 的 endKey 联动：三档各自的写入目标', () => {
    const prev = stats({ weekOffset: -1 }); // 10/12 – 10/18
    const cur = stats({ weekOffset: 0 }); // 10/19 – 10/25
    const next = stats({ weekOffset: 1 }); // 10/26 – 11/01

    expect(weeklyWriteDate(TODAY, prev.endKey)).toBe('2026-10-18'); // 补写到那一周最后一天
    expect(weeklyWriteDate(TODAY, cur.endKey)).toBe(TODAY); // 本周含今天 → 写今天
    expect(weeklyWriteDate(TODAY, next.endKey)).toBe(TODAY); // 未来周也只会得到今天
  });

  it('weekStart=0（周日）时历史周的写入目标同样落在它的最后一天（周六）', () => {
    const prev = buildWeeklyStats({
      tasks: [],
      focusSessions: [],
      notes: [],
      today: TODAY,
      weekStart: 0,
      weekOffset: -1,
    });
    expect([prev.startKey, prev.endKey]).toEqual(['2026-10-11', '2026-10-17']);
    expect(weeklyWriteDate(TODAY, prev.endKey)).toBe('2026-10-17');
  });

  it('脏参数退化：缺 today / 缺 endKey 都不抛，也不会产生空日期', () => {
    expect(weeklyWriteDate('', '2026-10-18')).toBe('2026-10-18');
    expect(weeklyWriteDate('2026-10-24', '')).toBe('2026-10-24');
    expect(weeklyWriteDate('', '')).toBe('');
  });
});
