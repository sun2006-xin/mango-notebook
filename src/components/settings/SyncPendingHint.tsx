import { useEffect, useState } from 'react';
import { subscribeSyncStatus } from '../../lib/cloudSync';
import { isBrowserOffline } from '../../lib/network';
import { getPendingCount } from '../../lib/outbox';

/* ============================================================================
   同步状态提示：离线 / 待上传
   ----------------------------------------------------------------------------
   为什么必须显示出来：⑦ 之前，离线期间的改动只活在内存里，失败 3 次自动同步
   还会静默停摆 —— 用户看到"上次同步 09:12"，以为一切正常，实际上
   一下午在手机上改的东西一条都没上去。**"看起来在同步"比同步失败更误导。**

   现在的口径：
   - 有待上传 → "N 条改动待上传"（离线时补一句"联网后自动补传"）；
   - 没有待上传但当前离线 → 只说离线，不制造焦虑。

   数据来源是设备本地的 outbox（落盘的），所以刷新之后数字还在 —— 这正是它
   存在的意义。订阅 `subscribeSyncStatus` 是为了同步成功（队列被清空）后
   这个数字能立刻归零，而不是等下一次导航。
   ========================================================================= */

export function SyncPendingHint() {
  const [pending, setPending] = useState(() => ({
    count: getPendingCount(),
    offline: isBrowserOffline(),
  }));

  useEffect(() => {
    const refresh = (): void => {
      setPending({ count: getPendingCount(), offline: isBrowserOffline() });
    };
    refresh();
    const unsubscribe = subscribeSyncStatus(refresh);
    // 网络状态本身不会引起 React 重渲染，只能自己听这两个事件
    window.addEventListener('online', refresh);
    window.addEventListener('offline', refresh);
    return () => {
      unsubscribe();
      window.removeEventListener('online', refresh);
      window.removeEventListener('offline', refresh);
    };
  }, []);

  if (pending.count === 0 && !pending.offline) return null;

  return (
    <span data-testid="sync-pending" className="mt-1 block text-label text-warn">
      {pending.count > 0
        ? `${pending.offline ? '当前离线：' : ''}${pending.count} 条改动待上传，${
            pending.offline ? '联网后自动补传' : '会自动重试'
          }`
        : '当前处于离线状态，恢复网络后会自动同步'}
    </span>
  );
}
