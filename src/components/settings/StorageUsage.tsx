import { useMemo, useState } from 'react';
import { SCHEMA_VERSION, TOAST_TIMEOUT } from '../../constants';
import { useToast } from '../../hooks/useToast';
import { addDays } from '../../lib/date';
import { estimateStorageKb } from '../../lib/task';
import { useAppDispatch, useAppState } from '../../store/StoreContext';
import type { DateKey } from '../../types';

/* ============================================================================
   本地存储占用（自包含）

   从 SettingsView 抽出来的理由：这一块的逻辑（体积估算 / 分集合明细 /
   专注记录清理）只依赖 state 与 dispatch，和设置页其它部分没有耦合。
   抽出来之后设置页少了一个"读完 40 行才算明白它在干嘛"的段落，
   这一块也能独立演进（比如以后加"清理日记"）。

   ⚠️ 体积必须按**实际会写出去的全部字段**算：只算 tasks + settings 会低估，
   用户看到"12 KB"却写盘失败（配额满）时完全无法理解。
   ========================================================================= */

export interface StorageUsageProps {
  /** 当前"今天"（由 App 传入，视图不读时钟） */
  today: DateKey;
}

export function StorageUsage({ today }: StorageUsageProps) {
  const { tasks, settings, diary, tombstones, focusSessions, notes } = useAppState();
  const dispatch = useAppDispatch();
  const toast = useToast();
  const [confirmPrune, setConfirmPrune] = useState(false);

  const totalKb = useMemo(() => {
    const json = JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      tasks,
      settings,
      diary,
      tombstones,
      focusSessions,
      notes,
    });
    return estimateStorageKb(json);
  }, [tasks, settings, diary, tombstones, focusSessions, notes]);

  /**
   * 分集合占用：写满 5MB 时只有一句"本地空间不足"是不够的 ——
   * 占大头的往往是日记与专注记录这两块"看不见"的数据，得让用户看到该精简谁。
   */
  const breakdown = useMemo(() => {
    const kb = (value: unknown): number => estimateStorageKb(JSON.stringify(value));
    return [
      { key: 'tasks', label: '任务', kb: kb(tasks) },
      { key: 'diary', label: '日记', kb: kb(diary) },
      { key: 'notes', label: '记事', kb: kb(notes) },
      { key: 'focus', label: '专注记录', kb: kb(focusSessions) },
      { key: 'stones', label: '回收站', kb: kb(tombstones) },
    ].sort((a, b) => b.kb - a.kb);
  }, [tasks, diary, notes, focusSessions, tombstones]);

  /**
   * 专注记录清理：默认保留最近一年。
   * 不自动清 —— 专注记录是"我投入过多少时间"的证据，
   * 自动删等于替用户决定"这段历史不重要"。
   */
  const pruneBefore = useMemo(() => addDays(today, -365), [today]);
  const prunableCount = useMemo(
    () => focusSessions.filter((session) => session.date < pruneBefore).length,
    [focusSessions, pruneBefore],
  );

  return (
    <div className="flex w-full flex-wrap items-center gap-3">
      <div className="min-w-32 flex-1">
        <div className="text-body font-semibold">数据</div>
        <div className="mt-1 text-label text-ink-2">
          当前约 {totalKb} KB · 存于本机 localStorage 单 key（上限 5 MB）
        </div>
        <div data-testid="size-breakdown" className="mt-1 text-label text-ink-3">
          {breakdown.map((item) => `${item.label} ${item.kb} KB`).join(' · ')}
        </div>
      </div>
      <button
        type="button"
        data-testid="data-prune-focus"
        onClick={() => {
          if (!confirmPrune) {
            setConfirmPrune(true);
            return;
          }
          dispatch({ type: 'FOCUS_PRUNE', before: pruneBefore });
          setConfirmPrune(false);
          toast.show(`已清理 ${prunableCount} 条一年前的专注记录`, null, TOAST_TIMEOUT.info);
        }}
        disabled={prunableCount === 0 && !confirmPrune}
        className={`btn shrink-0 ${confirmPrune ? 'btn-danger' : 'btn-outlined'} disabled:opacity-40`}
      >
        {confirmPrune
          ? `确认清理 ${prunableCount} 条？再点一次`
          : prunableCount > 0
            ? `清理一年前的专注记录（${prunableCount}）`
            : '没有一年前的专注记录'}
      </button>
    </div>
  );
}
