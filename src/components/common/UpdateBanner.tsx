import { useCallback, useEffect, useRef, useState } from 'react';
import {
  checkForUpdate,
  desktopBridge,
  detectPlatform,
  formatSize,
  getSkippedBuildId,
  isAutoUpdateEnabled,
  openApkDownload,
  skipBuildId,
  type DesktopUpdaterBridge,
  type DesktopUpdateStatus,
  type UpdateInfo,
} from '../../lib/update';
import { downloadAndInstallApk, isInAppApkInstallAvailable } from '../../lib/apkUpdate';

/* ============================================================================
   更新提示条

   设计取向：**打扰最小化**。
   - 不弹窗、不遮罩，只是一条可以无视的条；用户继续干自己的事不受影响
   - 「以后再说」按 buildId 记住，同一个版本只问一次；出了下一个版本会再问
   - 后台只检查不下载：用户没点「立即更新」，一个字节都不下

   三端动作不同，但入口统一：
   - 桌面：IPC 下载 → 下完变成「重启生效」
   - 安卓：应用内下载 + 调起系统安装器（拿不到插件时才回落到浏览器）
   - 网页：刷新即最新
   ========================================================================= */

type Phase = 'idle' | 'checking' | 'available' | 'downloading' | 'staged' | 'done' | 'error' | 'hidden';

export function UpdateBanner() {
  const platform = detectPlatform();
  const bridge = useRef<DesktopUpdaterBridge | null>(desktopBridge());

  const [phase, setPhase] = useState<Phase>('idle');
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [message, setMessage] = useState('');
  const [dismissed, setDismissed] = useState(false);

  /** 桌面端状态 → 组件状态 */
  const applyDesktopStatus = useCallback((status: DesktopUpdateStatus) => {
    if (status.staged) {
      setPhase('staged');
      setInfo((prev) => prev ?? {
        available: true,
        version: status.version,
        buildId: status.buildId,
        apkUrl: null,
        apkSize: 0,
      });
      return;
    }
    if (!status.available) {
      setPhase('hidden');
      return;
    }
    // 用户说过"以后再说"，同一个 buildId 就不再打扰
    if (getSkippedBuildId() === status.buildId) {
      setPhase('hidden');
      return;
    }
    setInfo({
      available: true,
      version: status.version,
      buildId: status.buildId,
      apkUrl: null,
      apkSize: 0,
    });
    setPhase('available');
  }, []);

  useEffect(() => {
    /**
     * 延迟 2.5 秒再查：别和首屏渲染、数据装载抢那一点点资源。
     * 用户刚打开应用时看到的应该是他的任务，不是一条更新提示。
     */
    const timer = setTimeout(() => {
      const desktop = bridge.current;
      // 把偏好同步给主进程：关掉的话主进程连后台检查都不做
      if (desktop) desktop.setAutoCheck(isAutoUpdateEnabled()).catch(() => {});
      // 用户关了自动检查就彻底安静 —— 设置页里的手动检查不受影响
      if (!isAutoUpdateEnabled()) return;
      if (desktop) {
        // 桌面端先读主进程缓存（不联网），没有结果再主动查一次
        desktop
          .getStatus()
          .then((status) => {
            if (status.checkedAt > 0) applyDesktopStatus(status);
            else return desktop.check().then(applyDesktopStatus);
            return undefined;
          })
          .catch(() => setPhase('hidden'));
        return;
      }

      setPhase('checking');
      checkForUpdate(platform)
        .then((result) => {
          if (!result.available || getSkippedBuildId() === result.buildId) {
            setPhase('hidden');
            return;
          }
          setInfo(result);
          setPhase('available');
        })
        .catch(() => setPhase('hidden'));
    }, 2500);

    return () => clearTimeout(timer);
  }, [applyDesktopStatus, platform]);

  /* 下载进度订阅（仅桌面端会真的有事件） */
  useEffect(() => {
    const desktop = bridge.current;
    if (!desktop) return undefined;
    return desktop.onProgress(({ done, total }) => setProgress({ done, total }));
  }, []);

  const onUpdate = useCallback(async () => {
    const desktop = bridge.current;
    if (desktop) {
      setPhase('downloading');
      setProgress({ done: 0, total: 0 });
      const result = await desktop.download();
      if (result.ok) {
        setPhase('staged');
      } else if (result.reason === 'already-latest') {
        setPhase('hidden');
      } else {
        setMessage('下载失败，请稍后再试');
        setPhase('error');
      }
      return;
    }

    if (platform === 'android' && info?.apkUrl) {
      /**
       * 安卓：优先**应用内下载 + 调起安装器**（不用跳浏览器、不用找文件）。
       * 只有壳里没有这个插件（老版本 APK / 网页）或下载失败时，才回落到浏览器。
       */
      if (!isInAppApkInstallAvailable()) {
        openApkDownload(info.apkUrl);
        setMessage('已交给浏览器下载，安装时选「覆盖安装」');
        setPhase('done');
        return;
      }
      setPhase('downloading');
      setProgress({ done: 0, total: 0 });
      const outcome = await downloadAndInstallApk(info.apkUrl, (done, total) =>
        setProgress({ done, total }),
      );
      if (outcome === 'opened-installer') {
        setMessage('已打开安装器 · 点「安装」即可，覆盖安装会保留数据');
        setPhase('done');
        return;
      }
      if (outcome === 'needs-permission') {
        setMessage('请先允许「安装未知应用」，回来再点一次更新');
        setPhase('done');
        return;
      }
      openApkDownload(info.apkUrl);
      setMessage('应用内下载失败，已交给浏览器');
      setPhase('done');
      return;
    }

    // 网页端：刷新即拿到最新（SW 网络优先）
    location.reload();
  }, [info, platform]);

  const onLater = useCallback(() => {
    if (info?.buildId) skipBuildId(info.buildId);
    setDismissed(true);
    setPhase('hidden');
  }, [info]);

  if (phase === 'hidden' || phase === 'idle' || dismissed) return null;

  const versionLabel = info?.version ? `v${info.version}` : '新版本';
  const percent =
    progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div
      role="status"
      data-testid="update-banner"
      className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-accent/25 bg-accent-soft px-4 py-3"
    >
      <div className="min-w-40 flex-1">
        <div className="text-body-sm font-semibold text-accent" data-testid="update-banner-title">
          {phase === 'staged' ? '新版本已就绪' : `发现 ${versionLabel}`}
        </div>
        <div className="mt-0.5 text-label leading-relaxed text-ink-2" data-testid="update-banner-hint">
          {phase === 'downloading'
            ? `正在下载… ${progress.done}/${progress.total}（${percent}%）`
            : phase === 'staged'
              ? '重启后生效 · 你的任务和日记不受影响'
              : phase === 'error'
                ? message || '出了点问题，稍后再试'
                : phase === 'done'
                  ? message
                : platform === 'android'
                  ? `约 ${formatSize(info?.apkSize ?? 0)} · 覆盖安装可保留数据`
                  : '更新只替换界面文件，不动你的数据'}
        </div>
      </div>

      {phase === 'available' ? (
        <button type="button" data-testid="update-banner-now" onClick={() => void onUpdate()} className="btn btn-primary shrink-0">
          立即更新
        </button>
      ) : null}

      {phase === 'downloading' ? (
        <button type="button" className="btn btn-outlined shrink-0" disabled>
          下载中…
        </button>
      ) : null}

      {phase === 'staged' ? (
        <button
          type="button"
          data-testid="update-banner-restart"
          onClick={() => bridge.current?.restart()}
          className="btn btn-primary shrink-0"
        >
          重启生效
        </button>
      ) : null}

      {phase !== 'staged' && phase !== 'downloading' ? (
        <button type="button" data-testid="update-banner-later" onClick={onLater} className="btn btn-text shrink-0">
          以后再说
        </button>
      ) : null}

      {phase === 'staged' ? (
        <button type="button" onClick={onLater} className="btn btn-text shrink-0">
          下次启动再说
        </button>
      ) : null}
    </div>
  );
}
