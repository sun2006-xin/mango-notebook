/* ============================================================================
   桌面端自动备份的渲染侧封装

   纪律（与 lib/update.ts 的 desktopBridge 一致）：
   - **不静态假设桥存在**：网页 / 安卓上没有 `window.desktopBackup`，
     所有函数都先探测、探测不到就当"没有这个能力"返回 false / []；
   - **永不抛**：备份是锦上添花的能力，任何一步失败都不能影响用户继续用应用。
   ========================================================================= */

/** 备份目录里的一个文件 */
export interface LocalBackupEntry {
  /** 'YYYY-MM-DD.json' 或 'pre-restore.json' */
  name: string;
  size: number;
  /** mtime（毫秒） */
  mtime: number;
}

type Bridge = NonNullable<Window['desktopBackup']>;

/** 当前是否是"有备份桥"的环境（桌面端 exe） */
export function hasDesktopBackup(): boolean {
  try {
    const bridge = (globalThis as { desktopBackup?: Bridge }).desktopBackup;
    return typeof bridge?.write === 'function' && typeof bridge?.read === 'function';
  } catch {
    return false;
  }
}

/** 取桥；不存在返回 null（调用方据此降级，不要 try/catch 一把梭） */
export function desktopBackupBridge(): Bridge | null {
  try {
    const bridge = (globalThis as { desktopBackup?: Bridge }).desktopBackup;
    if (typeof bridge?.write !== 'function') return null;
    if (typeof bridge?.list !== 'function') return null;
    if (typeof bridge?.read !== 'function') return null;
    if (typeof bridge?.openDir !== 'function') return null;
    return bridge;
  } catch {
    return null;
  }
}

/**
 * 写一份备份。
 * @param json 完整载荷 JSON 字符串
 * @param name 目标文件名（必须过主进程白名单）；省略 = 当天日期
 */
export async function writeDesktopBackup(json: string, name?: string): Promise<boolean> {
  const bridge = desktopBackupBridge();
  if (!bridge) return false;
  try {
    const result = await bridge.write(name ? { json, name } : { json });
    return result?.ok === true;
  } catch {
    return false;
  }
}

/** 列出备份目录里的文件（新的在前）；无桥 / 失败返回 [] */
export async function listDesktopBackups(): Promise<LocalBackupEntry[]> {
  const bridge = desktopBackupBridge();
  if (!bridge) return [];
  try {
    const result = await bridge.list();
    if (!result?.ok || !Array.isArray(result.entries)) return [];
    return result.entries
      .filter(
        (entry): entry is LocalBackupEntry =>
          Boolean(entry) &&
          typeof entry.name === 'string' &&
          Number.isFinite(entry.size) &&
          Number.isFinite(entry.mtime),
      )
      .map((entry) => ({ name: entry.name, size: entry.size, mtime: entry.mtime }));
  } catch {
    return [];
  }
}

/** 读一份备份的原文；失败返回 null */
export async function readDesktopBackup(name: string): Promise<string | null> {
  const bridge = desktopBackupBridge();
  if (!bridge) return null;
  try {
    const result = await bridge.read(name);
    if (!result?.ok || typeof result.json !== 'string') return null;
    return result.json;
  } catch {
    return null;
  }
}

/** 在系统文件管理器里打开备份目录 */
export async function openDesktopBackupDir(): Promise<boolean> {
  const bridge = desktopBackupBridge();
  if (!bridge) return false;
  try {
    const result = await bridge.openDir();
    return result?.ok === true;
  } catch {
    return false;
  }
}
