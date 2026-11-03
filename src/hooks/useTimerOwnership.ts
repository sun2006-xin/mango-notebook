import { useEffect, useRef } from 'react';
import { FOCUS_RUNNING_KEY } from '../constants';
import type { RunningTimer } from '../lib/timer';

/* ============================================================================
   计时器的「跨标签页归属」

   三套计时器（番茄钟 / 秒表 / 提醒）共用磁盘上的**同一个** `FOCUS_RUNNING_KEY`
   —— 这是刻意的：那个 key 就是"当前有没有人在计时"的唯一真相，天然互斥。

   但它只在**同一份 localStorage** 内互斥。同一个浏览器开两个标签页时：
     A 在跑番茄钟 → B 点「开始专注」→ B 用新 id 覆盖磁盘 →
     A、B 各自 tick 到点都会 dispatch FOCUS_LOG，两个 id 不同 →
     reducer 的幂等挡不住 → **同一时段凭空多记一段**；
     同时 A 的运行态被覆盖，A 刷新后接不回来。

   这里做最小可用的收敛：**后手的标签页说了算，先手的让位**。
   - 监听 storage 事件（只在**其它**标签页写入时触发，自己写不会触发）；
   - 发现磁盘上的 id 不是自己手上这个（或者被清掉了）→ 回调让位：
     清内存、**不写 FOCUS_LOG**（这段没跑完，不该记）、提示用户一句；
   - 让位方**绝不回写磁盘**，否则两个标签页会互相清对方的运行态，抖成 ping-pong。

   为什么不让"先手赢"：先手赢需要争抢锁（写入 + 回读校验 + 超时），
   代价大得多，而两个标签页同时计同一段时间本来就是异常操作 ——
   让位并说明白，比静默地记两段假数据诚实。
   ========================================================================= */

export interface TimerOwnershipOptions {
  /** 这一刻本标签页是不是真的在计时（不在计时就不需要让位） */
  active: boolean;
  /** 本标签页手上这个运行态的 id；null = 没有 */
  runId: string | null;
  /** 让位动作：清内存 + 提示，**不许写磁盘** */
  onYield: (reason: 'taken-over' | 'cleared') => void;
}

/** 从 storage 事件的 newValue 里安全取出 id（脏数据 / 空值都返回 null） */
function idOf(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<RunningTimer>;
    return typeof parsed?.id === 'string' && parsed.id ? parsed.id : null;
  } catch {
    return null;
  }
}

export function useTimerOwnership({ active, runId, onYield }: TimerOwnershipOptions): void {
  // 用 ref 读最新值：监听器只注册一次，不能因为 active/runId 变化反复重建
  const stateRef = useRef({ active, runId, onYield });
  stateRef.current = { active, runId, onYield };

  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key !== FOCUS_RUNNING_KEY) return;
      const current = stateRef.current;
      if (!current.active) return;

      const incomingId = idOf(event.newValue);
      if (incomingId === null) {
        // 别的标签页把运行态清掉了（放弃 / 切模式 / 记录完成）
        current.onYield('cleared');
        return;
      }
      if (incomingId !== current.runId) {
        // 别的标签页开了新的一段 —— 它后手，它说了算
        current.onYield('taken-over');
      }
    };

    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
}
