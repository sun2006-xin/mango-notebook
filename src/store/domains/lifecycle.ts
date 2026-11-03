import { createDefaultSettings } from '../../constants';
import { todayKey } from '../../lib/date';
import type { AppAction } from '../actions';
import type { AppState } from '../../types';

/* ============================================================================
   生命周期域：整包装载（HYDRATE）与全清（DATA_CLEAR_ALL）

   只有这两个 action 会**同时**碰所有集合 —— 它们不属于任何一个业务域，
   所以单独一档。放在这里还有一个好处：想加一个"会清掉/覆盖全部数据"的
   action 时，必须先打开这个文件，看到下面的注释。
   ========================================================================= */

export function reduceLifecycle(state: AppState, action: AppAction): AppState | null {
  switch (action.type) {
    case 'HYDRATE':
      return {
        tasks: action.tasks,
        // 不传 diary 时**保留**现有日记 —— 宁可不动，也不静默清空
        diary: action.diary ?? state.diary,
        // 墓碑同理：不传就保留。静默清空 = 被删过的任务在对端集体复活
        tombstones: action.tombstones ?? state.tombstones,
        // 专注记录同理
        focusSessions: action.focusSessions ?? state.focusSessions,
        // 记事本同理：不传就保留
        notes: action.notes ?? state.notes,
        settings: action.settings,
        // 装载完成 = 门控打开（原生 hydration 结束后 children 才挂载）
        ui: {
          ...state.ui,
          storageError: action.storageError,
          hydrating: false,
          // 超时兜底装载：数据没读出来，内存里是空态 → 禁止落盘，别把盘上那份盖了
          persistBlocked: action.persistBlocked === true,
        },
      };

    case 'DATA_CLEAR_ALL': {
      const fresh = createDefaultSettings(todayKey());
      return {
        ...state,
        tasks: [],
        // 「清空全部数据」连日记一起清（用户明确要求的全清）
        diary: [],
        // 记事本同理：全清之后不该有任何残留
        notes: [],
        // 墓碑同样清干净：全清之后不该再有"这条被删过"的残留
        tombstones: [],
        /**
         * 专注记录也必须清。
         * 它同样是"用户产生的内容"：说好的是全清，却留下一整年的学习时长，
         * 既不符合预期，也是隐私问题（换手 / 出二手设备时最容易漏掉的一类数据）。
         */
        focusSessions: [],
        settings: { ...fresh, theme: state.settings.theme },
        ui: { ...state.ui, stickyDoneIds: [], drawerTaskId: null, toast: null },
      };
    }

    default:
      return null;
  }
}
