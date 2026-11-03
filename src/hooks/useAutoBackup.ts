import { useEffect } from 'react';
import { TOAST_TIMEOUT } from '../constants';
import { useToast } from './useToast';
import { todayKey } from '../lib/date';
import { hasDesktopBackup, writeDesktopBackup } from '../lib/desktopBackup';
import { buildBackupPayload } from '../lib/storage';
import { useAppState } from '../store/StoreContext';
import type { DateKey } from '../types';

/* ============================================================================
   桌面端自动备份（F4）

   节奏：**启动一次 + 每小时查跨天**。
   为什么不在每次保存后写文件：localStorage 已经有一份 + 快照两份，
   再加上每次 debounce 都往磁盘写一个 JSON，纯粹是给 SSD 找事做。
   每天一份的粒度对"误删 / 数据被写坏"这类事故已经足够 ——
   真正的日常撤销靠的是任务墓碑与记事软删除。

   `lastBackupDay` 放在**模块级**而不是 useState：
   - 它表达的是"这个进程今天已经备过份了"，与组件生命周期无关；
   - useAutoBackup 的 effect 会因为数据变化频繁重跑（依赖里有各个集合），
     用 state 存会让守卫跟着 effect 一起重置，等于每次编辑都写一次文件。
   ========================================================================= */

let lastBackupDay: DateKey | null = null;
/** 今天是否已经提示过"备份失败"（同一天最多烦一次） */
let failureNotifiedDay: DateKey | null = null;
/** 正在写盘：防抖后的数据变化会把 effect 重跑很多次，不能并发写同一个文件 */
let inFlight = false;

/** 仅供测试重置（不对外暴露语义） */
export function __resetAutoBackupGuard(): void {
  lastBackupDay = null;
  failureNotifiedDay = null;
  inFlight = false;
}

/**
 * 仅供测试读取：当天是否已成功备份 / 是否已提示过失败。
 *
 * 为什么要暴露这个状态：这套逻辑的核心行为是"**失败不占用当天的名额**"
 * （否则一次磁盘满就让今天再也不备份），而它没有 UI，只能从状态上验证。
 */
export function __getAutoBackupState(): {
  lastBackupDay: DateKey | null;
  failureNotifiedDay: DateKey | null;
  inFlight: boolean;
} {
  return { lastBackupDay, failureNotifiedDay, inFlight };
}

export function useAutoBackup(today: DateKey): void {
  const state = useAppState();
  const toast = useToast();
  const { tasks, settings, diary, tombstones, focusSessions, notes } = state;

  useEffect(() => {
    // 网页 / 安卓：没有文件写权限，靠 storage.ts 的双快照兜底，这里什么都不做
    if (!hasDesktopBackup()) return undefined;

    const backupFor = (day: DateKey): void => {
      if (lastBackupDay === day || inFlight) return;
      inFlight = true;
      /**
       * 用 buildBackupPayload 而不是手拼对象：那是**唯一**一份
       * "导出备份"的载荷构造函数，schemaVersion 写 1 以便旧版本也能读回来。
       * 手拼必然会在加字段时漏（本项目已经因为手抄 HYDRATE 踩过一次）。
       *
       * 传整个 `state` 而不是六个字段：漏掉哪个由类型（`BackupSource`）兜住，
       * 不必在这里再抄一遍字段名。
       */
      const payload = buildBackupPayload(state);
      /**
       * ⚠️ **成功才占用当天的名额**。
       *
       * 原实现是先把 `lastBackupDay = day` 置上、再 `void writeDesktopBackup(...)`
       * 把结果丢掉 —— 于是磁盘满 / 无写权限 / 杀软拦截时：
       *   ① 备份没写成，用户**完全不知道**（当天不会再有任何尝试）；
       *   ② 一小时后重试的守卫也失效了（名额已被占），等于今天彻底没有备份。
       * 而"备份"这件事恰恰是在出事那天必须可靠的。现在：失败不占名额，
       * 整点自动重试，并且当天提示一次（不反复烦人）。
       */
      void writeDesktopBackup(JSON.stringify(payload), `${day}.json`).then(
        (ok) => {
          inFlight = false;
          if (ok) {
            lastBackupDay = day;
            failureNotifiedDay = null;
            return;
          }
          if (failureNotifiedDay !== day) {
            failureNotifiedDay = day;
            toast.show(
              '自动备份没写成功（磁盘已满或无写权限），稍后会自动重试',
              null,
              TOAST_TIMEOUT.info,
              'warn',
            );
          }
        },
        () => {
          // 写盘函数理论上不抛，兜一层：抛了也不能把 inFlight 卡住
          inFlight = false;
        },
      );
    };

    backupFor(today);
    const timer = setInterval(() => backupFor(todayKey(settings.dayStartHour)), 60 * 60 * 1000);
    return () => clearInterval(timer);
    /**
     * 依赖仍然是**数据字段**而不是 `state`：`state` 里还有抽屉 / 光标这些 UI 状态，
     * 拿它当依赖会让 effect 每次输入都重跑 → 定时器被反复重建，
     * 于是"每小时查一次跨天"永远等不到那一小时。
     * 只改 UI 时闭包里的数据与当前完全一致，所以不会读到旧值。
     */
  }, [today, tasks, settings, diary, tombstones, focusSessions, notes, toast]); // eslint-disable-line react-hooks/exhaustive-deps
}
