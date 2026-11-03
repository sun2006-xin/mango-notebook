import fs from 'node:fs';
import path from 'node:path';
import type { CapacitorConfig } from '@capacitor/cli';

/**
 * 只在显式 Android 自建云模式下读取 `.env.local` 的 endpoint（Node 侧，Capacitor CLI 运行时用）。
 *
 * 为什么不用 import.meta.env：这个文件是给 Capacitor CLI 执行的 Node 脚本，
 * 不走 Vite 的 env 加载。默认客户端用 localhost；没有显式开启自建云时，
 * 不把项目方的 endpoint 写入 Android 壳配置。
 */
function readEnv(key: string): string {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '.env.local'), 'utf-8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const [k, v] = trimmed.split('=');
      if (k.trim() === key) return (v ?? '').trim();
    }
  } catch {
    /* 没有 .env.local = 开源构建 */
  }
  return '';
}

/**
 * Android 默认客户端不读取站点方的 endpoint，使用 localhost。
 * 只有自建云客户端显式设置 VITE_ANDROID_CLOUD_MODE=1 时，才用用户自己的 HTTPS origin。
 */
function resolveAndroidHost(): string {
  if (readEnv('VITE_ANDROID_CLOUD_MODE') !== '1') return 'localhost';

  const endpoint = readEnv('VITE_CLOUD_ENDPOINT');
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error('VITE_ANDROID_CLOUD_MODE=1 requires VITE_CLOUD_ENDPOINT to be an HTTPS origin.');
  }
  if (
    parsed.protocol !== 'https:' ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('VITE_ANDROID_CLOUD_MODE=1 requires VITE_CLOUD_ENDPOINT to be an HTTPS origin.');
  }
  return parsed.host;
}

const DEPLOY_HOST = resolveAndroidHost();

/**
 * Capacitor 配置（Android 原生壳）
 *
 * 两个关键决策：
 * 1. `webDir: 'dist-single'` —— 用 **singlefile 构建产物**，而不是标准产物。
 *    标准产物是 `<script type="module" src="./assets/index-xxx.js">`，
 *    在 WebView 的 file:// 环境下依赖"允许跨源访问文件"开关，不同 Android 版本行为不一致；
 *    singlefile 把 JS/CSS 全内联，从根上消除这类白屏风险。
 * 2. `server.androidScheme: 'https'` —— 让 WebView 跑在安全上下文里。
 *    默认的 `http` 或 `file` 下 localStorage 与 Service Worker 行为受限，
 *    而本应用的数据持久化完全依赖 localStorage，必须用 https 方案。
 */
const config: CapacitorConfig = {
  appId: 'cn.dailytodo.app',
  appName: '每日待办',
  webDir: 'dist-single',
  server: {
    androidScheme: 'https',
    /**
     * Default client builds use localhost and never inherit the developer's cloud endpoint.
     * A self-hosted Android build can opt in with VITE_ANDROID_CLOUD_MODE=1; then the
     * WebView origin matches that build's own HTTPS endpoint. This is an origin-routing
     * requirement, not an authorization boundary; the backend must enforce auth and RLS.
     */
    hostname: DEPLOY_HOST,
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;
