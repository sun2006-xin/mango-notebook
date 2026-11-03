import { useCallback, useRef, useState } from 'react';
import type { TouchEvent as ReactTouchEvent } from 'react';

/**
 * 横向滑动手势（触摸设备）：右滑 → 完成，左滑 → 打开详情。
 *
 * 设计取舍：
 * - **不做跟手动画的 transition**：手指移动期间位移必须 1:1 跟手，
 *   只有松手回弹时才加 transition（`.swipe-surface--settling`），
 *   否则会出现"手指停住了但卡片还在飘"的延迟感。
 * - **纵向优先**：首次移动若 |dy| > |dx| 就判定为滚动，本次手势作废，
 *   避免把列表上下滑动误判成横向手势（这是侧滑删除最常见的误触来源）。
 * - 位移上限 88px：超过阈值后阻尼，暗示"再拖也到头了"。
 * - 阈值 56px：与 FAB 同尺寸，约为主流产品通行值。
 *
 * 触摸事件在桌面端不会触发，所以无需额外判断是否触摸设备。
 */

export interface SwipeOptions {
  /** 右滑（向 +x）触发 */
  onSwipeRight?: () => void;
  /** 左滑（向 -x）触发 */
  onSwipeLeft?: () => void;
  /**
   * 总开关。**拖拽进行中必须关掉它**：
   * 手指长按 380ms 会进入拖拽，而侧滑也是横向的 ——
   * 两者同时生效的话，把任务拖到周三的路上一松手，任务就被"右滑完成"了。
   * 关掉之后 onTouchMove / onTouchEnd 直接返回，手势作废但不影响其它行。
   */
  enabled?: boolean;
}

export interface SwipeResult {
  /** 当前位移（px，右正左负） */
  offset: number;
  /** 是否处于"松手回弹中"——回弹阶段才挂 transition */
  settling: boolean;
  handlers: {
    onTouchStart: (event: ReactTouchEvent) => void;
    onTouchMove: (event: ReactTouchEvent) => void;
    onTouchEnd: () => void;
  };
}

const THRESHOLD = 56;
const MAX_OFFSET = 88;
/** 超过阈值后的阻尼系数：位移越大越难继续拖 */
const DAMP = 0.35;

export function useSwipe({ onSwipeRight, onSwipeLeft, enabled = true }: SwipeOptions): SwipeResult {
  const [offset, setOffset] = useState(0);
  const [settling, setSettling] = useState(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  /** 本次手势是否已判定为纵向滚动——一旦判定，后续 move 全部忽略 */
  const cancelled = useRef(false);

  const onTouchStart = useCallback((event: ReactTouchEvent) => {
    const touch = event.touches[0];
    if (!touch) return;
    start.current = { x: touch.clientX, y: touch.clientY };
    cancelled.current = false;
    setSettling(false);
  }, []);

  const onTouchMove = useCallback(
    (event: ReactTouchEvent) => {
      const origin = start.current;
      const touch = event.touches[0];
      if (!enabled || !origin || !touch || cancelled.current) return;

      const dx = touch.clientX - origin.x;
      const dy = touch.clientY - origin.y;

      // 纵向优先：竖向位移更大 → 判定为滚动，放弃本次手势
      if (Math.abs(dy) > Math.abs(dx)) {
        cancelled.current = true;
        setOffset(0);
        return;
      }

      // 超出阈值后加阻尼，避免一行被拖到屏幕外
      const magnitude = Math.min(Math.abs(dx), MAX_OFFSET);
      const damped =
        Math.abs(dx) > THRESHOLD ? THRESHOLD + (Math.abs(dx) - THRESHOLD) * DAMP : magnitude;

      setOffset(dx < 0 ? -Math.min(damped, MAX_OFFSET) : Math.min(damped, MAX_OFFSET));
    },
    [enabled],
  );

  const onTouchEnd = useCallback(() => {
    const value = offset;
    start.current = null;
    setSettling(true);

    if (!enabled) {
      setOffset(0);
      return;
    }
    if (value >= THRESHOLD) {
      onSwipeRight?.();
    } else if (value <= -THRESHOLD) {
      onSwipeLeft?.();
    }
    setOffset(0);
  }, [offset, enabled, onSwipeRight, onSwipeLeft]);

  return {
    offset,
    settling,
    handlers: { onTouchStart, onTouchMove, onTouchEnd },
  };
}
