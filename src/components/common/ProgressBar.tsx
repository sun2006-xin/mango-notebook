import type { DayProgress } from '../../types';

export interface ProgressBarProps {
  done: number;
  total: number;
  /** total === 0 时为 null，UI 显示 '—' */
  percent: number | null;
  size?: 'xs' | 'sm' | 'md';
  /** 是否在右侧显示百分比文本 */
  showValue?: boolean;
  className?: string;
  ariaLabel?: string;
}

/**
 * 进度条：`transform: scaleX()` 补间（不走 width，避免逐帧重排）。
 * 数字用 `tabular-nums`，勾选时数字与条长同步前进。
 */
export function ProgressBar({
  done,
  total,
  percent,
  size = 'md',
  showValue = false,
  className,
  ariaLabel = '完成进度',
}: ProgressBarProps) {
  const ratio = percent === null ? 0 : Math.min(1, Math.max(0, percent / 100));

  return (
    <div className={`flex items-center gap-3 ${className ?? ''}`}>
      <div
        role="progressbar"
        aria-label={ariaLabel}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-valuetext={percent === null ? '无任务' : `已完成 ${done} / ${total}，${percent}%`}
        className={`relative w-full overflow-hidden rounded-full bg-ink/10 ${
          size === 'xs' ? 'h-0.5' : size === 'sm' ? 'h-1' : 'h-1.5'
        }`}
      >
        <div
          className="h-full w-full origin-left rounded-full bg-accent transition-transform duration-base ease-standard"
          style={{ transform: `scaleX(${ratio})` }}
        />
      </div>
      {showValue ? (
        <span className="tnum w-11 shrink-0 text-right text-body-sm font-medium text-ink-2">
          {percent === null ? '—' : `${percent}%`}
        </span>
      ) : null}
    </div>
  );
}

/** 便捷构造：从 DayProgress 直接渲染 */
export function ProgressFromDay({
  progress,
  size = 'md',
  showValue = false,
  className,
}: {
  progress: DayProgress;
  size?: 'xs' | 'sm' | 'md';
  showValue?: boolean;
  className?: string;
}) {
  return (
    <ProgressBar
      done={progress.done}
      total={progress.total}
      percent={progress.percent}
      size={size}
      showValue={showValue}
      className={className}
    />
  );
}
