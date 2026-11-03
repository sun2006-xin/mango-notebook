import { MangoMark } from './MangoMark';

/**
 * 原生 hydration 占位屏（增量设计 T03 / R6）。
 *
 * 只在 APK 冷启动的装载窗口出现：Preferences 是异步 API，StoreProvider
 * 在数据落定前门控渲染本组件，children（含 usePersist）不挂载。
 *
 * 设计约束：
 * - 用 **design token**（不再写死灰值）：index.html 的内联主题脚本在首帧前
 *   就已把 data-theme 定好，所以这里能直接拿到正确的一套颜色；
 *   万一脚本没跑到（新 origin），token 会回落到浅色那套 —— 与旧行为一致，
 *   仍然是"最多差一帧"，不会比原来更糟；
 * - 不访问 store、不发任何请求 —— 它出现时 store 还是空态；
 * - role="status"：读屏播报「正在加载」，不是死屏。
 */
export function BootSplash() {
  return (
    <div
      role="status"
      className="flex min-h-screen flex-col items-center justify-center gap-5 bg-paper"
    >
      <div className="flex items-center gap-2.5">
        <MangoMark size={34} />
        <span className="text-h1 font-bold leading-none tracking-[-0.02em] text-ink">芒果本本</span>
      </div>
      <div aria-hidden="true" className="h-1 w-24 overflow-hidden rounded-full bg-line">
        <div className="h-full w-1/2 animate-pulse rounded-full bg-ink-3" />
      </div>
      <p className="text-label text-ink-3">正在读取本机数据…</p>
    </div>
  );
}
