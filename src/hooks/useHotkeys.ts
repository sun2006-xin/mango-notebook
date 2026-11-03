import { useEffect, useRef } from 'react';
import { VIEW_ORDER } from '../constants';
import type { ViewId } from '../types';

/* ============================================================================
   键盘快捷键（v0.26）

   桌面端最大的体验洼地：一个整天开着的应用，每次切页面都要把鼠标挪到左下角。
   这里只加**四个不打扰人的键**，刻意不做可配置、不做组合键：

     N    新建任务（跳到今日并聚焦输入框）
     /    搜索
     1–7  切到第 N 个视图（顺序就是底部导航的顺序）

   三条必须守住的边界，每条都对应一个用例：
   ① **正在打字时一律不响应**（input / textarea / select / contenteditable）——
      否则在日记里写「N」会跳出编辑区，这是快捷键最常见的翻车方式；
   ② **带 Ctrl / Cmd / Alt 的组合键不拦** —— 那些是浏览器和系统的地盘
      （Ctrl+N 新窗口、Cmd+/ 注释），抢了会显得应用很霸道；
   ③ **有浮层开着时不响应**（抽屉 / 搜索），否则按键会打到看不见的地方。

   为什么解析要单独抽成纯函数：键盘事件不好构造、时序也难测，
   而"这个键该干什么"本身是纯逻辑。UI 只负责把事件餵进去。
   ========================================================================= */

export type HotkeyAction =
  | { kind: 'new' }
  | { kind: 'search' }
  | { kind: 'view'; view: ViewId };

export interface HotkeyInput {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  /** 事件目标是否正在接收文字输入 */
  typing?: boolean;
  /** 已被别的处理器 preventDefault（尊重先手） */
  prevented?: boolean;
  /** 当前是否允许快捷键（有浮层时传 false） */
  enabled?: boolean;
}

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** 事件目标是不是"正在打字"的地方 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element || typeof element.tagName !== 'string') return false;
  if (TYPING_TAGS.has(element.tagName)) return true;
  // 富文本编辑器（记事本用的是 textarea，但别赌未来）
  return element.isContentEditable === true;
}

/** 按键 → 动作。返回 null = 这个键不归我们管，别 preventDefault */
export function resolveHotkey(input: HotkeyInput): HotkeyAction | null {
  if (input.enabled === false) return null;
  if (input.prevented) return null;
  if (input.typing) return null;
  if (input.ctrlKey || input.metaKey || input.altKey) return null;

  const key = String(input.key ?? '');
  const lower = key.toLowerCase();

  if (lower === 'n') return { kind: 'new' };
  if (key === '/') return { kind: 'search' };

  // 只认 1–9，且必须落在真实存在的视图上（VIEW_ORDER 只有 7 个）
  if (/^[1-9]$/.test(key)) {
    const view = VIEW_ORDER[Number(key) - 1];
    return view ? { kind: 'view', view } : null;
  }
  return null;
}

export interface HotkeyHandlers {
  onNew?: () => void;
  onSearch?: () => void;
  onView?: (view: ViewId) => void;
}

export interface HotkeyOptions {
  /** 有浮层（抽屉 / 搜索）时传 false */
  enabled?: boolean;
}

/**
 * 全局键盘监听。
 *
 * 监听器只注册一次（依赖数组为空）—— handler 与 enabled 都走 ref 读最新值。
 * 不然每次渲染都会解绑重绑，而键盘事件恰恰发生在两次渲染之间，
 * 重绑的瞬间按下的键会丢。
 */
export function useHotkeys(handlers: HotkeyHandlers, options: HotkeyOptions = {}): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const enabledRef = useRef(options.enabled !== false);
  enabledRef.current = options.enabled !== false;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const action = resolveHotkey({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        typing: isTypingTarget(event.target),
        prevented: event.defaultPrevented,
        enabled: enabledRef.current,
      });
      if (!action) return;

      const current = handlersRef.current;
      if (action.kind === 'new') {
        if (!current.onNew) return;
        event.preventDefault();
        current.onNew();
        return;
      }
      if (action.kind === 'search') {
        if (!current.onSearch) return;
        event.preventDefault();
        current.onSearch();
        return;
      }
      if (!current.onView) return;
      event.preventDefault();
      current.onView(action.view);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
