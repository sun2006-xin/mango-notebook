import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ToastProvider } from './hooks/useToast';
import { StoreProvider } from './store/StoreContext';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('缺少挂载点 #root');

createRoot(container).render(
  <StrictMode>
    <StoreProvider>
      <ToastProvider>
        <App />
      </ToastProvider>
    </StoreProvider>
  </StrictMode>,
);

/**
 * Service Worker 注册 —— 只在生产构建里注册。
 *
 * 两个前提：
 * 1. 必须是 **安全上下文**（https 或 localhost）。`file://` 下 SW 不可用，
 *    所以单文件版（`build:file`）天然不受影响 —— 它本来就靠"零外链"做到双击可用。
 * 2. 只在 PROD 注册，避免开发时缓存住旧资源导致改了代码看不到效果。
 *
 * 注册失败一律静默：SW 只是"离线可打开"的增强，失败了应用照样能用，
 * 不能因为注册失败就打扰用户。
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
      .catch(() => {
        /* file:// 或不支持的环境：静默降级，不报错 */
      });
  });
}
