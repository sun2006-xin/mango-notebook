import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { TOAST_TIMEOUT } from '../constants';
import { useAppDispatch, useAppState } from '../store/StoreContext';
import type { ToastAction, ToastState } from '../types';

/* ============================================================================
   Toast 命令式 API
   状态本身落在 AppState.ui.toast（最多 1 条），Provider 只持有定时器。
   ========================================================================= */

export interface ToastApi {
  /** 展示一条 toast；重复调用会替换上一条并重播入场动画 */
  show: (
    message: string,
    action?: ToastAction | null,
    timeoutMs?: number,
    tone?: ToastState['tone'],
  ) => void;
  dismiss: () => void;
}

const ToastContext = createContext<ToastApi | null>(null);

let seq = 0;
function nextToastId(): string {
  seq += 1;
  return `toast_${Date.now().toString(36)}_${seq}`;
}

export function ToastProvider({ children }: { children: ReactNode }): ReactNode {
  const dispatch = useAppDispatch();
  const { ui } = useAppState();
  const toastId = ui.toast?.id ?? null;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback((): void => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const dismiss = useCallback((): void => {
    clearTimer();
    if (toastId) dispatch({ type: 'TOAST_DISMISS', id: toastId });
  }, [clearTimer, dispatch, toastId]);

  const show = useCallback<ToastApi['show']>(
    (message, action = null, timeoutMs = TOAST_TIMEOUT.info, tone = 'default') => {
      clearTimer();
      const id = nextToastId();
      const toast: ToastState = { id, message, tone, action, timeoutMs };
      dispatch({ type: 'TOAST_SHOW', toast });
      timer.current = setTimeout(() => {
        dispatch({ type: 'TOAST_DISMISS', id });
      }, timeoutMs);
    },
    [clearTimer, dispatch],
  );

  // 卸载时清掉定时器，避免对已卸载组件 dispatch
  useEffect(() => clearTimer, [clearTimer]);

  const api = useMemo<ToastApi>(() => ({ show, dismiss }), [show, dismiss]);

  return <ToastContext.Provider value={api}>{children}</ToastContext.Provider>;
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast 必须在 <ToastProvider> 内使用');
  return api;
}
