import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmButton } from '../common/ConfirmButton';
import { StorageUsage } from './StorageUsage';
import { TEXT, TOAST_TIMEOUT } from '../../constants';
import { useToast } from '../../hooks/useToast';
import { addDays } from '../../lib/date';
import { buildExportMarkdown, exportFileName } from '../../lib/exportMarkdown';
import { buildBackupPayload } from '../../lib/storage';
import { noteLocalCleared } from '../../lib/cloudSync';
import { listLocalBackups, parseBackupJson } from '../../lib/backup';
import {
  hasDesktopBackup,
  openDesktopBackupDir,
  readDesktopBackup,
  writeDesktopBackup,
  type LocalBackupEntry,
} from '../../lib/desktopBackup';
// 本地备份列表要显示文件大小，只借这一个纯格式化函数
import { formatSize } from '../../lib/update';
import { useAppDispatch, useAppState } from '../../store/StoreContext';
import { useHydrateFrom } from '../../hooks/useHydrateFrom';
import type { DateKey, PersistedPayload } from '../../types';

export interface DataSectionProps {
  /** 当前真实今天（备份文件名、归档截止日、月占用统计都靠它） */
  today: DateKey;
}

/** 导出为文件下载（分享不可用时的退路）；JSON 与 Markdown 共用同一条路径 */
function downloadFile(content: string, filename: string, mime: string): void {
  try {
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    /* 下载失败不阻塞 UI */
  }
}

/**
 * 数据区：导出 / 导入 / 回收站 / 归档 / 清空 + 桌面端自动备份列表。
 *
 * 从 `SettingsView` 整块搬来（原文件 1192 → 824 → 现在更薄）。搬的理由不是"行数"
 * 本身，而是这一块**六个不可逆操作挤在一起**：导入、恢复、清空、归档、覆盖、
 * 删除。它们又都绕着同一个出口 `useHydrateFrom()`（装回状态的唯一入口），
 * 摊在一个上千行的文件里，任何一次"顺手再改点别的"都可能把它改回手抄 HYDRATE。
 *
 * 内部自己取上下文（与 `CloudSection` 同一套做法），所以外面只需要传 `today`。
 */
export function DataSection({ today }: DataSectionProps) {
  const state = useAppState();
  const { tasks, tombstones } = state;
  const dispatch = useAppDispatch();
  const toast = useToast();

  /** 装回状态的唯一入口（见 hooks/useHydrateFrom 的注释：曾经手抄过四份） */
  const hydrateFrom = useHydrateFrom();

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /**
   * 导出备份。优先走系统分享（手机上可直接存文件 / 发给自己），
   * 分享不可用时退回下载链接（桌面浏览器）。
   * 这是目前唯一能对抗"卸载即丢数据"的手段，所以两种路径都要有。
   */
  const onExport = useCallback(() => {
    const payload = buildBackupPayload(state);
    const json = JSON.stringify(payload, null, 2);
    const stamp = today.replace(/-/g, '');
    const name = `芒果本本-备份-${stamp}.json`;

    const nav = navigator as Navigator & {
      canShare?: (data: { files?: File[] }) => boolean;
      share?: (data: { files?: File[]; title?: string; text?: string }) => Promise<void>;
    };
    const file = new File([json], name, { type: 'application/json' });

    if (typeof nav.share === 'function' && (!nav.canShare || nav.canShare({ files: [file] }))) {
      nav
        .share({ files: [file], title: '芒果本本备份', text: `${state.tasks.length} 条任务` })
        .catch(() => downloadFile(json, name, 'application/json'));
      return;
    }
    downloadFile(json, name, 'application/json');
    /**
     * 依赖只留 `state` 与 `today`。
     *
     * 原来是一份手写的六项依赖数组（`tasks, settings, diary, tombstones,
     * focusSessions, notes`），已经漏过一次 `notes`：导出的是"进入设置页那一刻"
     * 的记事快照，而记事本就在这一页旁边编辑 —— 刚写完再导出，文件里没有那篇。
     * 六项依赖与六字段 payload 是两份代码，改一处必看另一处；索性合成一份。
     */
  }, [state, today]);

  /**
   * 导出全量 Markdown（**给人读的那一份**）。
   *
   * 与「导出备份」的区别要说清：备份 JSON 是给机器读的（能原样导回），
   * Markdown 是给眼睛看的 —— 打印复习、粘进 Notion、留一份看得懂的存档。
   * 所以两个按钮并列，不合并。
   *
   * 分享优先（手机上能直接存/发给自己），不支持再退回下载链接。
   */
  const onExportMarkdown = useCallback(() => {
    const markdown = buildExportMarkdown({
      tasks: state.tasks,
      diary: state.diary,
      notes: state.notes,
      focusSessions: state.focusSessions,
      // 打记录也要能带走：连续天数是攒出来的，丢了重建不出来
      habits: state.settings.habits,
      habitChecks: state.settings.habitChecks,
      sleepLog: state.settings.sleepLog,
      today,
    });
    const name = exportFileName(today);

    const nav = navigator as Navigator & {
      canShare?: (data: { files?: File[] }) => boolean;
      share?: (data: { files?: File[]; title?: string; text?: string }) => Promise<void>;
    };
    const file = new File([markdown], name, { type: 'text/markdown' });

    if (typeof nav.share === 'function' && (!nav.canShare || nav.canShare({ files: [file] }))) {
      nav
        .share({ files: [file], title: '芒果本本 · 全量导出', text: `${state.tasks.length} 条任务` })
        .catch(() => downloadFile(markdown, name, 'text/markdown'));
      return;
    }
    downloadFile(markdown, name, 'text/markdown');
    toast.show(`已导出 ${name}`, null, TOAST_TIMEOUT.info);
    /**
     * 依赖同样只留 `state` 与 `toast` / `today`。
     *
     * 这份 payload 从 `settings` 上取三样（习惯 / 打卡 / 作息），原来手写的依赖里
     * 少写 `settings` 就会导出"进页面那一刻"的旧状态 —— 而习惯编辑器就嵌在这一页。
     * 现在 `state` 一个依赖覆盖全部字段，不会再出现"取了三样、依赖里只写一样"。
     */
  }, [state, toast, today]);

  /**
   * 待确认的导入目标。导入与「清空数据」同级 —— **不可逆地覆盖本机全部数据**，
   * 所以同样是两段式：选文件只是读出来给你看，再点一次才真的覆盖。
   *
   * 曾经这里是一步到位，而且用 `JSON.parse + migrate` 而不是 `parseBackupJson`：
   * `migrate({})` 会补出一份"合法但全空"的载荷，于是**随手选一个 package.json
   * 就能把任务 / 日记 / 记事 / 专注 / 墓碑全部清空**，连确认都没有。
   */
  const [pendingImport, setPendingImport] = useState<{
    name: string;
    payload: PersistedPayload;
  } | null>(null);

  const importSummary = useMemo(() => {
    if (!pendingImport) return '';
    const { payload } = pendingImport;
    const diaryCount = payload.diary.filter((entry) => entry.content.trim()).length;
    return `将覆盖本机全部数据：${payload.tasks.length} 条任务、${diaryCount} 篇日记、${payload.notes.length} 篇记事、${payload.focusSessions.length} 条专注记录`;
  }, [pendingImport]);

  const onImportClick = useCallback(() => {
    // 第二段：已经读过一份备份，这一下才真的覆盖
    if (pendingImport) {
      hydrateFrom(pendingImport.payload);
      toast.show('已导入备份', null, TOAST_TIMEOUT.info);
      setPendingImport(null);
      return;
    }
    fileInputRef.current?.click();
  }, [hydrateFrom, pendingImport, toast]);

  const onFilePicked = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // 清空 value，保证同一个文件能连续选两次
      event.target.value = '';
      if (!file) return;

      try {
        const text = await file.text();
        /**
         * 必须走 `parseBackupJson`（lib/backup.ts）—— 它先做形状校验
         * （`looksLikePayload`：有数字 schemaVersion，或任一集合是数组），
         * 再 migrate。直接用 `JSON.parse + migrate` 的话，任何 JSON 都能
         * 变成一份"合法但全空"的载荷 = 一键清空全机数据。
         */
        const payload = parseBackupJson(text);
        if (!payload) {
          toast.show('这个文件不是有效的备份', null, TOAST_TIMEOUT.info, 'warn');
          return;
        }
        setPendingImport({ name: file.name, payload });
      } catch {
        toast.show('读取备份文件失败', null, TOAST_TIMEOUT.info);
      }
    },
    [toast],
  );

  /* ---------- 自动备份（F4 · 桌面端文件备份） ---------- */

  const backupAvailable = useMemo(() => hasDesktopBackup(), []);
  const [backupEntries, setBackupEntries] = useState<LocalBackupEntry[]>([]);
  const [backupLoading, setBackupLoading] = useState(false);
  /**
   * 待确认的恢复目标。**两段式**：第一次点击只是"读出来 + 告诉用户这份里有什么"，
   * 第二次点击才真的覆盖本机数据 —— 恢复是不可逆的（虽然写了一份
   * pre-restore.json 兜底，但用户不知道那个文件夹在哪儿）。
   */
  const [pendingRestore, setPendingRestore] = useState<{
    name: string;
    payload: PersistedPayload;
  } | null>(null);

  const onBackupRefresh = useCallback(async () => {
    setBackupLoading(true);
    const entries = await listLocalBackups();
    setBackupLoading(false);
    setBackupEntries(entries);
  }, []);

  useEffect(() => {
    if (!backupAvailable) return;
    void onBackupRefresh();
  }, [backupAvailable, onBackupRefresh]);

  const onBackupOpenDir = useCallback(async () => {
    const ok = await openDesktopBackupDir();
    if (!ok) toast.show(TEXT.backupFailed, null, TOAST_TIMEOUT.info, 'warn');
  }, [toast]);

  const onBackupRestore = useCallback(
    async (name: string) => {
      // 第二段：真的恢复
      if (pendingRestore?.name === name) {
        setPendingRestore(null);
        const payload = pendingRestore.payload;
        /**
         * 恢复前先把"现在这一份"存下来（pre-restore.json，白名单里的固定名）。
         * 否则用户点错了就再也回不到恢复前的状态。
         */
        const snapshot = buildBackupPayload(state);
        /**
         * ⚠️ 兜底快照**写失败就不许恢复**。
         *
         * 原来这里 `await` 了却丢掉返回值：磁盘满 / 无写权限 / 杀软拦截时，
         * pre-restore.json 根本没写成，而恢复照常进行 —— 用户以为"点错了能回退"，
         * 实际退路从来没存在过。恢复是不可逆操作，宁可不做，也不能在没有退路时做。
         */
        const snapshotWritten = await writeDesktopBackup(
          JSON.stringify(snapshot),
          'pre-restore.json',
        );
        if (!snapshotWritten) {
          toast.show(
            '没能先把当前数据备份到磁盘（磁盘已满或无写权限），已取消恢复',
            null,
            TOAST_TIMEOUT.info,
            'warn',
          );
          return;
        }
        // ⚠️ 唯一装载入口：绝不手抄 HYDRATE（见 store/reducer.ts 的说明）
        hydrateFrom(payload);
        toast.show(
          `${TEXT.backupRestored} · ${TEXT.backupCountTasks} ${payload.tasks.length} · ` +
            `${TEXT.backupCountDiary} ${payload.diary.filter((entry) => entry.content).length} · ` +
            `${TEXT.backupCountNotes} ${payload.notes.length} · ` +
            `${TEXT.backupCountFocus} ${payload.focusSessions.length}`,
          null,
          TOAST_TIMEOUT.info,
        );
        void onBackupRefresh();
        return;
      }

      // 第一段：读出来 + 展示条数，等用户确认
      const text = await readDesktopBackup(name);
      const payload = text ? parseBackupJson(text) : null;
      if (!payload) {
        setPendingRestore(null);
        toast.show(TEXT.backupInvalid, null, TOAST_TIMEOUT.info, 'warn');
        return;
      }
      setPendingRestore({ name, payload });
    },
    // `state` 覆盖六项持久化字段（快照用），不必再逐字段点名
    [hydrateFrom, onBackupRefresh, pendingRestore, state, toast],
  );

  /** 确认之后的**执行**部分（武装与自动收回由 ConfirmButton 负责） */
  const onClearConfirmed = useCallback(() => {
    dispatch({ type: 'DATA_CLEAR_ALL' });
    /**
     * ⚠️ 只清本机是不够的，还得给云同步上一道锁。
     *
     * `decideSyncAction` 里"本机为空 + 云端有数据 = 空机恢复"是**正确**规则
     * （新设备该拉），但它分不清"新设备"与"用户刚清空"。不分清的后果实测过：
     * 点完清空，60 秒轮询一到就 pull-cloud，整份数据原样长回来 ——
     * 用户看到的是"清空了又自己回来了"，像是见了鬼。
     * 锁在 `noteLocalCleared()` 里：内存封锁 + 落盘标记（重启也拦得住），
     * 只有用户点「立即同步」才解除。
     */
    noteLocalCleared();
    toast.show('已清空全部任务与设置（主题保留）', null, TOAST_TIMEOUT.info);
  }, [dispatch, toast]);

  /** 归档：清理 30 天前已完成的任务（控制数据体积，只删已完成的） */
  const archiveBefore = useMemo(() => addDays(today, -30), [today]);
  const archiveCount = useMemo(
    () => tasks.filter((task) => task.done && task.date < archiveBefore).length,
    [tasks, archiveBefore],
  );

  const onArchive = useCallback(() => {
    if (archiveCount === 0) return;
    dispatch({
      type: 'ARCHIVE_DONE',
      before: archiveBefore,
      now: new Date().toISOString(),
    });
    toast.show(`已归档 ${archiveCount} 条已完成任务`, null, TOAST_TIMEOUT.info);
  }, [archiveBefore, archiveCount, dispatch, toast]);

  return (
    <>
      {/* ---------- 自动备份（桌面端文件备份；网页 / 安卓靠双快照） ---------- */}
      <div className="border-b border-line py-4">
        <div className="flex flex-wrap items-center gap-4">
          <div className="min-w-32 flex-1">
            <div className="text-body font-semibold">{TEXT.backup}</div>
            <div className="mt-1 text-label text-ink-2">{TEXT.backupDesktopOnly}</div>
          </div>
          {backupAvailable ? (
            <>
              <button
                type="button"
                data-testid="backup-open-dir"
                onClick={() => void onBackupOpenDir()}
                className="btn btn-outlined shrink-0"
              >
                {TEXT.backupOpenDir}
              </button>
              <button
                type="button"
                data-testid="backup-refresh"
                onClick={() => void onBackupRefresh()}
                disabled={backupLoading}
                className="btn btn-outlined shrink-0 disabled:opacity-40"
              >
                {backupLoading ? '…' : TEXT.backupRefresh}
              </button>
            </>
          ) : null}
        </div>

        {backupAvailable ? (
          backupEntries.length === 0 ? (
            <p className="mt-2 text-label text-ink-2">{TEXT.backupNone}</p>
          ) : (
            <ul className="mt-3 flex flex-col gap-2" data-testid="backup-list">
              {backupEntries.map((entry) => {
                const confirming = pendingRestore?.name === entry.name;
                return (
                  <li key={entry.name} className="flex flex-wrap items-center gap-3">
                    <div className="min-w-40 flex-1">
                      <div className="tnum text-label text-ink">{entry.name}</div>
                      <div className="text-label text-ink-3">{formatSize(entry.size)}</div>
                      {confirming && pendingRestore ? (
                        <div className="mt-1 text-label text-warn" data-testid="backup-confirm-counts">
                          {TEXT.backupCounts}
                          {TEXT.backupCountTasks} {pendingRestore.payload.tasks.length}
                          {TEXT.backupCountUnit} · {TEXT.backupCountDiary}{' '}
                          {pendingRestore.payload.diary.filter((item) => item.content).length}
                          {TEXT.backupCountUnit} · {TEXT.backupCountNotes}{' '}
                          {pendingRestore.payload.notes.length}
                          {TEXT.backupCountUnit} · {TEXT.backupCountFocus}{' '}
                          {pendingRestore.payload.focusSessions.length}
                          {TEXT.backupCountUnit}
                        </div>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      data-testid={`backup-restore-${entry.name}`}
                      onClick={() => void onBackupRestore(entry.name)}
                      className={`btn shrink-0 ${confirming ? 'btn-primary' : 'btn-outlined'}`}
                    >
                      {confirming ? TEXT.backupConfirm : TEXT.backupRestore}
                    </button>
                  </li>
                );
              })}
            </ul>
          )
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-4 py-4">
        <StorageUsage today={today} />
        <button type="button" data-testid="data-export" onClick={onExport} className="btn btn-outlined shrink-0">
          导出备份
        </button>
        <button
          type="button"
          data-testid="data-import"
          onClick={onImportClick}
          className={`btn shrink-0 ${pendingImport ? 'btn-primary' : 'btn-outlined'}`}
        >
          {pendingImport ? '确认导入（再点一次）' : '导入备份'}
        </button>
        {pendingImport ? (
          <button
            type="button"
            data-testid="data-import-cancel"
            onClick={() => setPendingImport(null)}
            className="btn btn-outlined shrink-0"
          >
            取消
          </button>
        ) : null}
        <button
          type="button"
          data-testid="data-export-md"
          onClick={onExportMarkdown}
          className="btn btn-outlined shrink-0"
        >
          导出 Markdown
        </button>
        <button
          type="button"
          data-testid="data-trash"
          onClick={() => dispatch({ type: 'SET_VIEW', view: 'trash' })}
          className="btn btn-outlined shrink-0"
        >
          回收站
          {tombstones.length > 0 ? `（${tombstones.length}）` : ''}
        </button>
        <button
          type="button"
          data-testid="data-archive"
          onClick={onArchive}
          disabled={archiveCount === 0}
          className="btn btn-outlined shrink-0 disabled:opacity-40"
        >
          {archiveCount > 0 ? '清理 30 天前已完成（' + archiveCount + '）' : '没有可清理的已完成任务'}
        </button>
        {/*
          二次确认统一由 ConfirmButton 负责：点一下武装、再点一下执行、
          3 秒自动收回。文案保持原样（用户熟悉的说法，不因为重构而改口）。
        */}
        <ConfirmButton
          testId="data-clear"
          variant="danger"
          confirmLabel="确认清空？再点一次"
          onConfirm={onClearConfirmed}
        >
          清空全部数据
        </ConfirmButton>

        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={onFilePicked}
        />
        {pendingImport ? (
          <p className="w-full text-label leading-relaxed text-warn">
            {importSummary}
            {` （来自 ${pendingImport.name}）`}
            —— 导入会覆盖本机现有数据，点「取消」可重新选文件
          </p>
        ) : null}
      </div>
      <div className="pb-4 text-label leading-relaxed text-ink-2">
        卸载应用或清除应用数据会带走全部记录 —— 重装前先导出备份，之后用「导入备份」恢复。
      </div>
    </>
  );
}
