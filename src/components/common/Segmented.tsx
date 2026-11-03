export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedProps<T extends string> {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  /** 分组无障碍名称 */
  ariaLabel: string;
  className?: string;
  /** pill = 胶囊底（筛选条）；plain = 透明底（抽屉内） */
  variant?: 'pill' | 'plain';
}

/**
 * 分段选择器：筛选（全部/未完成/已完成）、周起始日、默认视图、抽屉内优先级共用。
 * 每个选项自带 44 高度的触达区（h-11）；选中态同时用底色与文字色表达，不只靠颜色。
 *
 * 宽度策略（两次迭代才定下来，两次都是被真实问题逼的）：
 *
 * **第一版**：`inline-flex + whitespace-nowrap`，按内容撑开 → 文档横向可滚，
 * 移动端浏览器把布局视口撑宽，贴着布局视口算的 `position: fixed` 顶栏与底部 Tab
 * 一起被拉出屏幕（用户原话"界面不固定、超出界限"）。
 *
 * **第二版**：加 `max-w-full + overflow-x-auto` 收住页面 —— 溢出没了，但把
 * "页面横滚"换成了"**控件内部横滚**"：设置页 8 个分段控件每个都要左右拖几下
 * 才看得全（实测默认视图那一排内容 421px 挤在 358px 里），用户的原话变成了
 * "设置那里超长移动"。滚动容器还吃掉了横向手势，滑起来像卡住。
 *
 * **现在（第三版）**：**永远是"装得下"的形状**，不给横滚。
 * - 容器 `inline-flex max-w-full` + `overflow-hidden`：宽度封顶，超出裁掉；
 * - 选项 `min-w-0 shrink truncate`：允许收缩并按需省略 —— 关键在于
 *   `min-w-0`，flex 子项默认 `min-width:auto`（= 内容宽度）时**根本不让收缩**；
 * - 完整文字放 `title`，缩小后仍可长按/悬停看到。
 *
 * 代价是极窄屏上长标签会被省略号截断（例如"这是一个特别长的分类名称…"）。
 * 这个代价是对的：**看到全部选项 + 一次点中**，比"字都完整但要点着拖动"重要。
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
  variant = 'pill',
}: SegmentedProps<T>) {
  const wrapper = `no-scrollbar inline-flex max-w-full gap-1 overflow-hidden bg-surface-sunk p-1 ${
    variant === 'pill' ? 'rounded-full' : 'rounded-md'
  }`;

  return (
    <div role="group" aria-label={ariaLabel} className={`${wrapper} ${className ?? ''}`}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={active}
            title={option.label}
            className={`inline-flex h-11 min-w-0 shrink items-center justify-center truncate rounded-full px-4 text-body-sm font-semibold
              transition-colors duration-short ease-standard ${
                active
                  ? 'bg-surface text-ink shadow-1'
                  : 'text-ink-2 hover:text-ink'
              }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
