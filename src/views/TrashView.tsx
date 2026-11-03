import { useMemo, useState } from 'react';
import { Icon } from '../components/common/Icon';
import { TOMBSTONE_KEEP_DAYS } from '../constants';
import { useAppDispatch, useAppState } from '../store/StoreContext';
import { dateKey, diffDays, formatDateTitle, formatRelativeDay } from '../lib/date';
import type { DateKey, TaskTombstone } from '../types';

export interface TrashViewProps {
  today: DateKey;
}

/**
 * 回收站。
 *
 * 这里列的不是"已删除的任务副本"，而是**墓碑**（tombstones）——
 * 同步协议里"删除"这个动作唯一的载体。所以：
 * - 恢复 = 移除墓碑 + 把任务插回原位（否则下次合并又会被删掉）；
 * - 清空 = 真的把墓碑丢掉，**不可逆**：对端若还留着旧副本，下次同步会把它们带回来。
 *   所以清空要做二次确认。
 */
export function TrashView({ today }: TrashViewProps) {
  const { tombstones } = useAppState();
  const dispatch = useAppDispatch();
  const [confirming, setConfirming] = useState(false);

  const rows = useMemo(
    () => [...tombstones].sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : -1)),
    [tombstones],
  );

  const onRestore = (id: string): void => {
    dispatch({ type: 'TOMBSTONE_RESTORE', id, now: new Date().toISOString() });
  };

  const onClear = (): void => {
    dispatch({ type: 'TOMBSTONE_CLEAR' });
    setConfirming(false);
  };

  return (
    <section aria-labelledby="trashTitle" className="flex flex-col">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 id="trashTitle" className="text-h1 font-bold leading-h1 tracking-[-0.02em]">
          回收站
        </h1>
        <div className="flex items-center gap-2">
          <span className="tnum text-label text-ink-2">{rows.length} 条</span>
          <button
            type="button"
            onClick={() => dispatch({ type: 'SET_VIEW', view: 'settings' })}
            className="btn btn-outlined"
          >
            返回设置
          </button>
        </div>
      </div>

      <p className="mt-3 field px-3 py-2 text-label leading-relaxed text-ink-2">
 删除的任务会在这里保留 {TOMBSTONE_KEEP_DAYS} 天，超期自动清理。
 恢复会把任务原样放回原来的日期。
 </p>
 {rows.length === 0 ? (
 <p className="mt-6 text-label text-ink-2">回收站是空的。</p>
      ) : (
        <>
          <ul className="mt-4 flex flex-col divide-y divide-line field">
 {rows.map((stone) => (
 <TrashRow
 key={stone.id}
 stone={stone}
 today={today}
 onRestore={() => onRestore(stone.id)}
 />
 ))}
 </ul>
 <div className="mt-4 flex items-center justify-end gap-2">
            {confirming ? (
              <>
                <span className="text-label text-danger">
                  清空后无法恢复，确定吗？
                </span>
                <button type="button" onClick={() => setConfirming(false)} className="btn btn-outlined">
                  取消
                </button>
                <button
                  type="button"
                  data-testid="trash-clear-confirm"
                  onClick={onClear}
                  className="btn btn-danger"
                >
                  确定清空
                </button>
              </>
            ) : (
              <button
                type="button"
                data-testid="trash-clear"
                onClick={() => setConfirming(true)}
                className="btn btn-outlined text-danger"
              >
                <Icon name="trash" size={14} />
                清空回收站
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function TrashRow({
  stone,
  today,
  onRestore,
}: {
  stone: TaskTombstone;
  today: DateKey;
  onRestore: () => void;
}) {
  /**
   * 剩余保留天数：让用户知道"再不管就真没了"。
   * deletedAt 是 UTC ISO 串，**必须先转本地日再比较** ——
   * 直接 slice(0,10) 在 GMT+8 会把"今天 07:00 删的"算成昨天。
   */
  const deletedDay = dateKey(new Date(stone.deletedAt));
  const age = Math.max(0, diffDays(today, deletedDay));
  const left = Math.max(0, TOMBSTONE_KEEP_DAYS - age);

  return (
    <li className="flex items-center gap-2 px-3 py-2">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body text-ink">{stone.title || '（无标题）'}</span>
        <span className="truncate text-label text-ink-2">
          原定 {formatDateTitle(stone.date)} · 删除于 {formatRelativeDay(deletedDay, today)}
        </span>
      </span>
      <span className="tnum shrink-0 text-label text-ink-3">{left} 天</span>
      <button
        type="button"
        onClick={onRestore}
        data-testid={`trash-restore-${stone.id}`}
        className="btn btn-outlined shrink-0"
      >
        恢复
      </button>
    </li>
  );
}
