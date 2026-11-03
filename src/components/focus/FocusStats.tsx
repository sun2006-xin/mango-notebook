import { Icon } from '../common/Icon';
import { formatFocusDuration, sessionMs } from '../../lib/focus';
import type { FocusSession } from '../../types';

/* ============================================================================
   统计区的小零件：指标卡 + 今日明细行
   ----------------------------------------------------------------------------
   两个都是纯展示组件（只收 props），拆出来之后 FocusView 只剩"读数据 + 排版"。
   ========================================================================= */

export function StatCard({
 label,
 value,
 testId,
 icon,
}: {
 label: string;
 value: string;
 testId: string;
 icon?: 'flame';
}) {
 return (
 <div className="field px-3 py-2">
      <div className="flex items-center gap-1 text-label font-semibold text-ink-2">
        {icon ? <Icon name={icon} size={12} className="text-highlight" /> : null}
        {label}
      </div>
      <div data-testid={testId} className="mt-1 truncate text-body font-semibold text-ink">
        {value}
      </div>
    </div>
  );
}

export function SessionRow({
  session,
  title,
  onDelete,
}: {
  session: FocusSession;
  title: string;
  onDelete: () => void;
}) {
  const start = new Date(Date.parse(session.startedAt));
  const clock = `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`;
  return (
    <li className="flex items-center gap-2 px-3 py-2">
      <span className="tnum w-12 shrink-0 text-label text-ink-2">{clock}</span>
      <span className="min-w-0 flex-1 truncate text-body-sm text-ink">{title}</span>
      <span className="tnum shrink-0 text-body-sm font-semibold text-ink">
        {formatFocusDuration(sessionMs(session))}
      </span>
      <button
        type="button"
        onClick={onDelete}
        aria-label={`删除 ${clock} 的专注记录`}
        className="grid h-11 w-11 shrink-0 place-items-center rounded-md text-ink-3
          hover:bg-surface-sunk hover:text-danger"
      >
        <Icon name="close" size={14} />
      </button>
    </li>
  );
}
