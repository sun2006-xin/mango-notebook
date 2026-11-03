import { useCallback, useMemo, useState } from 'react';
import { LoginPanel } from '../auth/LoginPanel';
import { SyncPendingHint } from './SyncPendingHint';
import { ConfirmButton } from '../common/ConfirmButton';
import { isBrowserOffline } from '../../lib/network';
import { getPendingCount } from '../../lib/outbox';
import { isCloudConfigured } from '../../lib/cloud';
import { TOAST_TIMEOUT } from '../../constants';
import { useToast } from '../../hooks/useToast';
import type { CloudAccountState } from '../../hooks/useCloudAccount';
import { useHydrateFrom } from '../../hooks/useHydrateFrom';
import { buildPersistedPayload } from '../../hooks/usePersist';
import {
  SESSION_EXPIRED_MESSAGE,
  clearRemoteSnapshot,
  formatSyncTime,
  getLocalSavedAt,
  getSessionUser,
  isAutoSyncBlockedByClear,
  isAutoSyncPaused,
  listHistory,
  maskPhone,
  restoreHistory,
  runSync,
  signOut,
  syncErrorMessage,
  type HistoryEntry,
} from '../../lib/cloudSync';
import { migrate } from '../../lib/storage';
import { useAppState } from '../../store/StoreContext';
import type { PersistedPayload } from '../../types';

/* ============================================================================
   云同步（可选增强）—— 设置页里的一块
   ----------------------------------------------------------------------------
   从 SettingsView 搬出来。这一块是"登录态 → 立即同步 / 清空云端 / 历史版本 /
   退出登录"四条动作 + 一个历史回滚面板，只依赖：

   - `cloud`：登录态与同步状态（`useCloudAccount()` 的结果，由页面注入 ——
     页脚那句"数据保存在本机 / 登录后同步"也要读它，**必须是同一个实例**，
     否则一处 setAccount 另一处不知道）
   - `hydrateFrom`：把云端 / 历史版本装回本机

   ## 三个不能想当然的地方

   ① **载荷只有 `buildPersistedPayload()` 一个出口**，且同步必须传本机
      **真实落盘时间**（`getLocalSavedAt()`）而不是"现在"：一台从没保存过的新设备
      报"现在"，它的空数据会被判成最新、推上云端把真实数据清掉。
   ② `outcome.status === 'signed-out'` 才 setAccount(null)；网络错误不能算登出 ——
      那会让用户以为掉线，重新登录一次才发现根本没掉。
   ③ 历史回滚是**两段式**（再点一次才执行），且回滚本身也会被存档一次，
      所以点错了能再滚回来。
   ========================================================================= */

export interface CloudSectionProps {
  /** `useCloudAccount()` 的结果（页面持有，保证与页脚读到的是同一份状态） */
  cloud: CloudAccountState;
}

/** 历史版本的时间戳：跨天之后只看 HH:MM 会分不清，所以带上日期 */
function formatHistoryTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '未知时间';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function CloudSection({ cloud }: CloudSectionProps) {
  const state = useAppState();
  const toast = useToast();
  const hydrateFrom = useHydrateFrom();
  const { cloudAvailable, account, setAccount, loginOpen, setLoginOpen, lastSyncedAt, syncing } =
    cloud;

  /* 历史版本：云端每次被覆盖/清空前都会自动存档，误删了还能回来 */
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  const syncTimeText = useMemo(() => {
    const time = formatSyncTime(lastSyncedAt);
    return time ? `上次同步：${time}` : '尚未同步';
  }, [lastSyncedAt]);

  const onSyncClick = useCallback(async () => {
    if (syncing) return;
    /**
     * 离线时**不去撞墙**：直接说清"排队了多少条、联网会自动补传"。
     * 以前这里会真的发请求 → 失败 → toast「同步失败，数据仍在本机」，
     * 用户既不知道为什么失败，也不知道改动还在不在。
     */
    if (isBrowserOffline()) {
      const pending = getPendingCount();
      toast.show(
        pending > 0
          ? `当前离线，${pending} 条改动已排队，联网后会自动补传`
          : '当前离线，联网后再点同步',
        null,
        TOAST_TIMEOUT.info,
        'warn',
      );
      return;
    }
    // 本机最后一次**真实**落盘时间（不是"现在"）。没有落盘记录 + 本机也没任务
    // = 这是一台新设备，交给 runSync 判成"从云端恢复"，避免把云端盖成空的。
    const savedAt = getLocalSavedAt();
    /**
     * ⚠️ 载荷**只有一个出口**：`buildPersistedPayload()`（在 usePersist 里）。
     *
     * 这里曾经手抄过一份对象字面量 —— 加 `focusSessions` 那次就漏了它，
     * 于是"本机有什么"这件事有两份实现，改一份忘一份的代价是数据丢失。
     * 现在唯一的差异只是 `savedAt`：同步必须用**本机真实落盘时间**，
     * 所以传第二个参数。
     */
    const local: PersistedPayload | null =
      savedAt === null && state.tasks.length === 0
        ? null
        : buildPersistedPayload(state, savedAt ?? undefined);
    // `manual: true` 不只是"语义标注"：它会让 `runSync` 解除
    // 「清空云端 / 清空本机数据」留下的封锁。清空之后唯一能恢复同步的动作
    // 就是这一下 —— 不传它，用户点了「立即同步」也推不动。
    const outcome = await runSync(local, { manual: true });

    if (outcome.status === 'pushed') {
      toast.show('已同步到云端', null, TOAST_TIMEOUT.info);
      return;
    }
    if (outcome.status === 'pulled') {
      // 云端回来的数据同样走一遍字段级兜底，坏数据不至于污染本机状态
      const payload = migrate(outcome.payload);
      if (!payload) {
        toast.show('云端数据无法识别，已保留本机数据', null, TOAST_TIMEOUT.info, 'warn');
        return;
      }
      hydrateFrom(payload);
      toast.show('已从云端恢复最新数据', null, TOAST_TIMEOUT.info);
      return;
    }
    if (outcome.status === 'merged') {
      // 两边都有数据：合并结果推上了云端，本机也跟上，两台设备以此收敛
      const payload = migrate(outcome.payload);
      if (!payload) {
        toast.show('云端数据无法识别，已保留本机数据', null, TOAST_TIMEOUT.info, 'warn');
        return;
      }
      hydrateFrom(payload);
      toast.show(`已合并云端与本机数据（共 ${payload.tasks.length} 条）`, null, TOAST_TIMEOUT.info);
      return;
    }
    if (outcome.status === 'unchanged') {
      toast.show('已是最新，无需同步', null, TOAST_TIMEOUT.info);
      return;
    }
    if (outcome.status === 'signed-out') {
      setAccount(null);
      toast.show(SESSION_EXPIRED_MESSAGE, null, TOAST_TIMEOUT.info, 'warn');
      return;
    }
    toast.show(syncErrorMessage(outcome.error), null, TOAST_TIMEOUT.info, 'warn');
    /**
     * ⚠️ 依赖里是整份 `state`，不再逐个列字段。
     *
     * 逐个列的老写法漏过 `notes`，后果是**丢数据**（不只是"导出旧一点"）：
     * 导入一份带记事的备份 → hydrate（notes 变了，但依赖里没它，回调闭着旧数组）
     * → 立刻点「立即同步」→ 推上去的 notes 是导入前的旧内容 → merged 分支合并结果
     * 缺这些记事 → 既推上云端又被 hydrate 回本机 → **刚导入的记事两头都没了**。
     */
  }, [hydrateFrom, setAccount, state, syncing, toast]);

  const onSignedIn = useCallback(() => {
    // 刚登录成功：拿不到就保留现状，别把界面闪成"未登录"
    void getSessionUser().then((current) => {
      if (current) setAccount(current);
    });
    toast.show('登录成功，正在同步…', null, TOAST_TIMEOUT.info);
    void onSyncClick();
  }, [onSyncClick, setAccount, toast]);

  const onSignOut = useCallback(async () => {
    await signOut();
    setAccount(null);
    toast.show('已退出登录，数据仍在本机', null, TOAST_TIMEOUT.info);
  }, [setAccount, toast]);

  /**
   * 清空云端：两段式确认（第二次点击才真正执行，3 秒后自动收回）。
   * 只删云端那一行，本机数据不动；成功后自动推送暂停，点一次「立即同步」恢复。
   */
  const onClearCloudConfirmed = useCallback(async () => {
    const result = await clearRemoteSnapshot();
    if (result.status === 'ok') {
      toast.show(
        result.removed > 0
          ? `云端已清空（${result.removed} 条记录），本机数据保留；自动同步已暂停，点「立即同步」恢复`
          : '云端本来就是空的，无需清空',
        null,
        TOAST_TIMEOUT.info,
      );
      return;
    }
    if (result.status === 'signed-out') {
      setAccount(null);
      toast.show(SESSION_EXPIRED_MESSAGE, null, TOAST_TIMEOUT.info, 'warn');
      return;
    }
    toast.show(syncErrorMessage(result.error), null, TOAST_TIMEOUT.info, 'warn');
  }, [setAccount, toast]);

  /** 展开/收起历史版本列表（云端自动存档的旧快照） */
  const onHistoryClick = useCallback(async () => {
    if (historyOpen) {
      setHistoryOpen(false);
      return;
    }
    setHistoryOpen(true);
    setHistoryLoading(true);
    // 收起面板时每行的 ConfirmButton 会随列表卸载，武装态与定时器一并清掉
    const result = await listHistory();
    setHistoryLoading(false);
    if (result.status === 'ok') {
      setHistory(result.entries);
      return;
    }
    setHistoryOpen(false);
    if (result.status === 'signed-out') {
      setAccount(null);
      toast.show(SESSION_EXPIRED_MESSAGE, null, TOAST_TIMEOUT.info, 'warn');
      return;
    }
    toast.show(syncErrorMessage(result.error), null, TOAST_TIMEOUT.info, 'warn');
  }, [historyOpen, setAccount, toast]);

  /**
   * 回滚到某个历史版本（两段式确认：第二次点击才执行）。
   * 回滚本身也会被存档一次，所以点错了可以再回滚回来。
   */
  const onRestoreConfirmed = useCallback(
    async (id: number) => {
      const result = await restoreHistory(id);
      if (result.status === 'ok') {
        hydrateFrom(result.payload);
        toast.show(
          `已回滚到该版本（${result.payload.tasks.length} 条任务）`,
          null,
          TOAST_TIMEOUT.info,
        );
        setHistoryOpen(false);
        return;
      }
      if (result.status === 'signed-out') {
        setAccount(null);
        toast.show(SESSION_EXPIRED_MESSAGE, null, TOAST_TIMEOUT.info, 'warn');
        return;
      }
      toast.show(syncErrorMessage(result.error), null, TOAST_TIMEOUT.info, 'warn');
    },
    [hydrateFrom, setAccount, toast],
  );

  /** 历史版本面板里点「恢复」时顺手收起列表；登录态没了就别挂面板 */
  const historyPanel = historyOpen && account;

  return (
    <div className="border-b border-line py-4">
      <div className="text-body font-semibold">云同步</div>
      {!cloudAvailable ? (
        <p className="mt-1 text-label leading-relaxed text-ink-2">
          {isCloudConfigured
            ? '当前运行来源与云服务配置不匹配，因此无法登录同步。自建客户端请确认服务 endpoint 与平台 origin 配套；官方 Windows / Android 客户端默认不接入项目方云服务。'
            : '此构建未接入云端：数据只保存在本机（可用「导出备份 / 导入」在设备间搬运）。如需自建云，请参考 docs/SELF-HOSTING.md。'}
        </p>
      ) : account === null ? (
        <div className="mt-1 flex flex-wrap items-center gap-4">
          <div className="min-w-32 flex-1 text-label text-ink-2">
            登录后可把待办同步到云端，换手机也不丢
          </div>
          <button
            type="button"
            data-testid="cloud-login"
            onClick={() => setLoginOpen(true)}
            className="btn btn-primary shrink-0"
          >
            登录同步
          </button>
        </div>
      ) : (
        <div className="mt-1 flex flex-wrap items-center gap-4">
          <div className="min-w-32 flex-1 text-label text-ink-2">
            已登录 {maskPhone(account.phone)} · {syncing ? '同步中…' : syncTimeText}
            {/*
              连续失败后自动同步会停摆（不再每次保存都撞墙）。这件事
              **必须**在界面上说出来：否则用户看到"上次同步 09:12"就以为它还在跑，
              实际后台已经不跑了 —— 比失败本身更误导。
            */}
            {isAutoSyncPaused() ? (
              <span className="mt-1 block text-warn">
                自动同步已暂停（连续失败），数据仍在本机 —— 点「立即同步」可恢复
              </span>
            ) : null}
            {/*
              「清空全部数据」之后自动同步整体停摆（否则 60 秒内云端那份会被
              原样拉回来）。停摆必须在**这里**说出来，而且要给出两条出路 ——
              否则用户只会看到"数据莫名其妙回来了"或"同步再也不动了"。
            */}
            {isAutoSyncBlockedByClear() ? (
              <span className="mt-1 block text-warn">
                你清空过本机数据，自动同步已暂停 —— 点「立即同步」从云端恢复，或「清空云端」彻底删除
              </span>
            ) : null}
            {/* 离线 / 待上传：数字来自设备本地的 outbox，刷新后依然在（⑦） */}
            <SyncPendingHint />
          </div>
          <button
            type="button"
            data-testid="cloud-sync"
            onClick={() => void onSyncClick()}
            disabled={syncing}
            className="btn btn-primary shrink-0 disabled:opacity-50"
          >
            {syncing ? '同步中…' : '立即同步'}
          </button>
          <ConfirmButton
            testId="cloud-clear"
            variant="outline"
            confirmLabel="确认清空云端？再点一次"
            onConfirm={() => void onClearCloudConfirmed()}
          >
            清空云端
          </ConfirmButton>
          <button
            type="button"
            data-testid="cloud-history"
            onClick={() => void onHistoryClick()}
            className="btn btn-outlined shrink-0"
          >
            {historyOpen ? '收起历史' : '历史版本'}
          </button>
          <button
            type="button"
            data-testid="cloud-signout"
            onClick={() => void onSignOut()}
            className="btn btn-outlined shrink-0"
          >
            退出登录
          </button>
        </div>
      )}

      {/* 历史版本：云端每次被覆盖/清空前自动存档，误删了可以回到这里回滚 */}
      {historyPanel ? (
        <div
          data-testid="cloud-history-panel"
          className="mt-3 field p-3"
 >
 {historyLoading ? (
 <div className="text-label text-ink-2">正在读取历史版本…</div>
          ) : history.length === 0 ? (
            <div className="text-label text-ink-2">
              还没有历史版本。云端每次被覆盖或清空前都会自动存档一份，届时这里就能回滚。
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {history.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-center gap-3">
                  <div className="min-w-40 flex-1 text-label text-ink-2">
                    {formatHistoryTime(entry.archivedAt)} · {entry.taskCount} 条任务
                    {entry.reason === 'DELETE' ? ' · 云端清空前' : ''}
                  </div>
                  {/*
                    每行一个独立的 ConfirmButton：武装状态天然按行隔离，
                    不再需要 `confirmRestoreId` 这种"哪一行在确认"的全局状态。
                    顺带补上了原来缺的自动收回 —— 之前这里点一下武装就**永不退回**，
                    用户切走再回来随手一点就会真的回滚。
                  */}
                  <ConfirmButton
                    testId={`history-restore-${entry.id}`}
                    variant="outline"
                    confirmLabel="确认回滚？再点一次"
                    onConfirm={() => void onRestoreConfirmed(entry.id)}
                  >
                    恢复
                  </ConfirmButton>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {cloudAvailable ? (
        <LoginPanel open={loginOpen} onClose={() => setLoginOpen(false)} onSignedIn={onSignedIn} />
      ) : null}
    </div>
  );
}
