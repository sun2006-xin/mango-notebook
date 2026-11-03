import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { edgeScrollVelocity, resolveDropTarget, sameDropTarget } from '../lib/drag';
import type { DropBox, DropGeometry, DropTarget } from '../lib/drag';
import type { DateKey } from '../types';

/* ============================================================================
   拖拽排序 / 改日期 —— 交互层（本项目唯一涉及 DOM 的拖拽代码）

   为什么不直接用 HTML5 的 `draggable`：它在**触摸设备上完全不工作**
   （Android WebView / iOS Safari 都不派发 dragstart），而这个应用一半的
   使用场景是 APK。自己走 Pointer Events 才能一份代码覆盖鼠标与手指。

   为什么不用第三方库：只用到"改日期 + 列表内插入"两件事，
   引入 dnd-kit 会带来一整套 sensor / collision 概念，而这里的落点判定
   已经被压成了纯函数 `resolveDropTarget`（可单测），库反而更难验证。

   DOM 约定（由 TaskRow 负责渲染）：
   - 可拖的行：`data-drag-id`（任务 id）+ `data-drag-date`（归属日）
   - 可接的列：`data-drop-day`（日期）
   本 hook 只按这两个属性量矩形，其它一概不关心。
   ========================================================================= */

/** 鼠标：位移超过这么多 px 判定为拖拽。点击几乎不会移动 6px，所以点开抽屉不受影响 */
const MOUSE_THRESHOLD = 6;
/** 触摸：长按生效**之前**移动超过这么多 px → 判定为滚动，放弃本次拖拽 */
const TOUCH_CANCEL_DISTANCE = 8;
/** 触摸：按住这么久才进入拖拽（长按）。与侧滑手势（快速横滑）天然错开 */
const TOUCH_HOLD_MS = 380;

interface Session {
  id: string;
  pointerId: number;
  element: HTMLElement;
  startX: number;
  startY: number;
  touch: boolean;
  active: boolean;
  timer: number | null;
  latest: DropTarget | null;
  /** 最近一次指针坐标：自动滚动的每一帧都要用它重算落点（手指可能没动） */
  lastX: number;
  lastY: number;
  raf: number | null;
  /**
   * 缓存下来的几何。
   *
   * 为什么必须缓存：`readGeometry` 里是 `querySelectorAll` + 每行一次
   * `getBoundingClientRect()`，而 `getBoundingClientRect` 会**强制同步布局**。
   * 原来每次 pointermove 都重新量一遍（60–120 次/秒 × 列表长度次强制回流），
   * 五十条任务的列表一拖就掉帧 —— 而且中间还夹着 setState 引起的重渲。
   *
   * 拖拽期间页面**只会因为自动滚动而移动**（手指的滚动已经被 preventDefault 挡掉），
   * 所以量一次就够，只在自动滚动真正滚了之后作废。
   */
  geo: DropGeometry | null;
  dispose: (() => void) | null;
}

export interface DragSortOptions {
  /** 松手且落点有效时回调。由调用方 dispatch —— hook 不认识 store */
  onCommit: (id: string, target: DropTarget) => void;
}

export interface DragSortApi {
  /** 正在被拖的任务 id（给行加半透明；同时用于关掉这一行的侧滑手势） */
  draggingId: string | null;
  /** 当前落点（给视图画指示线 / 高亮列） */
  dropTarget: DropTarget | null;
  /**
   * **引用稳定**的 pointerdown 处理器。
   * TaskRow 是 memo 的，每次渲染换一个新函数会让整列失去 memo 的意义 ——
   * 所以任务 id 不从闭包传，而是从 DOM 上的 `data-drag-id` 读。
   */
  onRowPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
}

/** 把 DOM 上标了属性的元素量成矩形，交给纯函数判定 */
function readGeometry(draggedId: string): DropGeometry {
  const days: DropBox[] = [];
  const rows: DropBox[] = [];

  document.querySelectorAll<HTMLElement>('[data-drop-day]').forEach((element) => {
    const date = element.dataset.dropDay;
    if (!date) return;
    const rect = element.getBoundingClientRect();
    days.push({
      key: date,
      date: date as DateKey,
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
    });
  });

  document.querySelectorAll<HTMLElement>('[data-drag-id]').forEach((element) => {
    const id = element.dataset.dragId;
    const date = element.dataset.dragDate;
    if (!id || !date) return;
    const rect = element.getBoundingClientRect();
    rows.push({
      key: id,
      date: date as DateKey,
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
    });
  });

  return { days, rows, draggedId };
}

/** 吞掉拖拽结束后紧跟着的那次 click（否则松手就弹出抽屉） */
function swallowNextClick(): void {
  const swallow = (event: MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
  };
  document.addEventListener('click', swallow, { capture: true, once: true });
  // 若这次拖拽没有产生 click（例如落点无效被取消），下一轮事件就撤掉监听
  window.setTimeout(() => document.removeEventListener('click', swallow, true), 0);
}

/**
 * 请求动画帧（带降级）。
 * 有些环境（比如没开 pretendToBeVisual 的 jsdom）没有 rAF，
 * 直接调用会在拖拽生效那一刻抛错 —— 拖拽整个挂掉，比滚不动严重得多。
 */
function requestFrame(callback: () => void): number {
  if (typeof window.requestAnimationFrame === 'function') {
    return window.requestAnimationFrame(callback);
  }
  return window.setTimeout(callback, 16);
}

function cancelFrame(handle: number): void {
  if (typeof window.cancelAnimationFrame === 'function') {
    window.cancelAnimationFrame(handle);
    return;
  }
  window.clearTimeout(handle);
}

/** 滚动一屏的量。不支持滚动的环境（jsdom）里安静地什么都不做 */
function scrollByY(delta: number): void {
  try {
    window.scrollBy(0, delta);
  } catch {
    /* 忽略：没有滚动能力的环境不该让拖拽崩掉 */
  }
}

/**
 * 拖拽会话。
 *
 * 状态机只有三态：**待定 → 生效 → 结束**。
 * - 待定：鼠标要移动够 6px；手指要按住 380ms（期间移动 >8px 就放弃，让位给滚动）。
 * - 生效：捕获指针、禁止页面滚动、按坐标实时算落点。
 * - 结束：松手 → 有落点就提交；取消（pointercancel / 判定为滚动）→ 什么都不做。
 */
export function useDragSort({ onCommit }: DragSortOptions): DragSortApi {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  const session = useRef<Session | null>(null);
  const commitRef = useRef(onCommit);
  useEffect(() => {
    commitRef.current = onCommit;
  }, [onCommit]);

  /** 拖拽生效期间禁止页面跟着手指滚（非 passive 才能 preventDefault） */
  const blockScroll = useRef<((event: TouchEvent) => void) | null>(null);

  const finish = useCallback((commit: boolean) => {
    const current = session.current;
    if (!current) return;
    const { id, latest, active } = current;
    current.dispose?.();
    /**
     * **只在真拖过之后才重置状态**。
     *
     * 原来无条件 `setDraggingId(null)` + `setDropTarget(null)` —— 哪怕只是一次
     * 普通点击（pointerdown → pointerup，从未生效）也会走这两句，
     * 于是点一下任务行就多一次整表重渲（TodayView 是整棵子树）。
     * 列表长了以后，"点开任务"这个最频繁的动作会明显发涩。
     */
    if (active) {
      setDraggingId(null);
      setDropTarget(null);
    }
    if (commit && active && latest) {
      swallowNextClick();
      commitRef.current(id, latest);
    }
  }, []);

  const onRowPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      // 只响应主键：鼠标右键 / 中键不该拖任务
      if (event.button !== 0) return;
      if (session.current) return;
      /**
       * 表单控件上按下不启动拖拽。
       * 勾选框、时间框这些"按下去就要立刻响应"的控件，如果同时进入拖拽待定态，
       * 手指一抖（>8px）就会被判成滚动、勾选失效 —— 交互上非常黏。
       */
      const origin = event.target as HTMLElement | null;
      if (origin?.closest('input, textarea, select, a')) return;

      const element = event.currentTarget as HTMLElement;
      const id = element.dataset.dragId;
      if (!id) return;

      const touch = event.pointerType === 'touch';
      const current: Session = {
        id,
        pointerId: event.pointerId,
        element,
        startX: event.clientX,
        startY: event.clientY,
        touch,
        active: false,
        timer: null,
        latest: null,
        lastX: event.clientX,
        lastY: event.clientY,
        raf: null,
        geo: null,
        dispose: null,
      };
      session.current = current;

      /** 取（必要时刷新）几何缓存 */
      const geometry = (): DropGeometry => {
        if (!current.geo) current.geo = readGeometry(current.id);
        return current.geo;
      };

      /**
       * 边缘自动滚动的循环。
       *
       * 为什么要重算落点：自动滚动会改变**所有行的位置**，而手指可能一动不动
       * （就是贴着屏幕下沿停住）。只靠 pointermove 的话，页面滚上去了、
       * 落点却还停在滚动之前算出来的那一行 —— 松手会落到错的地方。
       */
      const pump = () => {
        const live = session.current;
        if (!live || !live.active) return;
        const velocity = edgeScrollVelocity(live.lastY, 0, window.innerHeight);
        if (velocity !== 0) {
          scrollByY(velocity);
          // 页面真的滚了 → 缓存作废，重新量一次
          live.geo = null;
          const next = resolveDropTarget(geometry(), live.lastX, live.lastY);
          if (!sameDropTarget(next, live.latest)) {
            live.latest = next;
            setDropTarget(next);
          }
        }
        live.raf = requestFrame(pump);
      };

      const activate = () => {
        if (!session.current || session.current.active) return;
        session.current.active = true;
        if (!blockScroll.current) {
          const handler = (native: TouchEvent) => native.preventDefault();
          blockScroll.current = handler;
          document.addEventListener('touchmove', handler, { passive: false });
        }
        /**
         * ⚠️ 指针捕获**只能在拖拽真正生效之后**做，绝不能在 pointerdown 里做。
         *
         * 为什么（这是 v0.19/v0.20 里最难发现的一个 P0）：
         * Pointer Events 规范规定，捕获生效期间**兼容性鼠标事件也会重定向**到
         * 捕获元素。于是 pointerup 的目标变成整行 `.swipe`，浏览器据它算出
         * `click` 的目标 = 行（而不是里面那个 `role="button"` 的 div）——
         * **那个 div 上的 onClick 永远不触发，任务抽屉再也打不开**。
         * 抽屉是任务唯一的编辑入口 → 用户看到的就是"任务无法编辑"。
         * 而 jsdom 里 `setPointerCapture` 是空实现，这条在单测里根本复现不出来。
         *
         * 现在的做法：pointerdown 时什么都不捕获、监听挂 document（点击照常命中），
         * 只有"真的开始拖了"才捕获 —— 那时候我们本来就要吞掉紧随的 click。
         * 捕获只为了指针移出窗口/划出元素时仍能收到 move。
         */
        try {
          current.element.setPointerCapture(current.pointerId);
        } catch {
          /* 指针可能已经失效（NotFoundError）—— 捕获失败不影响拖拽，move 仍由 document 收到 */
        }
        setDraggingId(current.id);
        current.raf = requestFrame(pump);
      };

      const onMove = (native: PointerEvent) => {
        const live = session.current;
        if (!live || native.pointerId !== live.pointerId) return;
        live.lastX = native.clientX;
        live.lastY = native.clientY;
        const dx = native.clientX - live.startX;
        const dy = native.clientY - live.startY;

        if (!live.active) {
          const distance = Math.abs(dx) + Math.abs(dy);
          if (live.touch) {
            // 长按还没生效就动了 → 用户是想滚动列表，不是想拖
            if (distance > TOUCH_CANCEL_DISTANCE) finish(false);
            return;
          }
          if (distance < MOUSE_THRESHOLD) return;
          activate();
        }

        // 落点判定**不需要**重新测量：拖拽期间只有自动滚动会改变布局
        const next = resolveDropTarget(geometry(), native.clientX, native.clientY);
        if (!sameDropTarget(next, live.latest)) {
          live.latest = next;
          setDropTarget(next);
        }
      };

      const onUp = (native: PointerEvent) => {
        if (!session.current || native.pointerId !== session.current.pointerId) return;
        finish(true);
      };

      const onCancel = () => finish(false);

      current.dispose = () => {
        if (current.timer !== null) {
          window.clearTimeout(current.timer);
          current.timer = null;
        }
        if (current.raf !== null) {
          cancelFrame(current.raf);
          current.raf = null;
        }
        /**
         * 监听挂在 **document** 上（不是行元素）—— 见下面 `setPointerCapture` 那段注释：
         * 早期版本把监听挂在行上并一开始就捕获指针，结果所有点击都被重定向、
         * 抽屉打不开。挂 document 之后，指针跑到哪里都能收到 move/up。
         */
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onCancel);
        if (blockScroll.current) {
          document.removeEventListener('touchmove', blockScroll.current);
          blockScroll.current = null;
        }
        if (element.hasPointerCapture?.(current.pointerId)) {
          try {
            element.releasePointerCapture(current.pointerId);
          } catch {
            /* 指针已经不存在了（抬手后才清理）—— 没有可释放的东西，忽略 */
          }
        }
        session.current = null;
      };

      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onCancel);

      if (touch) {
        current.timer = window.setTimeout(() => {
          current.timer = null;
          activate();
        }, TOUCH_HOLD_MS);
      }
    },
    [finish],
  );

  /** 卸载时兜底撤掉监听，避免组件被切走后还挂着 touchmove */
  useEffect(
    () => () => {
      session.current?.dispose?.();
    },
    [],
  );

  return { draggingId, dropTarget, onRowPointerDown };
}
