import { useEffect } from 'react';
import { shiftMonth } from '../lib/date';
import { useAppDispatch, useAppState } from '../store/StoreContext';

/** 输入类元素里不劫持方向键 / 空格 */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  return el.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]') !== null;
}

export interface KeyboardHandlers {
  /** 行内 Space：勾选/取消勾选 */
  onToggleRow: (id: string) => void;
  /** 行内 Enter：打开抽屉 */
  onOpenRow: (id: string) => void;
  /** 行内 Delete / Backspace：删除（带撤销） */
  onDeleteRow: (id: string) => void;
  /** Esc 关闭抽屉后归还焦点 */
  onCloseDrawer: () => void;
}

/**
 * 全局键位（M2-6）：
 * - `→ / ←` **按 view 分派**：周视图切周（SHIFT_WEEK ±1），其余切日（SHIFT_DATE ±1）
 * - 日历视图 `PageUp / PageDown` 切月（只动 monthCursor）
 * - `Esc` 关抽屉（焦点由 App 按 returnFocusId 归还）
 * - **行内键位**：当焦点正停在任务行本身（不是行内按钮）时，
 *   `Space` 勾选、`Enter` 开抽屉、`Delete/Backspace` 删除。
 *   放在这里而不是 TaskRow 的 onKeyDown，是为了让三处复用同一个 TaskRow 而不必
 *   每处各挂一份键位逻辑（也避免全局与行内各处理一次导致双触发）。
 * 抽屉打开时除 Esc 外一律不响应，避免背后列表被键盘改到。
 */
export function useKeyboard(handlers: KeyboardHandlers): void {
  const { settings, ui } = useAppState();
  const dispatch = useAppDispatch();
  const view = settings.lastView;
  const drawerOpen = ui.drawerTaskId !== null;
  const { monthCursor } = ui;
  const { onToggleRow, onOpenRow, onDeleteRow, onCloseDrawer } = handlers;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (isTypingTarget(event.target)) return;

      if (event.key === 'Escape') {
        if (drawerOpen) {
          event.preventDefault();
          onCloseDrawer();
          dispatch({ type: 'CLOSE_DRAWER' });
        }
        return;
      }
      if (drawerOpen) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        const delta: -1 | 1 = event.key === 'ArrowLeft' ? -1 : 1;
        event.preventDefault();
        if (view === 'week') dispatch({ type: 'SHIFT_WEEK', delta });
        else dispatch({ type: 'SHIFT_DATE', delta });
        return;
      }

      if (view === 'calendar' && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault();
        dispatch({ type: 'SHIFT_WEEK', delta: event.key === 'ArrowUp' ? -1 : 1 });
        return;
      }

      if (view === 'calendar' && (event.key === 'PageUp' || event.key === 'PageDown')) {
        event.preventDefault();
        dispatch({
          type: 'SET_MONTH',
          cursor: shiftMonth(monthCursor, event.key === 'PageUp' ? -1 : 1),
        });
        return;
      }

      // 行内键位：必须焦点就在行本身，避免从行内「…」按钮上误触发
      const active = document.activeElement as HTMLElement | null;
      const row = active?.closest?.('[data-task-id]') as HTMLElement | null;
      if (!row || row !== active) return;
      const id = row.dataset.taskId;
      if (!id) return;

      if (event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault();
        onToggleRow(id);
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        onOpenRow(id);
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        onDeleteRow(id);
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
    // 四个回调由 useTaskActions 用 useCallback 稳定提供，逐个进依赖即可
  }, [dispatch, drawerOpen, monthCursor, view, onToggleRow, onOpenRow, onDeleteRow, onCloseDrawer]);
}
