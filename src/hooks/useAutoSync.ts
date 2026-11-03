import { useEffect, useRef } from 'react';
import { isCloudRuntimeAvailable } from '../lib/cloud';
import {
  AUTO_SYNC_BOOT_DELAY_MS,
  AUTO_SYNC_INTERVAL_MS,
  resumeAutoSync,
  runAutoSync,
} from '../lib/cloudSync';
import type { PersistedPayload } from '../types';

/* ============================================================================
   后台自动同步（App 级常驻）

   ----------------------------------------------------------------------------
   为什么要有它（用户报的"同步有时候不管用"）
   ----------------------------------------------------------------------------
   原来的同步只有一个触发点：**本机保存**。流程是"保存 → 防抖 300ms → 先拉云端
   → 合并 → 推回"。也就是说，另一台设备改了东西，这一台**只要不动任何数据**，
   就永远收不到 —— 打开电脑看一眼、不点「立即同步」，看到的就是旧数据。

   这里补上三个触发点，把"推送型同步"补成"双向同步"：
   ① 启动后延迟 2.5s 拉一次（先让首屏渲染完，不与启动装载抢资源）；
   ② 每 60 秒拉一次，**只在页面可见时**（后台标签页省电，也避免被浏览器节流）；
   ③ 切回前台 / 网络恢复（`online`）时立刻拉一次 —— 这是"合上笔记本再打开"
      和"地铁出来恢复信号"两个最典型的场景。

   方向判定**不新造逻辑**：一律走 `runSync` → `decideSyncAction`
   （内容优先于时间、空数据绝不上推、两边都有就按 id 合并）。

   ----------------------------------------------------------------------------
   离线（⑦）：网络恢复时必须**解除停摆**
   ----------------------------------------------------------------------------
   `runAutoSync` 在离线时直接放过这一轮（不累计失败），但用户仍可能在
   "连不上"的网络上攒够 3 次失败被停摆。网络回来时若只补一次 tick，
   `runAutoSync` 会因停摆直接返回 null —— 明明能连上了却同步不了。
   所以 `online` 事件必须先 `resumeAutoSync()` 再 tick。
   ========================================================================= */

/**
 * @param getLocal 取"本机当前状态"的载荷；返回 null 表示本机从未落盘（新设备）。
 *                 用 getter 而不是直接传值：state 每次 render 都是新对象，
 *                 传值会让 effect 的依赖一直变，effect 被反复重建。
 */
export function useAutoSync(getLocal: () => PersistedPayload | null): void {
  const localRef = useRef(getLocal);
  localRef.current = getLocal;

  useEffect(() => {
    // 网页版发布域名 / APK（hostname 已是发布域名）/ 桌面端带 ?cloud=1 才有云
    if (!isCloudRuntimeAvailable()) return undefined;

    let stopped = false;
    /**
     * 应用刚启动：上一会话的"连续失败停摆"不该跨会话延续（进程都重启了）。
     * 真正还有没有没送达的改动，由 outbox（设备本地落盘）说了算 ——
     * 有就靠下面这一轮同步补推，没有就只是白拉一次，代价可忽略。
     */
    resumeAutoSync();
    const tick = (): void => {
      if (stopped) return;
      // 页面在后台：不轮询。切回前台时由 visibilitychange 补一次
      if (document.visibilityState !== 'visible') return;
      void runAutoSync(() => localRef.current());
    };

    const boot = window.setTimeout(tick, AUTO_SYNC_BOOT_DELAY_MS);
    const timer = window.setInterval(tick, AUTO_SYNC_INTERVAL_MS);

    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') tick();
    };
    /**
     * 网络恢复 = **最有说服力的一次"可以重试了"**。
     *
     * 所以这里除了补一次同步，还要 `resumeAutoSync()` 解除"连续失败停摆"：
     * 否则用户在离线时攒下的失败次数（3 次）会让自动同步一直不跑，
     * 明明网络已经恢复了，却要手动点「立即同步」才行 —— 这正是 ⑦ 修的毛病。
     * 待上传的改动本身记在 outbox 里（见 lib/outbox.ts），这一跑就会被补推上去。
     */
    const onOnline = (): void => {
      resumeAutoSync();
      tick();
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);

    return () => {
      stopped = true;
      window.clearTimeout(boot);
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
    };
  }, []);
}
