import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/* ============================================================================
   触控热区下限（v0.25）

   手机上"点不中"几乎都不是逻辑 bug，而是**热区太小**：
   图标按钮做成 32×32（h-8 w-8）时，视觉上能看见，手指点上去却经常落空
   —— 尤其是列表里相邻两行各有一个图标的时候，误触到隔壁还会改错数据。

   统一口径：**图标按钮 ≥ 44×44（h-11 w-11）**。
   来不及改外观的（密集列表里的复选框）允许"视觉小、热区大"：
   用 `after:-inset-*` 伪元素把可点区撑开，外观一点不变。

   为什么这条要写成源码扫描而不是截图比对：
   jsdom 没有排版引擎，`getBoundingClientRect()` 恒为 0，
   Tailwind 的类名就是这里唯一的真相，也只能靠类名守住。
   ========================================================================= */

/** 形如 `h-8 w-8` / `w-9 h-9` 的尺寸对（Tailwind 1 单位 = 4px） */
const SQUARE = /\b(h|w)-(\d+) (w|h)-(\d+)\b/g;
const MIN_UNITS = 11; // 11 × 4 = 44px

interface Hit {
  file: string;
  line: number;
  text: string;
  units: number;
  expanded: boolean;
}

/** 命中的尺寸对所在的那个 JSX 开标签（从匹配点往前的 `<` 到往后的 `>`） */
function enclosingTag(code: string, index: number): string {
  const open = code.lastIndexOf('<', index);
  const close = code.indexOf('>', index);
  if (open < 0) return '';
  return code.slice(open, close < 0 ? code.length : close + 1);
}

function scan(): Hit[] {
  const files = listTsx('src');
  const hits: Hit[] = [];
  for (const rel of files) {
    const code = readFileSync(new URL(`../../../${rel}`, import.meta.url), 'utf8');
    // 先剥注释：注释里会引用同样的类名做说明，不能算命中
    const stripped = code
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/[^\n]*/g, '');
    for (const m of stripped.matchAll(SQUARE)) {
      // 只看"整体都小"的方块：h-9 w-14 这种有文字的按钮不算（高 36 但宽 56，
      // 手指不会点空），热力图色块/图例色卡也不是点击目标
      const units = Math.max(Number(m[2]), Number(m[4]));
      if (units >= MIN_UNITS) continue;
      // 必须是可点击元素：装饰用的 <span> 色块不参与
      const tag = enclosingTag(stripped, m.index!);
      if (!/^<button\b/.test(tag) && !/role="button"/.test(tag)) continue;
      hits.push({
        file: rel,
        line: stripped.slice(0, m.index!).split('\n').length,
        text: m[0],
        units,
        // 同一个按钮上有没有撑热区的伪元素
        expanded: /after:-inset-/.test(tag),
      });
    }
  }
  return hits;
}

function listTsx(dir: string): string[] {
  // 同步递归：测试里不用 glob，避免再引一个依赖
  const abs = fileURLToPath(new URL(`../../../${dir}`, import.meta.url));
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      const rel = `${dir}/${full.slice(abs.length + 1).replace(/\\/g, '/')}`;
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.tsx')) out.push(rel);
    }
  };
  walk(abs);
  return out;
}

describe('图标按钮触控热区 ≥ 44×44', () => {
  it('全工程没有"小于 44 且没撑热区"的正方形按钮', () => {
    const bad = scan().filter((hit) => !hit.expanded);
    expect(
      bad.map((hit) => `${hit.file}:${hit.line} ${hit.text} (${hit.units * 4}px)`),
    ).toEqual([]);
  });

  it('例外必须留痕：视觉小的一方块，热区用 after 伪元素撑开', () => {
    // 目前只有一处：任务抽屉里的子任务复选框（32px 视觉 / 40px 热区）。
    // 例外被消灭掉（都改成 44）当然更好 —— 所以这里不要求"必须有例外"，
    // 只要求"凡是例外，都得是它、且是撑过热区的"，否则判红。
    for (const hit of scan().filter((item) => item.expanded)) {
      expect(hit.file).toBe('src/components/task/TaskDrawer.tsx');
    }
  });

  it('导航与日历这类"每日连点"的按钮已经放大到 44', () => {
    const nav = readFileSync(new URL('../layout/Nav.tsx', import.meta.url), 'utf8');
    const cal = readFileSync(new URL('../settings/HabitCalendar.tsx', import.meta.url), 'utf8');
    expect(nav).toContain('h-11 w-11');
    expect(nav).not.toContain('h-9 w-9');
    expect(cal).toContain('h-11 w-11');
    expect(cal).not.toContain('h-8 w-8');
  });
});
