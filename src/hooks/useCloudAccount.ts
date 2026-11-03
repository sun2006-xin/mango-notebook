import { useEffect, useMemo, useState } from 'react';
import { isCloudRuntimeAvailable } from '../lib/cloud';
import {
  getSessionUser,
  getSyncStatus,
  subscribeAuth,
  subscribeSyncStatus,
  type CloudAccount,
} from '../lib/cloudSync';

/* ============================================================================
   「这台设备能不能用云同步 + 现在登录的是谁」—— 一个 hook
   ----------------------------------------------------------------------------
   从 SettingsView 里提出来，原因有二：

   ① 这四样东西（可用性 / 账号 / 上次同步时间 / 正在同步）是**一组**，
      设置页里散着三处 state + 两个 effect，页脚那句「数据保存在本机」也要读它。
   ② 拆「云同步」这一块 UI 时，如果把 `account` 与 `cloudAvailable` 留在父组件，
      子组件就得接六个 props —— 那只是把 god component 换成 god props。
      收进 hook 之后，任何一块 UI 调一次 `useCloudAccount()` 就够。

   ## 为什么 `getSessionUser()` 返回 null 时**不**直接 setAccount(null)

   null 有两种含义：真未登录，**也可能是网络抖动**。曾经这里无条件覆盖，
   于是一次 token 续期失败就把用户显示成"未登录"（用户以为掉线了，其实还在）。
   现在只有**拿到账号**才覆盖；"没有"这件事交给 `subscribeAuth` 的
   SIGNED_OUT 事件定论 —— 那是 SDK 的权威来源，不会把网络错误算成登出。
   ========================================================================= */

export interface CloudAccountState {
  /** 当前构建的服务 origin 是否允许云同步（配置 origin / 显式 `?cloud=1`） */
  cloudAvailable: boolean;
  /** 当前账号；null = 未登录（也可能是还没读到） */
  account: CloudAccount | null;
  /** 只有"云端确认登出"时才该调它；网络错误不要调 */
  setAccount: (account: CloudAccount | null) => void;
  /** 登录面板是否展开（放这里是因为它跟着登录态走） */
  loginOpen: boolean;
  setLoginOpen: (open: boolean) => void;
  /** 最近一次成功同步的 ISO 时间；null = 从未同步 */
  lastSyncedAt: string | null;
  /** 是否正在同步（含后台自动推送） */
  syncing: boolean;
}

export function useCloudAccount(): CloudAccountState {
  /**
   * 云同步只在当前构建配置了 endpoint 且运行来源匹配时启用。
   * 官方客户端构建会清空云配置；用户自建云客户端由自己的构建配置启用。
   * 未配置或来源不匹配时不挂载登录监听，也不发云请求。
   */
  const cloudAvailable = useMemo(() => isCloudRuntimeAvailable(), []);
  const [account, setAccount] = useState<CloudAccount | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(getSyncStatus().lastSyncedAt);
  const [syncing, setSyncing] = useState<boolean>(getSyncStatus().syncing);

  // 同步状态（含后台自动推送的结果）由 cloudSync 广播，这里只做展示
  useEffect(
    () =>
      subscribeSyncStatus((status) => {
        setLastSyncedAt(status.lastSyncedAt);
        setSyncing(status.syncing);
      }),
    [],
  );

  // 登录态：进来先读一次，之后跟着 SDK 的登录态变化走（环境不支持时完全不碰云端）
  useEffect(() => {
    if (!cloudAvailable) return undefined;
    let alive = true;
    void getSessionUser().then((current) => {
      if (alive && current) setAccount(current);
    });
    const unsubscribe = subscribeAuth((current) => setAccount(current));
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [cloudAvailable]);

  return { cloudAvailable, account, setAccount, loginOpen, setLoginOpen, lastSyncedAt, syncing };
}
