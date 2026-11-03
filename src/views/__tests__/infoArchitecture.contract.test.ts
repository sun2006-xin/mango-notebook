import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/* ============================================================================
   信息层级（v0.29.5）
   ----------------------------------------------------------------------------
   用户的两句反馈对应这里的两条：
   ① "底部 7 个 Tab 在 390 上已经接近极限，看看是不是该收一个进更多"
      → 收的是**日历**：它不是"另一个地方"，而是"周"的缩放层级。
   ② "设置那里超长移动，要设置的太多了"
      → 统计卡三个数做成一行；设置分 7 组、默认只展开最常用的 2 组
        （实测：设置页从 ~6.7 屏压到 2.31 屏）。

   这个文件守结构，像素由 report_first_screen / 真机手感复核。
   ========================================================================= */

const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), 'utf8');

const CONSTANTS = read('../../constants.ts');
const NAV = read('../../components/layout/Nav.tsx');
const WEEK = read('../WeekView.tsx');
const CALENDAR = read('../CalendarView.tsx');
const SETTINGS = read('../SettingsView.tsx');

describe('底部导航：6 格，日历并进「周」', () => {
  it('TAB_VIEWS 是 6 个，且不含日历', () => {
    const block = CONSTANTS.slice(
      CONSTANTS.indexOf('export const TAB_VIEWS'),
      CONSTANTS.indexOf('] as const satisfies'),
    );
    const items = [...block.matchAll(/'(\w+)'/g)].map((m) => m[1]);
    expect(items).toHaveLength(6);
    expect(items).not.toContain('calendar');
    // 常用入口一个都不能少
    for (const id of ['today', 'week', 'focus', 'diary', 'notes', 'settings']) {
      expect(items).toContain(id);
    }
  });

  it('底部栏用 TAB_VIEWS 渲染（侧栏仍用 VIEW_ORDER，7 个）', () => {
    expect(NAV).toContain('{TAB_VIEWS.map');
    expect(NAV).toContain('repeat(${TAB_VIEWS.length}');
    // 侧栏那处必须还在用 VIEW_ORDER，否则桌面端少了入口
    expect(NAV).toContain('{VIEW_ORDER.map');
  });

  it('日历仍然进得去、也回得来（周 ⇄ 月 两个方向都要有）', () => {
    expect(WEEK).toContain('data-testid="week-to-calendar"');
    expect(WEEK).toContain("view: 'calendar'");
    expect(CALENDAR).toContain('data-testid="calendar-to-week"');
    expect(CALENDAR).toContain("view: 'week'");
  });
});

describe('设置页：一行三格 + 分组折叠', () => {
  it('三个统计数在一行（grid-cols-3，不再是竖着堆三张 104px 的卡）', () => {
    expect(SETTINGS).toContain('grid grid-cols-3');
    expect(SETTINGS).not.toContain('grid-cols-1 gap-3 sm:grid-cols-3');
  });

  it('分成 7 组：外观 / 专注 / 习惯 / 统计 / 分类目标 / 云 / 数据', () => {
    for (const id of [
      'appearance',
      'focus',
      'habits',
      'stats',
      'meta',
      'cloud',
      'data',
    ]) {
      expect(SETTINGS, `缺少分组 ${id}`).toContain(`testId="settings-group-${id}"`);
    }
  });

  /**
   * 默认展开只留 2 组：外观（最常改）与数据（导出备份 / 换机恢复）。
   * 全展开 = 回到"什么都看得见 = 什么都看不见"的老问题；
   * 全收起 = 用户还得先猜东西在哪一组。2 组是"最常用的仍是一眼可见"的最小集。
   */
  it('默认只展开 2 组（全展开等于没折叠）', () => {
    const count = (SETTINGS.match(/defaultOpen/g) ?? []).length;
    expect(count).toBe(2);
  });

  it('每组的收起态都有摘要（收起 ≠ 藏起来）', () => {
    const groups = SETTINGS.match(/<SettingsGroup[\s\S]*?>/g) ?? [];
    expect(groups).toHaveLength(7);
    for (const g of groups) {
      expect(g, '分组缺 summary：收起后用户不知道里面有什么').toContain('summary="');
    }
  });
});
