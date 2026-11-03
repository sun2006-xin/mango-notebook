import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/* ============================================================================
   今日页首屏：清单必须在前，辅助信息靠后（v0.29.3）
   ----------------------------------------------------------------------------
   实测（`npm run report:firstscreen`，390×780）改前：第一条任务在第 **1.18** 屏，
   首屏内完整可见的任务 **0** 条 —— 一个待办应用打开后看不见任何待办。
   原因不是哪个块写错了，而是**顺序**：昨日回顾 / 目标 / 作息 / 习惯 四块
   共 384px 全压在清单上面。

   现在：日期标题最上 → 一行概览条（默认收起）→ 进度 → 快速添加 → 筛选 →
   逾期（前 3 条）→ 清单。实测 0.62 屏、首屏 5 条。

   这个文件守的是**结构**，不是像素：顺序错了、默认展开了、逾期不限条数了，
   都要红。像素由 report_first_screen.mjs 复核（它只报告不拦截，因为不同
   数据量下均值不同，硬卡阈值会变成噪音）。
   ========================================================================= */

const SRC = readFileSync(new URL('../TodayView.tsx', import.meta.url), 'utf8');
const OVERDUE = readFileSync(
  new URL('../../components/task/OverdueSection.tsx', import.meta.url),
  'utf8',
);

describe('今日页首屏结构', () => {
  it('日期标题在概览条之前，概览条在清单之前', () => {
    const title = SRC.indexOf('id="todayTitle"');
    const summary = SRC.indexOf('<TodaySummary');
    const list = SRC.indexOf('<TaskList');
    expect(title).toBeGreaterThan(-1);
    expect(summary).toBeGreaterThan(-1);
    expect(list).toBeGreaterThan(-1);
    expect(title).toBeLessThan(summary);
    expect(summary).toBeLessThan(list);
  });

  it('四块辅助信息都在概览面板内部（不是直接铺在 section 里）', () => {
    const summary = SRC.indexOf('<TodaySummary');
    for (const marker of [
      '<DailyRecapCard',
      'data-testid="goal-countdown"',
      'data-testid="sleep-log"',
      '<HabitStrip',
    ]) {
      const at = SRC.indexOf(marker);
      expect(at, `${marker} 不见了`).toBeGreaterThan(-1);
      expect(at, `${marker} 又跑到概览面板外面了（首屏会被顶下去）`).toBeGreaterThan(summary);
    }
  });

  it('默认收起（展开是一次显式点击，不是默认值）', () => {
    expect(SRC).toContain('const [briefOpen, setBriefOpen] = useState(false);');
  });

  it('概览条在没有任何摘要时不渲染（空壳按钮同样是噪音）', () => {
    const summarySrc = readFileSync(
      new URL('../../components/today/TodaySummary.tsx', import.meta.url),
      'utf8',
    );
    expect(summarySrc).toContain('if (chips.length === 0) return null;');
  });
});

describe('逾期区不许无限铺开', () => {
  /**
   * 截断规则本身已抽成纯函数，**行为**在 `lib/__tests__/listSlice.test.ts` 里测
   * （刚好 N 条 / 少于 N 条 / 展开 / 非法上限）。这里只留"接线"：
   * 组件必须用那个函数，而不是又手写一遍 slice。
   */
  it('用 sliceForPreview 算可见条数（不再手写 slice）', () => {
    expect(OVERDUE).toContain('sliceForPreview(tasks, showAll)');
    // 手写截断的指纹：出现就说明又抄回去了
    expect(OVERDUE).not.toContain('tasks.slice(0,');
  });

  it('溢出的条数用计算结果，不是写死的文案', () => {
    expect(OVERDUE).toContain('data-testid="overdue-more"');
    expect(OVERDUE).toContain('还有 ${overflow} 条逾期');
  });

  it('渲染的是截断后的列表，不是全量', () => {
    expect(OVERDUE).toContain('visibleTasks.map');
    expect(OVERDUE).not.toContain('{tasks.map(');
  });
});
