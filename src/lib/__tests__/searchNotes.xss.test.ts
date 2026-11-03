import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { countHits, searchAll, type SearchResult } from '../search';
import { stripMarkdown } from '../markdown';
import type { DiaryEntry, Note, Task } from '../../types';

/* ============================================================================
   Q2 第 3 点：searchAll 的 notes 第四参 + 记事本搜索 + XSS 安全

   1) searchAll 第四参 `notes` 默认 []，老的"三参"调用零改动仍可用；
   2) countHits 含 notes；
   3) 笔记预览走纯文本提取（stripMarkdown），XSS 载荷作为文本原样保留，
      绝不插入真实元素 / 执行脚本。
   ========================================================================= */

const tasks: Task[] = [];
const diary: DiaryEntry[] = [];
const notes: Note[] = [
  { id: 'n1', title: 'I2C 时序', content: 'WHO_AM_I = 0x68', category: '', pinned: false, createdAt: '', updatedAt: '' },
  { id: 'n2', title: '报错与解法', content: '白屏原因：**CSP** 拦截了内联脚本', category: '', pinned: false, createdAt: '', updatedAt: '' },
];

describe('searchAll：notes 第四参向后兼容 + 记事本搜索', () => {
  it('老三参调用（不传 notes）不抛异常，notes 返回空数组', () => {
    const r = searchAll('x', tasks, diary); // 故意只传三参
    expect(Array.isArray(r.notes)).toBe(true);
    expect(r.notes).toHaveLength(0);
    expect(r.tasks).toHaveLength(0);
    expect(r.diary).toHaveLength(0);
  });

  it('命中记事标题', () => {
    const r = searchAll('I2C', tasks, diary, notes);
    expect(r.notes.map((n) => n.id)).toEqual(['n1']);
  });

  it('命中记事正文', () => {
    const r = searchAll('CSP', tasks, diary, notes);
    expect(r.notes.map((n) => n.id)).toEqual(['n2']);
  });

  it('notes 分区不影响 tasks/diary 计数', () => {
    const r = searchAll('I2C', tasks, diary, notes);
    expect(r.tasks).toHaveLength(0);
    expect(r.diary).toHaveLength(0);
    expect(r.notes).toHaveLength(1);
  });

  it('countHits 合计三类（含 notes）', () => {
    const r: SearchResult = { tasks: [{} as Task], diary: [{} as DiaryEntry], notes: [{} as Note, {} as Note] };
    expect(countHits(r)).toBe(4);
  });
});

describe('XSS 安全：笔记预览是纯文本（Q2 第 3 点核心）', () => {
  it('stripMarkdown 把 XSS 载荷当作普通文本原样保留', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const out = stripMarkdown(evil);
    // 字符串里仍含字面量 <img ...>，说明它没被当标签解析 —— 作为 React 文本子节点渲染时
    // React 会自行转义 < 为 &lt;，从而不会插入真实 <img> 元素、不会执行脚本。
    expect(out).toContain('<img');
    expect(out).toContain('onerror=alert(1)');
    // 关键反证：不能出现"闭合标签被去掉但属性保留"之类的已解析痕迹
    expect(out).toContain('<img src=x onerror=alert(1)>');
  });

  it('脚本标签同样作为纯文本原样返回（不执行、不丢弃结构）', () => {
    const evil = '<script>alert(document.cookie)</script>';
    const out = stripMarkdown(evil);
    expect(out).toContain('<script>');
    expect(out).toContain('</script>');
    expect(out).toContain('alert(document.cookie)');
  });

  it('合法的 Markdown 标记被去掉（预览里不该出现 ** 这类噪音）', () => {
    expect(stripMarkdown('**重点**')).toBe('重点');
    expect(stripMarkdown('# 标题')).toBe('标题');
    expect(stripMarkdown('- 列表项')).toBe('列表项');
  });
});

/* ---------------------------------------------------------------------------
   源码级兜底：SearchOverlay 的笔记预览必须
   （1）不使用 dangerouslySetInnerHTML；
   （2）把 notePreview(note.content) 当 React 文本子节点渲染（落在 <p> 内）；
   （3）notePreview 来自 markdown.ts 的纯文本提取 stripMarkdown。
   与 cloudSync.runtime.test.ts 的"红线兜底（源码级）"同款手法：
   非渲染可测的 React，用源码扫描盯住契约，防止回归。
   --------------------------------------------------------------------------- */
describe('P0 源码级：SearchOverlay 记事预览 XSS 红线', () => {
  function read(relative: string): string {
    return readFileSync(new URL(relative, import.meta.url), 'utf8');
  }

  it('SearchOverlay 不用 dangerouslySetInnerHTML（预览走 React 文本节点）', () => {
    const src = read('../../components/common/SearchOverlay.tsx');
    // 先剥掉注释再扫：源码里有一句"绝不用 dangerouslySetInnerHTML"的**注释**，
    // 裸 toContain 会被这条注释误伤成假红。只有真实用法才是危险信号。
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '');
    expect(code).not.toContain('dangerouslySetInnerHTML');
    // 反向坐实：预览确实是 React 文本子节点，不是 __html
    expect(code).toContain('{notePreview(note.content)}');
    expect(code).not.toContain('__html');
  });

  it('notePreview 来自 markdown.ts 的 stripMarkdown（纯文本提取）', () => {
    const src = read('../../components/common/SearchOverlay.tsx');
    expect(src).toContain("import { stripMarkdown } from '../../lib/markdown'");
    // notePreview 函数体内部调用 stripMarkdown
    const fnStart = src.indexOf('function notePreview');
    const fn = src.slice(fnStart, src.indexOf('return (', fnStart));
    expect(fn).toContain('stripMarkdown(content)');
  });

  it('笔记预览作为 React 文本子节点渲染（落在 <p> 内，非 dangerouslySetInnerHTML）', () => {
    const src = read('../../components/common/SearchOverlay.tsx');
    // 记事本分区里应有「记事本 · N」标题 + 渲染 notePreview(note.content)
    expect(src).toContain('记事本 · {result.notes.length}');
    expect(src).toContain('{notePreview(note.content)}');
    // 预览外层是 <p>，且内容是文本子节点（不是 __html）
    expect(src).toMatch(/<p[^>]*>[\s\S]*?\{notePreview\(note\.content\)\}/);
  });

  it('浮层把 notes 接入 searchAll 第四参，并暴露 onOpenNote 回调', () => {
    const src = read('../../components/common/SearchOverlay.tsx');
    // useMemo 调用 searchAll 时把 notes 作为第四参传入
    expect(src).toMatch(/searchAll\(query, tasks, diary, notes\)/);
    // 点笔记结果时调用 onOpenNote(note.id)
    expect(src).toContain('onClick={() => onOpenNote(note.id)}');
  });
});
