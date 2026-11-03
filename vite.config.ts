import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * 构建标识（版本号 + 源码哈希），由 `scripts/build_info.py` 生成。
 *
 * 注入前端后，界面能显示"当前是什么版本"，更新检查也有可比对的锚点。
 * 读不到时**不能抛**——开发时可能还没跑过 build_info，直接崩掉会把
 * `npm run dev` 也一起拖下水。回落成 'dev' 即可，说明"这是本地开发版"。
 */
function readBuildInfo(): { version: string; buildId: string; androidVersionCode: number } {
  try {
    const raw = fs.readFileSync(path.resolve(__dirname, 'build-info.json'), 'utf-8');
    const info = JSON.parse(raw);
    return {
      version: String(info.version),
      buildId: String(info.buildId),
      androidVersionCode: Number(info.androidVersionCode) || 0,
    };
  } catch {
    return { version: 'dev', buildId: 'dev', androidVersionCode: 0 };
  }
}

/**
 * 构建配置。两条交付路径见 ARCHITECTURE §1.4：
 * 1. `npm run build` → `npm run preview`：默认验收口径（http://localhost:4173）；
 * 2. `npm run build:file` → 双击 dist/index.html：把 JS/CSS 全内联，绕开
 *    `file://` 下外部 module 脚本被 CORS 拒绝执行导致的白屏。
 */
export default defineConfig(({ mode }) => {
  /** 客户端模式同样要**单文件**：APK 与桌面热更新都靠它（file:// 下多文件会被 CORS 拦） */
  const singlefile = mode === 'singlefile' || mode === 'client';
  const buildInfo = readBuildInfo();
  /**
   * CSP 白名单按**构建环境**注入。
   *
   * 为什么不能写死：这套代码要开源。写死的话，别人填了自己的云端域名，
   * 请求会被自己的 CSP 拦掉 —— 而且报错是"blocked by CSP"，很难联想到是模板的问题。
   * 没配置时替换成空串，CSP 退化为 `connect-src 'self'`（纯本地应用，正合适）。
   */
  const env = loadEnv(mode, process.cwd(), '');
  /**
   * `--mode client` = **客户端构建**（桌面 / 安卓）：整块清空云配置。
   * （不能用 `local` 当模式名：Vite 保留它给 `.env.local`，会直接报错）
   *
   * 官方发行的云登录只保留在网页版；默认桌面 / 安卓客户端是纯本地构建，
   * 不带项目方云配置，登录入口也会自动隐藏。用户需要自有云客户端时，
   * 必须显式用 `desktop:build:cloud` 并在本机配置自己的服务参数。
   */
  const localOnly = mode === 'client';
  const cloudEnv = localOnly
    ? { endpoint: '', oauthRelay: '', oauthOrigin: '', key: '', resourceId: '', shareCode: '' }
    : {
        endpoint: env.VITE_CLOUD_ENDPOINT ?? '',
        oauthRelay: env.VITE_CLOUD_OAUTH_RELAY ?? '',
        oauthOrigin: env.VITE_CLOUD_OAUTH_ORIGIN ?? '',
        key: env.VITE_CLOUD_KEY ?? '',
        resourceId: env.VITE_CLOUD_RESOURCE_ID ?? '',
        shareCode: env.VITE_SHARE_CODE ?? '',
      };
  const cspOrigins = [cloudEnv.endpoint, cloudEnv.oauthOrigin].filter(Boolean).join(' ');

  return {
    plugins: [
      react(),
      ...(singlefile ? [viteSingleFile()] : []),
      {
        name: 'csp-cloud-origins',
        transformIndexHtml(html: string) {
          return html.replaceAll('__CSP_CLOUD_ORIGINS__', cspOrigins);
        },
      },
    ],
    // 部署到子路径时资源不 404；也是 build:file 能用的前提之一
    base: './',
    define: {
      __APP_VERSION__: JSON.stringify(buildInfo.version),
      __BUILD_ID__: JSON.stringify(buildInfo.buildId),
      __ANDROID_VERSION_CODE__: JSON.stringify(buildInfo.androidVersionCode),
      __CLOUD_ENV__: JSON.stringify(cloudEnv),
    },
    build: {
      target: 'es2022',
      // 单文件模式下把所有资源（含字体/图标）内联进 bundle
      assetsInlineLimit: singlefile ? 100_000_000 : 4096,
      cssCodeSplit: !singlefile,
      sourcemap: false,
      reportCompressedSize: false,
    },
    server: { port: 5173, strictPort: true },
    preview: { port: 4173, strictPort: true },
  };
});
