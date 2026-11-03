import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/* ============================================================================
   v0.9 议题 3：周报的「上一周 / 本周 / 下一周」三档切换
   v0.8.1：放开历史周写入（补写以前的周报）

   主理人裁决（必须遵守）：
   - 可写范围 = `weekOffset <= 0`（**历史周 + 本周可写**）；
   - **`weekOffset === 1`（未来周）仍只读** —— 那一周还没发生，写它是编造；
   - 写入目标日 = `min(today, 那一周的最后一天)`（`weeklyWriteDate` 纯函数）：
     本周 → 今天，历史周 → 那一周的 `endKey`；
   - 判重与写入都看**目标那一篇**（`targetEntry`），否则切到历史周会错显示"已生成"。

   这里是源码契约测试（本工程没有 jsdom，视图类行为一律用契约钉住），
   钉四件事：三档按钮存在、区间与统计同源、未来周被两道闸拦住、
   历史周真的写到"那一周最后一天"而不是今天。
   ========================================================================= */

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '');
}

function read(rel: string): string {
  return stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'));
}

const diarySrc = read('../DiaryView.tsx');

/** onWriteWeekly 的函数体（到 onAnswer 为止，避免依赖依赖数组的排版） */
function onWriteBlock(): string {
  const start = diarySrc.indexOf('const onWriteWeekly = useCallback(');
  const end = diarySrc.indexOf('const onAnswer = useCallback(');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return diarySrc.slice(start, end);
}

describe('三档切换的 UI', () => {
  it('三个按钮都在（上一周 / 本周 / 下一周）', () => {
    // testId 由三元组表生成 → 断言表里三个 testId 都存在 + 真的绑到了属性上
    expect(diarySrc).toContain("'weekly-prev'");
    expect(diarySrc).toContain("'weekly-this'");
    expect(diarySrc).toContain("'weekly-next'");
    expect(diarySrc).toContain('data-testid={testId}');
    expect(diarySrc).toContain('TEXT.weeklyPrevWeek');
    expect(diarySrc).toContain('TEXT.weeklyThisWeek');
    expect(diarySrc).toContain('TEXT.weeklyNextWeek');
  });

  it('默认「本周」：初始 offset 是 0', () => {
    expect(diarySrc).toContain('useState<-1 | 0 | 1>(0)');
    expect(diarySrc).toContain('setWeekOffset(offset)');
  });

  it('offset 传给 buildWeeklyStats（区间与 6 个指标同源，不会各算一份）', () => {
    expect(diarySrc).toContain('weekOffset,');
    // 依赖数组里必须有 weekOffset，否则切换后统计不重算
    expect(diarySrc).toContain('[tasks, focusSessions, notes, today, settings.weekStart, weekOffset]');
  });

  it('区间文案来自 stats.rangeLabel（标题会跟着切）', () => {
    expect(diarySrc).toContain('{weeklyStats.rangeLabel}');
  });

  it('新增「本周复习 N 张」指标（与队列健康度并存）', () => {
    expect(diarySrc).toContain('weeklyStats.reviewedCount');
    expect(diarySrc).toContain('TEXT.weeklyReviewed');
  });
});

describe('可写范围：历史周 + 本周可写，未来周只读', () => {
  it('第一道闸：canWriteWeekly = weekOffset <= 0，按钮 disabled', () => {
    expect(diarySrc).toContain('const canWriteWeekly = weekOffset <= 0;');
    expect(diarySrc).toContain('disabled={!canWriteWeekly}');
  });

  it('历史周不再被拦：没有"只有本周可写"的老判断残留', () => {
    // 老语义的两处硬编码必须消失，否则历史周写了会被静默丢弃
    expect(diarySrc).not.toContain('weekOffset === 0');
    expect(diarySrc).not.toContain('weekOffset !== 0');
    expect(diarySrc).not.toContain('TEXT.weeklyWriteOnlyCurrent');
  });

  it('第二道闸：handler 早退，且早退在 buildWeeklyMarkdown 之前', () => {
    const block = onWriteBlock();
    const guard = block.indexOf('if (!canWriteWeekly) return;');
    const build = block.indexOf('const section = buildWeeklyMarkdown(');
    const dispatch = block.indexOf("dispatch({ type: 'DIARY_UPSERT'");
    expect(guard).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(guard);
    expect(dispatch).toBeGreaterThan(build);
  });

  it('未来周不 dispatch DIARY_UPSERT：唯一的写入点在早退之后', () => {
    // 整个文件的 DIARY_UPSERT 只有两处：编辑器输入 + 周报写入
    const hits = diarySrc.split("type: 'DIARY_UPSERT'").length - 1;
    expect(hits).toBe(2);
    const block = onWriteBlock();
    const guard = block.indexOf('if (!canWriteWeekly) return;');
    const weeklyDispatch = block.indexOf("dispatch({ type: 'DIARY_UPSERT'");
    expect(guard).toBeGreaterThan(-1);
    expect(weeklyDispatch).toBeGreaterThan(guard);
  });

  it('未来周给出明确提示，而不是静默什么都不发生', () => {
    expect(diarySrc).toContain('data-testid="weekly-readonly"');
    expect(diarySrc).toContain('TEXT.weeklyFutureReadOnly');
    // 头部状态仍用 weeklyReadOnly（"未来周只读"那句话）
    expect(diarySrc).toContain('TEXT.weeklyReadOnly');
  });
});

describe('写入目标 = min(today, 周最后一天)', () => {
  it('目标日由 weeklyWriteDate 算出（规则不埋在 JSX 里）', () => {
    expect(diarySrc).toContain('weeklyWriteDate(today, weeklyStats.endKey)');
  });

  it('写入用 weeklyTargetDate，而不是写死 today', () => {
    const block = onWriteBlock();
    expect(block).toContain('upsertWeeklySection(targetEntry?.content');
    expect(block).toContain('date: weeklyTargetDate');
    expect(block).not.toContain('date: today');
    // 也不许出现"写到区间起始日"这类歧义写法
    expect(block).not.toContain('date: weeklyStats.startKey');
  });

  it('判重看目标那一篇（切到历史周且那周已写过 → 已生成）', () => {
    expect(diarySrc).toContain('diary.find((entry) => entry.date === weeklyTargetDate)');
    expect(diarySrc).toContain('Boolean(targetEntry?.content?.includes(TEXT.weeklyMarker))');
  });

  it('写后同步草稿的条件也换成目标日', () => {
    expect(onWriteBlock()).toContain('if (selected === weeklyTargetDate) setDraft(result.content);');
  });

  it('依赖数组补齐 weeklyTargetDate / targetEntry?.content（否则切周后仍是旧值）', () => {
    expect(diarySrc).toContain('weeklyTargetDate,');
    expect(diarySrc).toContain('targetEntry?.content,');
    expect(diarySrc).toContain('canWriteWeekly,');
  });

  it('历史周把"将写入哪一天"说出来（文案不硬编码在组件里）', () => {
    expect(diarySrc).toContain('data-testid="weekly-target"');
    expect(diarySrc).toContain('TEXT.weeklyWriteTarget');
    expect(diarySrc).toContain('formatDateTitle(weeklyTargetDate)');
  });
});
