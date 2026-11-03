import type { ReactNode } from 'react';

/* ============================================================================
   环形进度（计时器的视觉主体）
   ----------------------------------------------------------------------------
   从 `views/FocusView.tsx`（746 行）拆出来：它只是一个 SVG 圆环 + 数字容器，
   没有状态、不碰 store，却能单独预览与复用（秒表 / 提醒两个模式共用同一圈）。
   ========================================================================= */

/** 毫秒 → mm:ss（计时器主数字，向上取整到秒） */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** 环形进度条半径/周长（SVG 单位） */
const RING_R = 86;
const RING_C = 2 * Math.PI * RING_R;

/** 复用同款环形：外圈底 + 内圈按 progress 填充 */
export function Ring({ progress, muted, children }: { progress: number; muted?: boolean; children: ReactNode }) {
  const clamped = Math.min(1, Math.max(0, progress));
  return (
    <div className="relative grid place-items-center">
      <svg width="200" height="200" viewBox="0 0 200 200" aria-hidden="true" className="-rotate-90">
        <circle cx="100" cy="100" r={RING_R} fill="none" strokeWidth="10" className="stroke-line" />
        <circle
          cx="100"
          cy="100"
          r={RING_R}
          fill="none"
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={RING_C}
          strokeDashoffset={RING_C * (1 - clamped)}
          className={muted ? 'stroke-ink-3' : 'stroke-highlight'}
          style={{ transition: 'stroke-dashoffset 250ms linear' }}
        />
      </svg>
      <div className="absolute flex flex-col items-center">{children}</div>
    </div>
  );
}

/* ============================================================================
   番茄钟面板：把现有计时器区块原样搬进来，保留所有 data-testid
   ========================================================================= */
