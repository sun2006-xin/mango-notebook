import { useCallback } from 'react';
import { TOAST_TIMEOUT } from '../constants';
import { formatRelativeDay, nowIso } from '../lib/date';
import { planTaskMove } from '../lib/drag';
import type { DropTarget } from '../lib/drag';
import { useAppDispatch, useAppState } from '../store/StoreContext';
import { useToast } from './useToast';
import { useDragSort } from './useDragSort';
import type { DragSortApi } from './useDragSort';
import type { DateKey } from '../types';

/**
 * 「拖拽任务」在视图层的唯一接法。
 *
 * 抽出来的原因：周视图（拖到另一列 = 改日期）和今日视图（拖到某个位置 = 排序）
 * 是**同一个手势的两种落点**，提交逻辑却完全一样 ——
 * 各自写一遍就会出现"这边能撤销、那边不能"。
 *
 * 职责只有两件：把落点交给 reducer，以及给一条**可撤销**的 toast。
 */
export function useTaskDrag(today: DateKey): DragSortApi {
  const { tasks } = useAppState();
  const dispatch = useAppDispatch();
  const toast = useToast();

  const onCommit = useCallback(
    (id: string, target: DropTarget) => {
      const now = nowIso();
      const plan = planTaskMove(tasks, id, target, now);
      /** 落点无效 / 拖回原位 → 什么都不做（连 toast 都不弹，避免"点了没反应"的困惑变成噪音） */
      if (plan.moves.length === 0) return;

      dispatch({ type: 'TASK_MOVE', id, target, now });

      /**
       * 文案要区分"换了个日子"和"只在今天里调了顺序"：
       * 后者说"已移到 今天"是句废话，用户看不出发生了什么。
       */
      const self = plan.moves.find((move) => move.id === id);
      const movedDay = self ? self.from !== target.date : false;
      toast.show(
        movedDay ? `已移到${formatRelativeDay(target.date, today)}` : '已调整顺序',
        { label: '撤销', undo: { kind: 'drag', moves: plan.moves } },
        TOAST_TIMEOUT.undo,
      );
    },
    [tasks, dispatch, toast, today],
  );

  return useDragSort({ onCommit });
}
