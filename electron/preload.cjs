/* eslint-disable */
/**
 * 预加载脚本：把"更新相关"的能力有限地交给页面。
 *
 * 为什么必须有它：渲染进程开着 contextIsolation 且没有 Node 权限（这是对的），
 * 所以它没法自己下载文件、也没法重启应用。更新必须由主进程做，页面只能"请求"。
 *
 * 只暴露这 4 个方法 + 1 个进度订阅 —— 不暴露 `ipcRenderer` 本身。
 * 直接把 ipcRenderer 丢给页面等于把整个主进程的 IPC 面全开了。
 */
const { contextBridge, ipcRenderer } = require('electron');

/**
 * 窗口外观控制（与更新无关，单独一个桥，避免把"更新"这个概念撑大）。
 *
 * 自绘标题栏之后，右上角的最小化/最大化/关闭由渲染层画，主进程只负责执行动作。
 * 只暴露 4 个动作 + 1 个状态查询 + 1 个状态订阅 —— 不给 setBounds 之类
 * 能任意摆布窗口的能力：桥越窄，被页面脚本滥用的面越小。
 */
contextBridge.exposeInMainWorld('desktopWindow', {
  /** @deprecated 自绘按钮后不再需要，保留只为兼容旧版渲染层 */
  setOverlayColors: (color, symbolColor) =>
    ipcRenderer.invoke('window:setOverlayColors', { color, symbolColor }),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
  close: () => ipcRenderer.invoke('window:close'),
  getState: () => ipcRenderer.invoke('window:getState'),
  /** 最大化状态变化（双击标题栏 / 系统快捷键 / 任务栏还原）订阅；返回取消订阅函数 */
  /** 全局快捷键触发的「回到今日页」订阅；返回取消订阅函数 */
  onQuickAdd: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('shortcut:quickadd', handler);
    return () => {
      ipcRenderer.removeListener('shortcut:quickadd', handler);
    };
  },
  onStateChange: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('window:state', handler);
    return () => {
      ipcRenderer.removeListener('window:state', handler);
    };
  },
});

contextBridge.exposeInMainWorld('desktopUpdater', {
  /** 读取主进程缓存的上次检查结果（不联网） */
  getStatus: () => ipcRenderer.invoke('update:status'),
  /** 主动联网查一次 */
  check: () => ipcRenderer.invoke('update:check'),
  /** 下载已确认的新版本（不换入，重启后生效） */
  download: () => ipcRenderer.invoke('update:download'),
  /** 重启应用，让已下载的版本生效 */
  restart: () => ipcRenderer.invoke('update:restart'),
  /** 同步「自动检查更新」的用户偏好到主进程 */
  setAutoCheck: (enabled) => ipcRenderer.invoke('update:setAutoCheck', enabled),
  /** 下载进度订阅；返回取消订阅函数 */
  onProgress: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('update:progress', handler);
    return () => ipcRenderer.removeListener('update:progress', handler);
  },
});

/**
 * 自动备份（F4）—— **独立的一个桥**，不塞进 desktopUpdater。
 *
 * 两者的生命周期完全不同：更新是"联网、会重启应用"的动作，
 * 备份是"纯本地读文件"的动作。混在一个桥里，将来想给更新加白名单权限时
 * 会连带把备份的文件读写能力一起放出去。
 *
 * 只暴露 4 个方法；文件名白名单校验在主进程（backup-store.cjs）里做 ——
 * 渲染进程的入参一律不可信。
 */
contextBridge.exposeInMainWorld('desktopBackup', {
  /** 写一份备份。payload = { json, name? }；name 省略 = 当天日期 */
  write: (payload) => ipcRenderer.invoke('backup:write', payload),
  /** 列出备份目录里的文件 */
  list: () => ipcRenderer.invoke('backup:list'),
  /** 读一份备份（name 必须过白名单） */
  read: (name) => ipcRenderer.invoke('backup:read', name),
  /** 在系统文件管理器里打开备份目录 */
  openDir: () => ipcRenderer.invoke('backup:openDir'),
});
