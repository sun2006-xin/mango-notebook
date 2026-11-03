/* 分享码同样来自构建环境（见 .env.example）；开源构建为空 → 更新检查整体短路 */
import { publicConfig } from './cloud';
import { getLocalStorage } from './storage';

/* ============================================================================
   在线更新 · 前端侧
   ----------------------------------------------------------------------------
   分工：**桌面端不由这里负责**。
   桌面端的更新在主进程完成（electron/updater.cjs）—— 它要写文件、要比对 sha256，
   而且从 127.0.0.1 去请求发布域名会被 CORS 拦住。所以桌面端这里只展示版本号。

   网页端与安卓端则同源（安卓 WebView 的 origin 就是发布域名），
   直接用相对路径取清单即可。
   ========================================================================= */

export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
export const BUILD_ID = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';
/** 当前安装包的 versionCode（安卓判断新旧只认它） */
export const ANDROID_VERSION_CODE =
  typeof __ANDROID_VERSION_CODE__ === 'number' ? __ANDROID_VERSION_CODE__ : 0;

/**
 * 发布站点的访问码。
 *
 * ⚠️ 这个托管环境**所有路径都要 sharecode 才放行** —— 实测不带参数时
 * 连 `/icons/icon-192.png` 都返回 403。所以更新清单与安装包的请求都必须带上它，
 * 否则自动更新会静默地永远失败（表现是"检查更新"一直报错）。
 *
 * 它本来就印在分享链接里，不是机密。
 *
 * ⚠️ **单一真相 = `package.json` 的 `shareCode` 字段**（v0.17 起）。
 * 以前这里和 `electron/updater.cjs` 各手写一份，换站点漏改一处
 * 就是"自动更新静默全失败"——而且没有任何测试会发现。
 * 现在：渲染层 import 这个字段；主进程读 asar 内 package.json 的同名字段
 * （`release_desktop.py` 在打包时注入）。改分享码只改 package.json 一个地方。
 */
export const SHARE_CODE = __CLOUD_ENV__.shareCode;

/** 给站内任意地址补上 sharecode */
export function withShareCode(url: string): string {
  return appendParam(url, 'sharecode', SHARE_CODE);
}

/**
 * 往 URL 追加一个查询参数，**自己判断用 ? 还是 &**。
 *
 * 为什么单独抽出来：曾经在这里手写过 `${MANIFEST_URL}?t=${Date.now()}`，
 * 而 `MANIFEST_URL` 本身已经带了 `?sharecode=...` —— 拼出来是
 * `...?sharecode=YOUR_SHARE_CODE?t=1759...`，服务端把整串当 sharecode 的值，
 * 判为无效直接 403。表现就是手机上点「检查更新」永远显示
 * **「检查失败（可能未联网）」**，而网络明明是好的。
 *
 * 这类 bug 的共同点：手写字符串拼接时"这个 URL 里有没有问号"是个隐含前提，
 * 而它取决于调用顺序（先加 sharecode 还是先加时间戳）。只要有一个函数
 * 负责拼接，前提就不存在了。
 */
export function appendParam(url: string, key: string, value: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(value)}`;
}

/** 清单地址：与网页版同域，随站点一起发布 */
const MANIFEST_URL = withShareCode(`${publicConfig.endpoint}/update/version.json`);

export type UpdatePlatform = 'desktop' | 'android' | 'web';

export function detectPlatform(): UpdatePlatform {
  const caps = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  if (caps && typeof caps.isNativePlatform === 'function' && caps.isNativePlatform()) return 'android';
  const host = typeof location !== 'undefined' ? location.hostname : '';
  if (host === '127.0.0.1' || host === 'localhost') return 'desktop';
  return 'web';
}

export interface UpdateInfo {
  /** 是否有比本机更新的版本 */
  available: boolean;
  version: string;
  buildId: string;
  /** 安卓安装包完整地址（仅安卓端有值） */
  apkUrl: string | null;
  apkSize: number;
}

interface Manifest {
  version?: string;
  buildId?: string;
  android?: { url?: string; size?: number; versionCode?: number };
}

/**
 * 查询线上清单并判断要不要更新。
 *
 * **两端用的判据不一样，这是刻意的：**
 * - 网页端比 `buildId`（源码哈希）——页面永远从服务器现取，只要代码变了就该刷新；
 * - 安卓端比 `versionCode`——APK 换不换只由安装包版本决定。
 *   如果拿网页 buildId 去比：只发网页版（没重打 APK）时线上 buildId 变了、
 *   APK 里还是旧的，就会**永远提示"有新版本"、点进去下载的还是同一个包**，死循环。
 */
export async function checkForUpdate(platform: UpdatePlatform): Promise<UpdateInfo> {
  /**
   * 没有部署（开源构建的默认状态）就**不发请求**。
   *
   * 两个值任一为空都算"没有部署"：`SHARE_CODE` 是分享链接的门禁参数，
   * `endpoint` 是托管域名。开源版两者都没有 —— 若照常去 fetch，
   * 每次启动都会打一条 404 到控制台，用户会以为程序坏了。
   */
  if (!SHARE_CODE || !publicConfig.endpoint) {
    return { available: false, version: '', buildId: '', apkUrl: null, apkSize: 0 };
  }

  // 时间戳必须走 appendParam：MANIFEST_URL 已经带了 sharecode（见上面那段注释）
  const response = await fetch(appendParam(MANIFEST_URL, 't', String(Date.now())), {
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  const manifest = (await response.json()) as Manifest;

  const remoteBuild = manifest.buildId || '';
  const remoteCode = Number(manifest.android?.versionCode) || 0;
  const available =
    platform === 'android'
      ? remoteCode > ANDROID_VERSION_CODE
      : Boolean(remoteBuild) && remoteBuild !== BUILD_ID;

  const apkRel = manifest.android?.url;

  return {
    available,
    version: manifest.version || '未知',
    buildId: remoteBuild,
    apkUrl: apkRel ? withShareCode(`${publicConfig.endpoint}/update/${apkRel}`) : null,
    apkSize: manifest.android?.size || 0,
  };
}

/**
 * 安卓端拉起安装包下载。
 *
 * 走系统浏览器而不是 WebView 内下载：WebView 拿到 apk 也装不上（需要 Intent），
 * 而浏览器下载完成后系统会自己弹出安装器，并且会引导用户打开「安装未知应用」，
 * 这条路最稳、不需要额外原生插件，也不会因为权限被静默拦掉。
 */
export function openApkDownload(url: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noreferrer noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export function formatSize(bytes: number): string {
  if (!bytes) return '';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

/* ============================================================================
   桌面端桥（由 electron/preload.cjs 注入）
   ----------------------------------------------------------------------------
   桌面端不能像网页那样直接 fetch + reload：它要从 127.0.0.1 跨源取文件、
   还要能重启应用 —— 这两件事只有主进程做得到。所以桌面的更新走 IPC，
   页面只负责"问"和"点"。
   ========================================================================= */

export interface DesktopUpdateStatus {
  available: boolean;
  version: string;
  buildId: string;
  localBuildId: string;
  checkedAt: number;
  error: string | null;
  staged: boolean;
}

export interface DesktopUpdaterBridge {
  getStatus: () => Promise<DesktopUpdateStatus>;
  check: () => Promise<DesktopUpdateStatus>;
  download: () => Promise<{ ok: boolean; version?: string; reason?: string }>;
  restart: () => void;
  setAutoCheck: (enabled: boolean) => Promise<boolean>;
  onProgress: (cb: (p: { done: number; total: number }) => void) => () => void;
}

export function desktopBridge(): DesktopUpdaterBridge | null {
  const bridge = (globalThis as { desktopUpdater?: DesktopUpdaterBridge }).desktopUpdater;
  return bridge && typeof bridge.getStatus === 'function' ? bridge : null;
}

/* ---- "以后再说" 的记忆 ---- */

const SKIP_KEY = 'dt:update:skipped';

/**
 * 用户选择跳过的构建 ID。
 *
 * 记的是 **buildId 而不是版本号**：这样"同一个版本"只烦他一次；
 * 等真的出了下一个版本，横幅会再次出现 —— 既尊重选择，又不会让他永远错过更新。
 */
export function getSkippedBuildId(): string {
  try {
    return getLocalStorage()?.getItem(SKIP_KEY) || '';
  } catch {
    return '';
  }
}

/**
 * 「自动检查更新」的用户偏好。
 *
 * 故意**不放进 PersistedPayload**（那是跨设备同步的数据），而是本机独立的键：
 * 更不喜欢不喜欢自动更新是**这台设备**的事 —— 手机上想开、电脑上想关，都合理。
 * 塞进同步数据反而会让两台设备互相覆盖对方的偏好，还得动那套"改五处"纪律。
 */
export function isAutoUpdateEnabled(): boolean {
  try {
    return getLocalStorage()?.getItem('dt:update:autoEnabled') !== '0';
  } catch {
    return true; // 读不到就默认开 —— 更新检查是安全且必要的
  }
}

export function setAutoUpdateEnabled(on: boolean): void {
  try {
    getLocalStorage()?.setItem('dt:update:autoEnabled', on ? '1' : '0');
  } catch {
    /* 存不了就以内存里的值为准，重启后回到默认 */
  }
}

export function skipBuildId(buildId: string): void {
  try {
    getLocalStorage()?.setItem(SKIP_KEY, buildId);
  } catch {
    /* 存储不可用时就当没记住，下次再问一遍也无伤大雅 */
  }
}
