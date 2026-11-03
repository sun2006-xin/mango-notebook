/**
 * 构建期注入的全局常量（见 `vite.config.ts` 的 define 与 `scripts/build_info.py`）。
 *
 * 它们在打包时被替换成字面量，运行时不存在对应的变量 ——
 * 所以这里只能声明、不能赋值。
 */
declare const __APP_VERSION__: string;
declare const __BUILD_ID__: string;
/** 安卓的 versionCode（构建时从 build.gradle 读入），仅用于判断安装包新旧 */
declare const __ANDROID_VERSION_CODE__: number;

/** 无边框窗口的外观控制（由 electron/preload.cjs 注入，仅桌面端存在） */
interface Window {
  desktopWindow?: {
    /** @deprecated 自绘标题栏后不再使用，保留只为兼容旧版渲染层 */
    setOverlayColors: (color: string, symbolColor: string) => Promise<boolean>;
    minimize: () => Promise<boolean>;
    toggleMaximize: () => Promise<boolean>;
    close: () => Promise<boolean>;
    getState: () => Promise<{
      maximized: boolean;
      /** true = 本次运行换了本地服务端口，localStorage 的域跟着变了（旧数据/登录态可能读不到） */
      storageDegraded?: boolean;
    }>;
    onStateChange: (callback: (payload: { maximized: boolean }) => void) => () => void;
    /** 全局快捷键（Ctrl+Shift+Space）触发：回到今日页 */
    onQuickAdd: (callback: () => void) => () => void;
  };
  /**
   * 自动备份桥（由 electron/preload.cjs 注入，仅桌面端存在）。
   *
   * 与 `desktopUpdater` **分开一个桥**：更新是联网 + 会重启应用的动作，
   * 备份是纯本地读文件，权限与生命周期完全不同，混在一起会让
   * "只给更新加白名单"时连带放开备份的文件读写能力。
   * 文件名白名单在主进程侧校验（electron/backup-store.cjs），这里只是形状。
   */
  desktopBackup?: {
    /** 写一份备份；name 省略 = 当天日期（每天一份，同一天覆盖） */
    write: (payload: {
      json: string;
      name?: string;
    }) => Promise<{ ok: boolean; name?: string; size?: number; error?: string }>;
    list: () => Promise<{
      ok: boolean;
      dir?: string;
      entries?: { name: string; size: number; mtime: number }[];
      error?: string;
    }>;
    read: (name: string) => Promise<{ ok: boolean; name?: string; json?: string; error?: string }>;
    openDir: () => Promise<{ ok: boolean; dir?: string; error?: string }>;
  };
}

/**
 * 构建期注入的云配置（由 vite.config.ts 的 `define` 塞进来）。
 *
 * 为什么不用 `import.meta.env` 直接读：需要一个"整块清空"的开关 ——
 * 桌面端与安卓是**纯本地应用**，构建时（`--mode local`）把这六项全部置空，
 * 于是产物里连一个字符的凭据都没有，登录入口也自然消失。
 * 用单个对象注入，比逐个 key 打补丁更难漏。
 */
declare const __CLOUD_ENV__: {
  endpoint: string;
  oauthRelay: string;
  oauthOrigin: string;
  key: string;
  resourceId: string;
  shareCode: string;
};
