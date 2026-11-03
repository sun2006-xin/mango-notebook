import { DIARY_MAX } from '../../constants';
import { isValidDateKey } from '../../lib/date';
import type { AppAction } from '../actions';
import { sortDiary } from '../helpers';
import type { AppState, DiaryEntry, Note } from '../../types';
/* ============================================================================
   内容域：日记 / 记事本 / 专注记录

   这三样都是"用户产出的长篇内容"，共同点是**删除必须软删除**：
   直接 filter 掉条目，另一台还留着副本的设备一合并就把它带回来。
   日记与本子的墓碑形态不同（日记靠空 content + updatedAt，记事同理），
   但语义一致，所以放在同一个文件里，读的人能一眼对上。
   ========================================================================= */

export function reduceContent(state: AppState, action: AppAction): AppState | null {
  switch (action.type) {
    case 'DIARY_UPSERT': {
      const content = action.content.slice(0, DIARY_MAX);
      const existing = state.diary.find((entry) => entry.date === action.date);
      const entry: DiaryEntry = existing
        ? { ...existing, content, updatedAt: action.now }
        : { date: action.date, content, createdAt: action.now, updatedAt: action.now };
      return {
        ...state,
        diary: sortDiary([...state.diary.filter((e) => e.date !== action.date), entry]),
      };
    }

    case 'DIARY_DELETE': {
      const existing = state.diary.find((entry) => entry.date === action.date);
      // 本来就没写过：不需要留墓碑，直接不动（也避免无谓的一次保存）
      if (!existing) return state;
      const tombstone: DiaryEntry = { ...existing, content: '', updatedAt: action.now };
      return {
        ...state,
        diary: sortDiary([...state.diary.filter((e) => e.date !== action.date), tombstone]),
      };
    }

    /**
     * 记事本：新建 / 编辑（按 id 区分）。
     * updatedAt 一律用调用方传入的 `now` —— 和任务的处理一致，
     * 保证同样的输入必得同样的输出（可单测、可回放）。
     *
     * content 非空即视为"活着"：把软删除的那条编辑出新内容 = 复活，
     * 靠 updatedAt 新者胜在合并里自然生效（见 NOTE_DELETE）。
     */
    case 'NOTE_UPSERT': {
      const existing = state.notes.find((note) => note.id === action.note.id);
      const note: Note = { ...action.note, updatedAt: action.now };
      return {
        ...state,
        notes: existing
          ? state.notes.map((n) => (n.id === note.id ? note : n))
          : [{ ...note, createdAt: action.now }, ...state.notes],
      };
    }

    /**
     * 删记事 —— **软删除**（内容置空 + updatedAt 打点），不把条目移除。
     *
     * 为什么不清掉：任务是靠墓碑活下来的，记事没有"被删过"的凭据，
     * 而从数组里 filter 掉之后，另一台还留着这条的设备一合并就把它带回来 ——
     * 用户删了三次还在。置空后这条 id 仍是一个比任何正文都新的版本，
     * 合并时 updatedAt 新者胜 → 删除状态同样能同步到别的设备。
     * UI 列表与全局搜索都过滤掉 content 为空的条目，对用户就是"删掉了"。
     *
     * 代价是条目本身留在载荷里（几字节级），换来的是删除能同步。
     * 日记（`DIARY_DELETE`）用的是同一套软删除语义。
     */
    case 'NOTE_DELETE':
      return {
        ...state,
        notes: state.notes.map((note) =>
          note.id === action.id ? { ...note, content: '', updatedAt: action.now } : note,
        ),
      };

    /**
     * 记一段专注。同 id 直接忽略（幂等）—— 网络重放或连点会制造重复时长，
     * 而这类数据错了用户基本发现不了。
     */
    case 'FOCUS_LOG': {
      if (!action.session || typeof action.session.id !== 'string' || !action.session.id) {
        return state;
      }
      if (state.focusSessions.some((session) => session.id === action.session.id)) {
        return state;
      }
      return { ...state, focusSessions: [action.session, ...state.focusSessions] };
    }

    /** 删掉一条专注记录（记错了 / 误开），按 id 精确移除 */
    case 'FOCUS_DELETE': {
      if (!state.focusSessions.some((session) => session.id === action.id)) return state;
      return {
        ...state,
        focusSessions: state.focusSessions.filter((session) => session.id !== action.id),
      };
    }

    case 'FOCUS_PRUNE': {
      const { before } = action;
      if (!isValidDateKey(before)) return state;
      const watermark = state.settings.focusPrunedBefore;
      /**
       * 水位线**只增不减**：已经清理到 2025-10 了，再来一次 2026-01 的清理
       * 应该继续往后推；反过来（更早的 before）直接忽略，
       * 否则一旦回退，云端已经"应该删掉"的记录会被并回来。
       */
      if (watermark && watermark >= before) return state;
      return {
        ...state,
        focusSessions: state.focusSessions.filter((session) => session.date >= before),
        // 水位线是 settings 字段，但它和这次清理是**同一个事务**，不能拆成两次更新
        settings: { ...state.settings, focusPrunedBefore: before },
      };
    }

    default:
      return null;
  }
}
