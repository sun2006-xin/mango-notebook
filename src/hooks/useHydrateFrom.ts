import { useCallback } from 'react';
import { hydrateFromPayload } from '../store/reducer';
import { useAppDispatch } from '../store/StoreContext';
import type { PersistedPayload } from '../types';

/* ============================================================================
   「把一份 payload 装回状态」的唯一入口 —— 以 hook 形式提供
   ----------------------------------------------------------------------------
   为什么要有这个 hook（而不是各组件自己 dispatch）：

   历史上这条路径被手抄过**四份**（云端拉取 / 合并 / 导入备份 / 回滚历史）。
   新增 `tombstones`、`focusSessions` 时漏了它们 —— 编译不报错，
   只在"导入备份后发现回收站空了 / 专注记录没了"时才暴露。

   收敛成 `hydrateFrom(payload)` 之后，四份变一份。但当设置页被拆成
   「云同步 / 数据备份 / 历史回滚」几块之后，**每个文件又得自己 import 一次
   `hydrateFromPayload`** —— 同一个"四份"问题会在文件的维度上重演。

   所以做成 hook：谁需要装回状态就调一次，构造点始终只有这一处，
   新增持久化字段时不用满仓库找调用点。

   ## 第二个参数写死 `null` 是有意的

   `hydrateFromPayload(payload, now)` 的第二个参数是"装载时间"，只有
   「刚导入了一份备份」这种需要重置计时语义的场景才传；云端拉取与历史回滚
   都该保留本机的时间锚点。这里统一给 `null`（= 用载荷自带的 savedAt），
   调用方不必理解这个差别 —— 需要特殊处理时再单开一个入口，别在这里加开关。
   ========================================================================= */

export type HydrateFrom = (payload: PersistedPayload) => void;

export function useHydrateFrom(): HydrateFrom {
  const dispatch = useAppDispatch();
  return useCallback(
    (payload: PersistedPayload) => {
      dispatch(hydrateFromPayload(payload, null));
    },
    [dispatch],
  );
}
