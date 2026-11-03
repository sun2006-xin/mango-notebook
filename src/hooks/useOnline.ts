import { useEffect, useState } from 'react';
import { isBrowserOffline } from '../lib/network';

/* ============================================================================
   在线状态（供 UI 显示"离线"）
   ----------------------------------------------------------------------------
   `navigator.onLine` 有两个坑，这个 hook 都绕开了：

   ① **它不会引起 React 重渲染**：只在属性变化时默默变值，必须自己听
      `online` / `offline` 两个事件；
   ② `onLine === true` **不代表**能连上（连了 WiFi 但没出口、认证门户、
      公司代理都会误报）。所以 UI 上只把它当"**确定离线**"的信号用，
      绝不显示"已在线"这种肯定语 —— 那会在门户网络下撒谎。

   初始值取 `isBrowserOffline()`（而不是 false）：冷启动断网时不该先闪一下"在线"。
   ========================================================================= */

export function useOnline(): boolean {
  const [online, setOnline] = useState(() => !isBrowserOffline());

  useEffect(() => {
    const goOnline = (): void => setOnline(true);
    const goOffline = (): void => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    // 事件可能在首次渲染前就发生过，挂载时对齐一次
    setOnline(!isBrowserOffline());
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  return online;
}
