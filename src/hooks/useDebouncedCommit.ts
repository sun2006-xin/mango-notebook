import { useCallback, useEffect, useRef } from 'react';

/* ============================================================================
   防抖提交（长文本输入用）
   ----------------------------------------------------------------------------
   为什么需要：日记正文 / 记事正文 / 抽屉标题备注这三处，原来**每敲一个字就
   dispatch 一次全局 store**。一次按键的代价是：全树重渲 + 任务列表整表 map +
   每个字段时钟重算 + 300ms 后的整个 payload 序列化。长文本上这就是"打字发涩"的
   正体，而不是某个组件写得慢。

   为什么这件事拖了这么久没做：它有一个**必须解决的风险** —— 防抖意味着"最后一次
   编辑还停在内存里"，如果这时组件卸载 / 用户切走 / 应用被杀，那几个字就丢了。
   所以这个 hook 的契约不是"延迟提交"，而是：

     **任何一次提交都会被送达，除非进程被强杀。**

   四条兜底，缺一不可：
     ① 卸载时 flush（切换记事 / 关抽屉 / 换视图都会卸载）；
     ② `pagehide` + `visibilitychange(hidden)` 时 flush（切后台、按返回键、
        关标签页 —— 安卓上杀进程前一定会走到这两个之一）；
     ③ 新的输入到来时，只重置计时器，**不丢上一次的值**（value 永远取最新的）；
     ④ flush 之后计时器必须清掉，避免"提交两次"（第二次会带旧值覆盖新值）。

   ⚠️ 刻意**不做**"外部值变化时自动同步"：草稿的真相在调用方手里（它们各自有
   本地 state）。这个 hook 只负责"别丢"，不负责"对账"——混在一起会变成第二份
   store，而两份 store 迟早不一致。
   ========================================================================= */

export interface DebouncedCommitOptions<T> {
  /** 真正落库的动作（dispatch / patch） */
  commit: (value: T) => void;
  /** 静默时长（毫秒）。默认 350：比落盘的 300ms 稍长，避免"提交一次、又落盘一次"抖动 */
  delayMs?: number;
}

export interface DebouncedCommitApi<T> {
  /** 记下最新值并重置计时器（输入时调用） */
  schedule: (value: T) => void;
  /** 立刻把待提交的值送出去（切换对象 / 关闭前调用） */
  flush: () => void;
  /** 是否有未提交的值 */
  isDirty: () => boolean;
  /**
   * 丢弃待提交的值（**不**提交）。
   *
   * 用在"用户主动清空 / 删除"这类动作之前：如果先 flush 再清空，那几秒的草稿
   * 会被写回去一次（清空之后又冒出来）；如果不管它，定时器到点又会把旧内容
   * 覆盖到已经清空的记录上。所以必须有"取消"这一档。
   */
  cancel: () => void;
}

export function useDebouncedCommit<T>({
  commit,
  delayMs = 350,
}: DebouncedCommitOptions<T>): DebouncedCommitApi<T> {
  const pending = useRef<{ value: T } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** commit 放进 ref：调用方常写成内联箭头，直接进依赖会让计时器反复重建 */
  const commitRef = useRef(commit);
  commitRef.current = commit;

  const clearTimer = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const flush = useCallback(() => {
    clearTimer();
    const item = pending.current;
    pending.current = null;
    if (item) commitRef.current(item.value);
  }, [clearTimer]);

  const schedule = useCallback(
    (value: T) => {
      pending.current = { value };
      clearTimer();
      timer.current = setTimeout(() => {
        timer.current = null;
        const item = pending.current;
        pending.current = null;
        if (item) commitRef.current(item.value);
      }, delayMs);
    },
    [clearTimer, delayMs],
  );

  /** 兜底：卸载 / 切后台 / 关页面都把待提交的值送出去 */
  useEffect(() => {
    const onHide = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') flush();
      else if (typeof document === 'undefined') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHide);
      // 卸载时也要送 —— 切记事、关抽屉都走这条
      flush();
    };
  }, [flush]);

  const cancel = useCallback(() => {
    clearTimer();
    pending.current = null;
  }, [clearTimer]);

  return { schedule, flush, cancel, isDirty: () => pending.current !== null };
}
