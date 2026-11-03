import { STATUS_LABEL } from '../../constants';
import { formatDateTitle } from '../../lib/date';
import type { DateKey, DayCell, DayStatus } from '../../types';

export interface MonthGridProps {
  cells: DayCell[];
  statusMap: Map<DateKey, DayStatus>;
  selected: DateKey | null;
  /** `${year}-${month}`，变化时重播转场动画 */
  transitionKey: string;
  onSelect: (key: DateKey) => void;
}

/**
 * 四态标记：形状可区分（不只靠颜色）——
 * 3px 方点 / 8px 实心圆 / 半填充环 / 空心环。尺寸在 index.css 的 .mk-* 配方里。
 */
export function StatusMarker({ status }: { status: DayStatus }) {
  if (status === 'none-done') {
    return (
      <span className="mk" aria-hidden="true">
        <span className="mk-solid" />
      </span>
    );
  }
  if (status === 'partial') {
    return (
      <span className="mk" aria-hidden="true">
        <span className="mk-partial" />
      </span>
    );
  }
  if (status === 'all-done') {
    return (
      <span className="mk" aria-hidden="true">
        <span className="mk-ring" />
      </span>
    );
  }
  return (
    <span className="mk" aria-hidden="true">
      <span className="mk-dot" />
    </span>
  );
}

/**
 * 月历 6×7 网格（M2-7）：固定 42 格（行高稳定不跳动），周一/周日起由调用方的 cells 决定。
 * 点格只回调 onSelect（父级只更新摘要，不跳视图）。
 */
export function MonthGrid({ cells, statusMap, selected, transitionKey, onSelect }: MonthGridProps) {
  return (
    <div key={transitionKey} className="mt-1 grid animate-fadeUp grid-cols-7 gap-2">
      {cells.map((cell) => {
        const status = statusMap.get(cell.key) ?? 'empty';
        const isSelected = cell.key === selected;
        return (
          <button
            key={cell.key}
            type="button"
            data-day={cell.key}
            data-status={status}
            aria-selected={isSelected}
            aria-label={`${formatDateTitle(cell.key)}，${STATUS_LABEL[status]}`}
            onClick={() => onSelect(cell.key)}
            className={`flex min-h-16 min-w-0 flex-col items-center justify-center gap-1 rounded-md border p-1
              transition-colors duration-short ease-standard ${
                cell.inMonth ? 'border-line bg-surface' : 'border-transparent bg-transparent'
              } ${cell.isToday ? 'border-accent' : ''} ${
                isSelected ? 'cal-selected border-accent bg-accent-soft' : ''
              } hover:border-ink-3`}
          >
            <span
              className={`tnum text-body-sm font-semibold leading-none ${
                cell.isToday || isSelected
                  ? 'text-accent'
                  : cell.inMonth
                    ? 'text-ink'
                    : 'text-ink-3 opacity-55'
              }`}
            >
              {cell.day}
            </span>
            <StatusMarker status={status} />
          </button>
        );
      })}
    </div>
  );
}
