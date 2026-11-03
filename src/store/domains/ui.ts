import type { AppAction } from '../actions';
import type { AppState } from '../../types';

/* ============================================================================
   UI 域：抽屉 / Toast / 保存状态 / 月历光标

   这一域的东西**全部不持久化**（见 types.ts 的 UIState 注释）。
   放一个文件里，是为了让"哪些状态不落盘"这件事有个物理边界 ——
   想往这里加一个需要持久化的字段时，会先被文件头这句拦住。
   ========================================================================= */

export function reduceUi(state: AppState, action: AppAction): AppState | null {
  switch (action.type) {
    case 'OPEN_DRAWER':
      return {
        ...state,
        ui: { ...state.ui, drawerTaskId: action.taskId, drawerReturnFocusId: action.returnFocusId },
      };

    case 'CLOSE_DRAWER':
      return { ...state, ui: { ...state.ui, drawerTaskId: null } };

    case 'SET_MONTH':
      return { ...state, ui: { ...state.ui, monthCursor: action.cursor } };

    case 'TOAST_SHOW':
      return { ...state, ui: { ...state.ui, toast: action.toast } };

    case 'TOAST_DISMISS':
      if (!state.ui.toast || state.ui.toast.id !== action.id) return state;
      return { ...state, ui: { ...state.ui, toast: null } };

    /**
     * 保存状态。
     *
     * 幂等检查不是微优化，是实打实的省一次全树渲染：
     * usePersist 每次数据变更都会 dispatch 一次 'saving'，而写盘是防抖的 ——
     * 打字时连续 20 个键就有 20 次「数据变更 + 状态变更」两次渲染。
     * 状态本来就是 'saving' 时直接返回同一个 state，React 会跳过这次更新。
     */
    case 'UI_SAVE_STATE': {
      const nextError = action.error === undefined ? state.ui.storageError : action.error;
      if (state.ui.saveState === action.saveState && state.ui.storageError === nextError) {
        return state;
      }
      return {
        ...state,
        ui: {
          ...state.ui,
          saveState: action.saveState,
          storageError: nextError,
        },
      };
    }

    default:
      return null;
  }
}
