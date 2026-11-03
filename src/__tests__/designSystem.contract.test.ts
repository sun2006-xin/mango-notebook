import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ============================================================================
   设计系统：表面与控件只有一处定义（v0.29.4）
   ----------------------------------------------------------------------------
   这一层抽出来之前：
   - `rounded-lg border border-line bg-surface`（卡片三件套）在 10 个文件里抄了 **18 次**
   - `rounded-md border border-line bg-surface`（输入框）**34 次**，
     连焦点环那串 `focus:border-accent focus:ring-2 focus:ring-accent/15` 都单独抄了 **24 次**

   手抄的代价不是"写的时候多几行"，而是**改的时候会漏**：换一次圆角或焦点样式，
   满仓库找，漏一处屏幕上就多一块"看着不太一样"的卡片 —— 而这种差异没人报得出来，
   只会让人隐约觉得"这个应用有点糙"。

   所以这里守的是：这些字面量**不许再出现在组件里**。想改外观就去 index.css 改一行。
   例外只有 `.field` 的窄屏特例（QuickAdd 的估时输入框），它显式叠加工具类覆盖。
   ========================================================================= */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..'); // = src/

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      walk(full, out);
    } else if (name.endsWith('.tsx') || name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const FILES = walk(SRC).map((full) => ({
  rel: path.relative(SRC, full).replace(/\\/g, '/'),
  code: readFileSync(full, 'utf8'),
}));

const CSS = readFileSync(path.join(SRC, 'index.css'), 'utf8');

/** 收集某一串字面量出现在哪些文件（行号不重要，文件清单足够定位） */
function whoHas(needle: string): string[] {
  return FILES.filter((f) => f.code.includes(needle)).map((f) => f.rel);
}

describe('卡片与输入框：只认组件类', () => {
  it('没有组件再手抄卡片三件套（应用 .card）', () => {
    expect(whoHas('rounded-lg border border-line bg-surface')).toEqual([]);
  });

  it('没有组件再手抄输入框三件套（应用 .field）', () => {
    expect(whoHas('rounded-md border border-line bg-surface')).toEqual([]);
  });

  it('焦点环那串也收进了 .field（否则改一次焦点样式要满仓库找）', () => {
    expect(whoHas('focus:ring-2 focus:ring-accent/15')).toEqual([]);
  });

  it('组件类本身只在一处定义', () => {
    for (const cls of ['.card {', '.field {', '.card-dashed {', '.banner-warn {']) {
      expect(CSS, `${cls} 没定义`).toContain(cls);
    }
  });
});

describe('动效：少量、克制、可关闭', () => {
  it('三个进入动效都在 200ms 以内（再长就有"卡了一下"的错觉）', () => {
    for (const name of ['summary-in', 'view-in', 'row-in']) {
      const at = CSS.indexOf(`@keyframes ${name}`);
      expect(at, `${name} 没了`).toBeGreaterThan(-1);
    }
    // 取每个动画的时长，逐个卡 200ms
    for (const cls of ['.summary-enter', '.view-enter', '.row-enter']) {
      const at = CSS.indexOf(cls);
      const block = CSS.slice(at, at + 200);
      const match = /(\d+)ms/.exec(block);
      expect(match, `${cls} 没写时长`).not.toBeNull();
      expect(Number(match?.[1])).toBeLessThanOrEqual(200);
    }
  });

  it('全部尊重 prefers-reduced-motion（关得掉，不是"写上就算"）', () => {
    const at = CSS.indexOf('prefers-reduced-motion');
    expect(at).toBeGreaterThan(-1);
    const block = CSS.slice(at, at + 300);
    for (const cls of ['.summary-enter', '.view-enter', '.row-enter']) {
      expect(block, `${cls} 没在减少动效里关掉`).toContain(cls);
    }
  });

  it('任务行只用 opacity 淡入，不碰 transform（滑动删除正占着它）', () => {
    const at = CSS.indexOf('@keyframes row-in');
    const block = CSS.slice(at, CSS.indexOf('}', at) + 1);
    expect(block).not.toContain('transform');
  });
});
