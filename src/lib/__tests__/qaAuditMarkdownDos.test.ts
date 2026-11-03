import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../markdown';

/* ============================================================================
   QA 审计（v0.7.0）：极简 Markdown 渲染器的"深引用"递归会爆栈

   `renderMarkdown()` 处理引用块时是**递归**的：
     src/lib/markdown.ts:196-203
       if (RE_QUOTE.test(line)) {
         ...
         blocks.push(`<blockquote>${renderMarkdown(body.join('\n'))}</blockquote>`);
       }
   每一层只剥掉一个前导 `>`，所以一段 `n` 个 `>` 的文本会递归 `n` 层。
   而 DIARY_MAX = 5000、笔记 content 上限 20000（sanitizeNotes 截断） ——
   **一篇全由 `>` 组成的日记/笔记就足以打爆调用栈**。

   危险的不是抛异常本身，而是它抛在哪：
     src/views/DiaryView.tsx:176  dangerouslySetInnerHTML={{ __html: renderMarkdown(draft) }}
     src/views/NotesView.tsx:323  dangerouslySetInnerHTML={{ __html: renderMarkdown(draft.content) }}
   都在**渲染期**同步求值，而全工程**没有 ErrorBoundary**（已 grep 确认）。
   → 一次 RangeError 会让整棵 React 树卸载＝白屏，用户连"编辑/改回来"的入口都没了。

   触发路径并不苛刻：日记内容会经云同步从别的设备过来（sanitizeDiary 只截断长度、
   不动内容），所以**任何一台设备写成这样，所有设备点开预览就白屏**。
   =========================================================================

   ── 修复后（v0.7.1, P0-2）────────────────────────────────────────────
   ① renderMarkdown 加了 `depth` 参数限深（MAX_QUOTE_DEPTH=10）：
      超过阈值后剩下的 `>` 不再继续递归、直接当普通文本（转义后）渲染，
      n 个 `>` 不再等于 n 层调用栈；
   ② App.tsx 外层加了 AppErrorBoundary（getDerivedStateFromError / componentDidCatch）：
      万一还有别的渲染期异常，也只降级成一张"内容无法显示"的卡片，而不是白屏。
   A 组与 B3 已随之翻转为**新契约**：深度不再有任何上限式的崩溃门槛。
   ========================================================================= */

describe('A. 深引用递归：renderMarkdown 不再抛 RangeError', () => {
  it('A1 5000 个前导 > （= DIARY_MAX，日记的完整上限）→ 不抛异常', () => {
    const diaryContent = '>'.repeat(5000);

    expect(() => renderMarkdown(diaryContent)).not.toThrow();
    expect(() => renderMarkdown(diaryContent)).not.toThrow(RangeError);
    // 内容一个字不丢（剩下的 > 被转义成 &gt; 后原样留下）
    expect(renderMarkdown(diaryContent)).toContain('&gt;');
  });

  it('A2 20000 个前导 > （= 笔记 content 上限）→ 同样不抛异常', () => {
    expect(() => renderMarkdown('>'.repeat(20000))).not.toThrow();
  });

  it('A3 深度不再有崩溃门槛：限深之后多深都能渲染出来', () => {
    const overflowsAt = (depth: number): boolean => {
      try {
        renderMarkdown('>'.repeat(depth) + 'x');
        return false;
      } catch {
        return true;
      }
    };
    // 100 层 / 5000 层（日记上限）/ 20000 层（笔记上限）都必须扛得住
    expect(overflowsAt(100)).toBe(false);
    expect(overflowsAt(5000)).toBe(false);
    expect(overflowsAt(20000)).toBe(false);
  });

  it('A4 对照组：普通长文本 / 普通多行引用不炸（说明这是"深度"问题，不是"长度"问题）', () => {
    expect(() => renderMarkdown('a'.repeat(20000))).not.toThrow();
    expect(() => renderMarkdown(Array(5000).fill('> 一行引用').join('\n'))).not.toThrow();
  });
});

describe('B. 影响面：渲染期求值仍在，但已有 ErrorBoundary 兜底', () => {
  /**
   * v0.25 起预览 HTML 改成 `useMemo` 缓存（每次按键都要重渲染整棵树太贵）。
   * 但**求值点仍在渲染期、仍是同步的** —— useMemo 不是 try/catch，
   * renderMarkdown 一旦抛异常照样往外冒，所以 ErrorBoundary 的兜底依然必需。
   * 契约相应改成：`renderMarkdown(` 是同步直调 + 注入的是缓存变量 previewHtml。
   */
  it('B1 DiaryView 在渲染期同步求值 renderMarkdown，没有 try/catch', () => {
    const code = readFileSync(new URL('../../views/DiaryView.tsx', import.meta.url), 'utf8');
    // 缓存变量里装的仍是渲染期同步求值的 renderMarkdown(draft)
    expect(code).toMatch(/const previewHtml = useMemo\([\s\S]{0,120}renderMarkdown\(draft\)/);
    expect(code).toMatch(/dangerouslySetInnerHTML=\{\{ __html: previewHtml \}\}/);
    // useMemo ≠ try/catch：整个文件里没有任何 catch 兜住这次求值
    expect(code).not.toContain('catch');
  });

  it('B2 NotesView 同样是渲染期同步求值', () => {
    const code = readFileSync(new URL('../../views/NotesView.tsx', import.meta.url), 'utf8');
    expect(code).toMatch(/const previewHtml = useMemo\([\s\S]{0,160}renderMarkdown\(draft\?\.content/);
    expect(code).toMatch(/dangerouslySetInnerHTML=\{\{ __html: previewHtml \}\}/);
    expect(code).not.toContain('catch');
  });

  it('B3 App 外层有 ErrorBoundary —— 渲染期抛异常降级成卡片，不再整树卸载（白屏）', () => {
    const roots = ['src/App.tsx', 'src/main.tsx'];
    const hits = roots.filter((rel) => {
      const code = readFileSync(new URL(`../../../${rel}`, import.meta.url), 'utf8');
      return /ErrorBoundary|componentDidCatch|getDerivedStateFromError/.test(code);
    });
    // 至少一个根文件里装有边界；当前实现落在 App.tsx（AppErrorBoundary 包住 AppShell）
    expect(hits).toContain('src/App.tsx');
    const app = readFileSync(new URL('../../../src/App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('getDerivedStateFromError');
    expect(app).toContain('componentDidCatch');
    // 降级 UI 要给用户留可恢复入口，而不是死路一条
    expect(app).toContain('内容无法显示');
    expect(app).toContain('重试');
  });
});

describe('C. 转义仍然有效（对照：本次审计没有发现 XSS 通道）', () => {
  it('C1 <script> / 事件属性 / javascript: 链接均被转义或降级', () => {
    const out = renderMarkdown('<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n<img src=x onerror=alert(1)>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;script&gt;');
  });
});
