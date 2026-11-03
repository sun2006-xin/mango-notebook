import { Icon } from './Icon';
import type { ToastState } from '../../types';

export interface ToastProps {
  toast: ToastState | null;
  onAction: () => void;
  onDismiss: () => void;
}

/**
 * 单条 Toast（最多 1 条，由 store 的 ui.toast 保证）。
 * - `aria-live="polite"`，不抢焦点
 * - 带 action 时按钮 ≥44 高度（h-11）
 * - 以 `key={toast.id}` 重播入场动画：连续 show 会替换而不是叠加
 */
export function Toast({ toast, onAction, onDismiss }: ToastProps) {
  if (!toast) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex justify-center px-4 lg:bottom-5">
      <div
        key={toast.id}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="pointer-events-auto flex max-w-full animate-toastIn items-center gap-2 rounded-full bg-ink py-1 pl-5 pr-1 text-paper shadow-2"
      >
        <span className="truncate text-body-sm font-medium">{toast.message}</span>
        {toast.action ? (
          <button
            type="button"
            onClick={onAction}
            className="inline-flex h-11 shrink-0 items-center rounded-full bg-accent px-4 text-body-sm font-bold text-accent-on"
          >
            {toast.action.label}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onDismiss}
          aria-label="关闭提示"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-paper/70 hover:text-paper"
        >
          <Icon name="close" size={15} />
        </button>
      </div>
    </div>
  );
}
