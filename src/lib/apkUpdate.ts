/* ============================================================================
   应用内安装 APK（安卓）

   为什么需要：原来点「更新」是打开**系统浏览器**下载，用户下完还得去通知栏或
   文件管理器找那个 apk 再点一下 —— 小米/华为的文件管理器经常把下载的包藏得很深。
   现在改成应用内下载（带进度）→ 直接调起系统安装器。

   ⚠️ 能做到的边界：**下载全自动，安装必须用户点一次**。
   Android 8.0 起禁止应用静默安装侧载 APK，这是平台规则，绕不过去。

   ⚠️ 不静态 import `@capacitor/core`（三端各省 12–15 KB，见 lib/storage.ts 的说明）。
   这里走**鸭子类型**：真机上的 `window.Capacitor` 是 Capacitor 注入的全局对象，
   `Plugins.ApkInstaller` 由原生侧注册（见 android/.../ApkInstallerPlugin.java）。
   Web / 桌面端没有这个全局对象 → 返回 null → 调用方回落到"浏览器下载"。
   ========================================================================= */

export type ApkInstallOutcome =
  /** 已调起系统安装器（用户还要点一下「安装」） */
  | 'opened-installer'
  /** 缺少「安装未知应用」权限，已把用户送到系统开关页 */
  | 'needs-permission'
  /** 当前不是安卓原生环境（网页 / 桌面 / 老版本壳）→ 调用方应回落到浏览器 */
  | 'unsupported'
  /** 下载或调起失败 → 调用方应回落到浏览器 */
  | 'failed';

interface ApkInstallerBridge {
  download(options: { url: string }): Promise<{ ok?: boolean; needsPermission?: boolean } | undefined>;
  addListener(
    event: 'progress',
    callback: (payload: { done: number; total: number }) => void,
  ): Promise<{ remove?: () => Promise<void> } | void>;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  Plugins?: Record<string, unknown>;
}

/** 拿到原生插件；不是安卓原生环境（或插件没注册）时返回 null */
function apkBridge(): ApkInstallerBridge | null {
  const cap = (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
  if (!cap || typeof cap.isNativePlatform !== 'function') return null;

  let native = false;
  try {
    native = cap.isNativePlatform();
  } catch {
    native = false;
  }
  if (!native) return null;

  const plugin = cap.Plugins?.ApkInstaller as ApkInstallerBridge | undefined;
  return plugin && typeof plugin.download === 'function' ? plugin : null;
}

/** 这台设备能不能走应用内安装（UI 据此决定按钮文案） */
export function isInAppApkInstallAvailable(): boolean {
  return apkBridge() !== null;
}

/**
 * 下载并调起安装器。
 *
 * 进度回调**不做节流**：原生侧已经按 120ms 节流过了，这里再节一次
 * 只会让进度条一顿一顿的。
 */
export async function downloadAndInstallApk(
  url: string,
  onProgress?: (done: number, total: number) => void,
): Promise<ApkInstallOutcome> {
  const plugin = apkBridge();
  if (!plugin) return 'unsupported';
  if (typeof url !== 'string' || !url) return 'failed';

  let handle: { remove?: () => Promise<void> } | void = undefined;
  try {
    if (onProgress) {
      handle = await plugin.addListener('progress', (payload) => {
        onProgress(payload.done, payload.total);
      });
    }
  } catch {
    /* 监听不上不影响下载本身，只是没有进度条 */
  }

  try {
    const result = await plugin.download({ url });
    if (result?.needsPermission) return 'needs-permission';
    return result?.ok ? 'opened-installer' : 'failed';
  } catch {
    return 'failed';
  } finally {
    try {
      const removable = handle;
      if (removable && typeof removable.remove === 'function') await removable.remove();
    } catch {
      /* 移除失败不影响结果 */
    }
  }
}
