import type { ReactNode } from 'react';
import { Icon } from '../common/Icon';

export interface TodaySummaryProps {
  /**
   * 一行摘要的片段（按顺序拼成 `A · B · C`）。
   * 传空数组 = 这一屏没有任何"辅助信息"可概括 → 整块不渲染，
   * 连那根分隔线都不占（没有目标的用户不该被一个空壳按钮挡着）。
   */
  chips: string[];
  expanded: boolean;
  onToggle: () => void;
  /** 展开后才显示的内容：昨日回顾 / 目标倒计时 / 作息 / 习惯条 */
  children: ReactNode;
}

/**
 * 今日概览条：把「昨日回顾 · 目标 · 作息 · 习惯」这些**辅助信息**收成一行。
 *
 * 为什么要收（有实测数据，不是审美主张）：
 * 390×780 竖屏下这四块一共占 384px，把第一条任务顶到第 1.18 屏 ——
 * 一个待办应用打开后首屏一条任务都看不见。它们都重要，但都不是"现在要做什么"，
 * 所以让位：默认一行摘要，点开才铺开（`npm run report:firstscreen` 可复测）。
 *
 * 为什么不用 `<details>`：需要控制展开态（视图里还要驱动别的行为），
 * 而且原生 details 的展开无法做进入动画。
 */
export function TodaySummary({ chips, expanded, onToggle, children }: TodaySummaryProps) {
  if (chips.length === 0) return null;

  return (
    <div className="mt-1">
      <button
        type="button"
        data-testid="today-summary"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex w-full items-center gap-2 rounded-md px-1 py-2 text-left text-label text-ink-2 transition-colors duration-short ease-standard hover:bg-surface-sunk"
      >
        <span className="min-w-0 flex-1 truncate">{chips.join(' · ')}</span>
        <span className="shrink-0 text-ink-3">{expanded ? '收起' : '展开'}</span>
        <Icon
          name="chevron-down"
          size={14}
          className={`shrink-0 text-ink-3 transition-transform duration-short ease-standard ${
            expanded ? 'rotate-180' : ''
          }`}
        />
      </button>
      {expanded ? <div className="summary-enter mt-1">{children}</div> : null}
    </div>
  );
}
