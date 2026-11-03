import { useCallback, useMemo, useState } from 'react';
import { TOAST_TIMEOUT } from '../../constants';
import { useToast } from '../../hooks/useToast';
import { downloadAndInstallApk, isInAppApkInstallAvailable } from '../../lib/apkUpdate';
import {
  APP_VERSION,
  BUILD_ID,
  checkForUpdate,
  detectPlatform,
  desktopBridge,
  formatSize,
  isAutoUpdateEnabled,
  openApkDownload,
  setAutoUpdateEnabled,
  type UpdateInfo,
} from '../../lib/update';

/* ============================================================================
   「版本与更新」区块

   从 1565 行的 SettingsView 里搬出来的第一块 —— 挑它当第一块是因为它
   **自带全部状态**（检查结果 / 自动检查开关 / 平台判定），不与设置页别的
   逻辑共享任何东西，搬走之后两边都不会互相牵扯。

   这里的三条端差异要留着别"优化"掉：
   - 桌面端不在这里查更新：主进程负责（要写文件 + 绕 CORS），
     网页端查了会得到"有新版但装不上"的假提示；
   - 安卓能应用内安装就直接装（覆盖安装保留数据），装不了才退化成下载；
   - 网页端没有安装概念，只有"刷新到新版"。
   ========================================================================= */

export function UpdateSection() {
  const toast = useToast();
  const platform = useMemo(() => detectPlatform(), []);
  const [updateState, setUpdateState] = useState<'idle' | 'checking' | 'latest' | 'available' | 'error'>(
    'idle',
  );
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [autoUpdate, setAutoUpdate] = useState(() => isAutoUpdateEnabled());

  const onCheckUpdate = useCallback(async () => {
    if (platform === 'desktop') {
      toast.show('桌面版会在后台自动检查，重启后生效', null, TOAST_TIMEOUT.info);
      return;
    }
    setUpdateState('checking');
    try {
      const info = await checkForUpdate(platform);
      setUpdateInfo(info);
      setUpdateState(info.available ? 'available' : 'latest');
    } catch {
      setUpdateState('error');
    }
  }, [platform, toast]);

  /** 「更新」按钮：安卓走应用内安装，其余端刷新即最新 */
  const onApplyUpdate = useCallback(async () => {
    const url = updateInfo?.apkUrl;
    if (!url) {
      location.reload();
      return;
    }
    if (!isInAppApkInstallAvailable()) {
      openApkDownload(url);
      return;
    }
    setUpdateState('checking');
    const outcome = await downloadAndInstallApk(url);
    setUpdateState('available');
    if (outcome === 'opened-installer') {
      toast.show('已打开安装器，点「安装」即可（覆盖安装保留数据）', null, TOAST_TIMEOUT.info);
    } else if (outcome === 'needs-permission') {
      toast.show('请先允许「安装未知应用」，再点一次更新', null, TOAST_TIMEOUT.error, 'warn');
    } else {
      openApkDownload(url);
    }
  }, [updateInfo, toast]);

  const onToggleAutoUpdate = useCallback(() => {
    const next = !autoUpdate;
    setAutoUpdate(next);
    setAutoUpdateEnabled(next);
    // 桌面端还要告诉主进程（后台循环在那边跑），失败不影响本地偏好
    desktopBridge()?.setAutoCheck(next).catch(() => {});
    toast.show(next ? '已开启自动检查更新' : '已关闭自动检查更新', null, TOAST_TIMEOUT.info);
  }, [autoUpdate, toast]);

  const updateHint = useMemo(() => {
    if (!autoUpdate) return '已关闭自动检查，可在下方手动检查';
    if (platform === 'desktop') return '桌面版在后台自动检查，重启后生效';
    if (updateState === 'checking') return '正在检查…';
    if (updateState === 'latest') return '已是最新版本';
    if (updateState === 'error') return '检查失败（可能未联网）';
    if (updateState === 'available') return '发现新版本 v' + (updateInfo?.version ?? '');
    return '更新是增量下载，不会动你的任务和日记';
  }, [autoUpdate, platform, updateState, updateInfo]);

  return (
    <div className="flex flex-wrap items-center gap-4 border-t border-line pt-4">
      <div className="min-w-32 flex-1">
        <div className="text-body font-semibold">版本与更新</div>
        <div className="mt-1 text-label text-ink-2" data-testid="app-version">
          当前 v{APP_VERSION} · 构建 {BUILD_ID}
        </div>
        <div className="mt-0.5 text-label text-ink-3" data-testid="update-hint">
          {updateHint}
        </div>
      </div>
      {updateState === 'available' && updateInfo ? (
        <button
          type="button"
          data-testid="update-apply"
          onClick={() => void onApplyUpdate()}
          className="btn btn-primary shrink-0"
        >
          {updateInfo.apkUrl
            ? '更新到 v' + updateInfo.version + '（' + formatSize(updateInfo.apkSize) + '）'
            : '刷新到 v' + updateInfo.version}
        </button>
      ) : null}
      <button
        type="button"
        data-testid="update-auto-toggle"
        aria-pressed={autoUpdate}
        onClick={onToggleAutoUpdate}
        className={`btn shrink-0 ${autoUpdate ? 'btn-primary' : 'btn-outlined'}`}
      >
        自动检查：{autoUpdate ? '开' : '关'}
      </button>
      <button
        type="button"
        data-testid="update-check"
        onClick={() => void onCheckUpdate()}
        disabled={updateState === 'checking'}
        className="btn btn-outlined shrink-0 disabled:opacity-40"
      >
        {updateState === 'checking' ? '检查中…' : '检查更新'}
      </button>
    </div>
  );
}
