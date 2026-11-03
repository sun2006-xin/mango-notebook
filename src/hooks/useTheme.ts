import { useEffect, useState } from 'react';
import type { ThemeMode } from '../types';

type ResolvedTheme = 'light' | 'dark';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** theme-color 直接取当前 --rgb-paper 的值，避免在 TS 里写第二份色值 */
function applyMetaThemeColor(): void {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const paper = getComputedStyle(document.documentElement).getPropertyValue('--rgb-paper').trim();
  if (!paper) return;
  meta.setAttribute('content', `rgb(${paper.split(/\s+/).join(',')})`);
}

function readSystemDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(DARK_QUERY).matches
    : false;
}

function resolve(theme: ThemeMode, systemDark: boolean): ResolvedTheme {
  if (theme === 'system') return systemDark ? 'dark' : 'light';
  return theme;
}

/**
 * 主题解析：`'light' | 'dark' | 'system'` → 写 `data-theme`（CSS 变量随之切换）。
 * - `system` 下挂 matchMedia 监听，系统切换即时跟随
 * - 同步更新 `<meta name="theme-color">`
 * - 不写任何 `dark:` 变体，深浅色只靠 `[data-theme="dark"]` 覆盖变量（§7.1）
 */
export function useTheme(theme: ThemeMode): ResolvedTheme {
  const [systemDark, setSystemDark] = useState<boolean>(readSystemDark);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia(DARK_QUERY);
    const onChange = (event: MediaQueryListEvent): void => setSystemDark(event.matches);
    setSystemDark(mq.matches);
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
    mq.addListener(onChange);
    return () => mq.removeListener(onChange);
  }, []);

  const resolved = resolve(theme, systemDark);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolved);
    applyMetaThemeColor();
  }, [resolved]);

  return resolved;
}
