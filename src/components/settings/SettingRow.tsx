import type { ReactNode } from 'react';

/* ============================================================================
   设置页的一行：「标题 + 一句说明 + 右侧控件」

   为什么抽出来：设置页里这个结构重复了十几次，每次都是同一段
   `<div class="flex flex-wrap items-center gap-4 border-b border-line py-4">`
   加上「左文右控件」的排版。重复的不是"写起来麻烦"，而是**改起来危险**：

   - 这一行在 320px 下会换行（`flex-wrap`），某个控件如果忘了 `shrink-0`
     就会被压成一条线、或者把整行撑出屏幕 —— 移动端横向溢出那次就是这么来的；
   - 行间距 / 分隔线 / 说明字号散落在十几处时，调一次样式要改十几遍，
     漏一处就出现"某一行看着不一样"。

   现在只有这一份排版，改一次全生效。

   ⚠️ 右侧控件由调用方给，`SettingRow` **不替它加 `shrink-0`**：
   需要收缩的（比如分类名输入框）和不许收缩的（Segmented / 按钮）是相反的，
   统一加会悄悄改掉某些行的行为。这一点由 `audit:layout`（真实 Chromium
   量排版）与 `audit:longterm`（控件可点）两道实测兜着。
   ========================================================================= */

export interface SettingRowProps {
  /** 行标题（加粗那一行） */
  label: ReactNode;
  /** 标题下面那句说明；不传则不占位 */
  hint?: ReactNode;
  /** 右侧控件 */
  children: ReactNode;
}

export function SettingRow({ label, hint, children }: SettingRowProps) {
  return (
    <div className="flex flex-wrap items-center gap-4 border-b border-line py-4">
      <div className="min-w-32 flex-1">
        <div className="text-body font-semibold">{label}</div>
        {hint ? <div className="mt-1 text-label text-ink-2">{hint}</div> : null}
      </div>
      {children}
    </div>
  );
}
