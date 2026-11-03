import { useState, type ReactNode } from 'react';
import { Icon } from '../common/Icon';

export interface SettingsGroupProps {
  title: string;
  /**
   * 收起时显示的一行摘要（例如「主题 · 起始日 · 默认视图」）。
   * 作用不是装饰 —— 收起之后用户仍然知道这组里有什么，才敢不展开。
   */
  summary: string;
  defaultOpen?: boolean;
  testId?: string;
  children: ReactNode;
}

/**
 * 设置分组（可折叠）。
 *
 * 为什么需要：设置页一路摊平下来有 11 个 `SettingRow` + 7 块编辑器/卡片，
 * 手机上要滑好几屏才到底（用户原话：**"要设置的太多了"**）。
 * 全摊开的问题是"什么都看得见 = 什么都看不见" —— 想找「导出备份」得先划过
 * 习惯编辑器、周计划模板、热力图、月报。
 *
 * 折叠之后每组的标题行本身就是目录：一屏能看到全部 7 组在哪儿，点两下就到。
 * 摘要那一行是关键的补偿 —— 收起不等于藏起来。
 *
 * 默认只展开最常用的两组（外观 / 数据备份），其余收起：默认值应该服务
 * "90% 的人 90% 的情况下要改什么"，而不是"我全都摆出来最省事"。
 */
export function SettingsGroup({
  title,
  summary,
  defaultOpen = false,
  testId,
  children,
}: SettingsGroupProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="border-b border-line" data-testid={testId}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        data-testid={testId ? `${testId}-toggle` : undefined}
        className="flex min-h-14 w-full items-center gap-3 py-3 text-left
          transition-colors duration-short ease-standard hover:bg-surface-sunk"
      >
        <span className="shrink-0 text-body font-semibold text-ink">{title}</span>
        {open ? (
          <span className="min-w-0 flex-1" />
        ) : (
          <span className="min-w-0 flex-1 truncate text-label text-ink-3">{summary}</span>
        )}
        <Icon
          name="chevron-down"
          size={15}
          className={`shrink-0 text-ink-3 transition-transform duration-short ease-standard ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>
      {open ? <div className="summary-enter pb-3">{children}</div> : null}
    </section>
  );
}
