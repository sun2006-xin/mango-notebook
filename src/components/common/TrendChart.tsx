import type { TrendPoint } from '../../lib/task';

export interface TrendChartProps {
  /** 由旧到新的趋势点（buildCompletionTrend 的输出） */
  points: TrendPoint[];
}

/**
 * 完成率趋势柱状图（纯 SVG，不引图表库）。
 *
 * 约定：
 * - 柱子越高完成率越高；`percent === null`（那天没有任务）画成贴底的一条细线，
 *   颜色最淡 —— 一眼能看出"休息日"，而不是误读成 0%；
 * - 最后一根（今天）加粗描边，让"现在"有锚点。
 */
export function TrendChart({ points }: TrendChartProps) {
  if (points.length === 0) return null;

  const slot = 20;
  const chartHeight = 36;
  const barWidth = 12;
  const last = points.length - 1;

  return (
    <svg
      viewBox={`0 0 ${points.length * slot} 40`}
      className="h-10 w-full"
      preserveAspectRatio="none"
      role="img"
      aria-label="最近每日完成率"
    >
      {points.map((point, index) => {
        const hasData = point.percent !== null;
        const height = hasData ? Math.max(2, (point.percent as number) / 100 * chartHeight) : 2;
        const x = index * slot + (slot - barWidth) / 2;
        const y = 40 - height;
        return (
          <rect
            key={point.date}
            x={x}
            y={y}
            width={barWidth}
            height={height}
            rx={2}
            className={hasData ? 'fill-accent' : 'fill-ink-3'}
            opacity={hasData ? 0.35 + ((point.percent as number) / 100) * 0.65 : 0.25}
            stroke={index === last ? 'currentColor' : 'none'}
            strokeWidth={index === last ? 1 : 0}
          />
        );
      })}
    </svg>
  );
}
