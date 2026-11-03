import { useEffect, useState } from 'react';

/* ============================================================================
   断点：TaskRow 的 showCategory / showTime 是"父级传 false"的语义（§5.3），
   而 Tailwind 只能管 CSS display，管不了"要不要渲染/要不要传 true"，
   所以这里用 JS 读同一组断点，保证 DOM 与视觉一致。

   断点与 Tailwind 默认刻度对齐：md=768（周视图 7 列/堆叠的分界）、lg=1024（侧栏/底部 Tab）。
   ========================================================================= */

export interface Breakpoints {
  /** <420：隐藏分类 Chip */
  isNarrow420: boolean;
  /** <360：连时间文字一起收起，只留高优先级竖条 */
  isNarrow360: boolean;
  /**
   * <640（Tailwind 的 sm 以下）：任务行**不渲染**「开始专注 ▷」。
   *
   * 为什么不用 CSS 隐藏：手机上那行本来就只有 44px 的勾选框 + 标题 + 时间，
   * 再塞一个 hover 才浮现的按钮，触摸设备上既看不见也点不到（没有 hover）。
   * 入口在抽屉里（点任务行 → 底部「开始专注」），所以这里直接不渲染。
   */
  isMobile: boolean;
  /** 768–1023：周视图仍 7 列但压缩（字号降级、隐藏时间） */
  isTablet: boolean;
  /** ≥1024：侧栏形态 */
  isDesktop: boolean;
}

const QUERY = {
  narrow420: '(max-width: 419.98px)',
  narrow360: '(max-width: 359.98px)',
  mobile: '(max-width: 639.98px)',
  tablet: '(min-width: 768px) and (max-width: 1023.98px)',
  desktop: '(min-width: 1024px)',
} as const;

const FALLBACK: Breakpoints = {
  isNarrow420: false,
  isNarrow360: false,
  isMobile: false,
  isTablet: false,
  isDesktop: true,
};

/** 同步读取当前断点（首帧用，避免"先全量列再收窄"的闪动） */
function readBreakpoints(): Breakpoints {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return FALLBACK;
  const matches = (query: string): boolean => window.matchMedia(query).matches;
  return {
    isNarrow420: matches(QUERY.narrow420),
    isNarrow360: matches(QUERY.narrow360),
    isMobile: matches(QUERY.mobile),
    isTablet: matches(QUERY.tablet),
    isDesktop: matches(QUERY.desktop),
  };
}

function isSame(a: Breakpoints, b: Breakpoints): boolean {
  return (
    a.isNarrow420 === b.isNarrow420 &&
    a.isNarrow360 === b.isNarrow360 &&
    a.isMobile === b.isMobile &&
    a.isTablet === b.isTablet &&
    a.isDesktop === b.isDesktop
  );
}

export function useBreakpoint(): Breakpoints {
  // 注意：useState(readBreakpoints) 是惰性初始化，首帧就是正确值
  const [breakpoints, setBreakpoints] = useState<Breakpoints>(readBreakpoints);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;

    const apply = (): void => {
      setBreakpoints((prev) => {
        const next = readBreakpoints();
        return isSame(prev, next) ? prev : next;
      });
    };

    /**
     * 断点变化本身由浏览器按阈值合并，直接 apply 即可；
     * 只有 window.resize 可能高频触发，才需要去抖。
     *
     * 这里**不用 requestAnimationFrame**：隐藏 iframe / 后台标签页下 rAF 会被节流或
     * 完全暂停，一旦用它做调度，断点会长期停在旧值（表现为"明明 320 宽了却还显示分类 Chip"）。
     */
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const onResize = (): void => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(apply, 80);
    };

    const lists = Object.values(QUERY).map((query) => window.matchMedia(query));
    lists.forEach((list) => list.addEventListener('change', apply));
    window.addEventListener('resize', onResize);
    apply();

    return () => {
      lists.forEach((list) => list.removeEventListener('change', apply));
      window.removeEventListener('resize', onResize);
      if (resizeTimer) clearTimeout(resizeTimer);
    };
  }, []);

  return breakpoints;
}
