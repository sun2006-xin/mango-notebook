import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ============================================================================
   移动端横向溢出的源码级契约（P0）

   用户报的现象：「手机端有些界面会导致界面不固定、超出界限」。
   实测（scripts/audit_mobile_layout.mjs，真实 Chromium 量排版）出来的根因链：
     分段选择器按内容宽度撑到 520px
     → 文档 scrollWidth 520 > 视口 360
     → 移动端浏览器把**布局视口**撑宽
     → 贴着布局视口算的 position:fixed 顶栏与底部 Tab 被一起拉出屏幕
   （底部导航跑到屏幕外面 = 用户说的"界面不固定"）

   这里守两件事：
   ① Segmented 自己收住宽度（真正修复）；
   ② body 有 clip 兜底，且**必须是 clip 不能用 hidden**（hidden 会破坏 sticky）。

   ⚠️ 扫源码前**必须先剥注释**：注释里写同样的词会让断言形同虚设。
   ⚠️ 这类问题 jsdom 测不出来（没有排版引擎，getBoundingClientRect 恒为 0），
      真正的回归闸门是 `node scripts/audit_mobile_layout.mjs`（退出码 1 = 有溢出）。
   ========================================================================= */

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '');
}

function read(rel: string): string {
  return stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'));
}

const SRC_ROOT = fileURLToPath(new URL('../..', import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

describe('Segmented：宽度必须自己收住（P0 溢出的真正根因）', () => {
  const src = read('../common/Segmented.tsx');
  const wrapper = src.slice(src.indexOf('const wrapper'), src.indexOf('return ('));

  it('封顶 max-w-full：块级 / 行内级祖先里不会按内容撑开', () => {
    expect(wrapper).toContain('max-w-full');
  });

  /**
   * 这一条**换过两次方向**，每次都是被真实反馈逼的，别再改回去了：
   *
   * ① 最初 `inline-flex + whitespace-nowrap` 按内容撑开 → 页面横滚、
   *    移动端布局视口被撑宽、底部 Tab 被推出屏幕（"界面不固定"）。
   * ② 改成 `overflow-x-auto` 当滚动容器 → 页面不横滚了，但变成了
   *    **控件内部横滚**：设置页 8 个分段控件每个都要左右拖（"设置那里超长移动"）。
   * ③ 现在：`overflow-hidden` + 选项 `min-w-0 shrink truncate` ——
   *    **永远装得下**，长标签省略，完整文字进 `title`。
   *
   * 所以这里反过来断言：**不许**再出现 `overflow-x-auto`。
   * 它一旦回来，就意味着又要点着拖动才能看全选项。
   */
  it('容器不许再做成滚动容器（overflow-x-auto 会变成"要点着左右拖"）', () => {
    expect(wrapper).not.toContain('overflow-x-auto');
    expect(wrapper).toContain('overflow-hidden');
  });

  it('选项必须可收缩：min-w-0 + shrink（否则 min-width:auto 让它纹丝不动）', () => {
    const button = src.slice(src.indexOf('{options.map'), src.indexOf('</button>'));
    expect(button).toContain('min-w-0');
    expect(button).toContain('shrink');
    // 省略号与完整文本：缩了之后仍看得出这是什么
    expect(button).toContain('truncate');
    expect(button).toContain('title={option.label}');
  });

  it('胶囊底留在容器上，滚的只是里面的按钮', () => {
    expect(wrapper).toContain('bg-surface-sunk');
    expect(wrapper).toContain('p-1');
  });
});

describe('index.css：横向溢出的兜底只准用 clip', () => {
  const css = read('../../index.css');
  const body = css.slice(css.indexOf('  body {'), css.indexOf('  body {') + 700);

  it('body 有 overflow-x: clip（内容越界也不会把布局视口撑宽）', () => {
    expect(body).toContain('overflow-x: clip');
  });

  it('绝不能写成 overflow-x: hidden —— 那会变成滚动容器，破坏子元素的 sticky', () => {
    expect(css).not.toContain('overflow-x: hidden');
    expect(css).not.toContain('overflow: hidden;\n    min-height: 100vh');
  });

  it('.no-scrollbar 有定义（标准属性 + webkit 两条都写）', () => {
    const rule = css.slice(css.indexOf('  .no-scrollbar {'), css.indexOf('  .pb-safe'));
    expect(rule).toContain('scrollbar-width: none');
    expect(rule).toContain('.no-scrollbar::-webkit-scrollbar');
  });
});

describe('全站 whitespace-nowrap 白名单：新增必须先跑布局审计', () => {
  /**
   * `whitespace-nowrap` 是横向溢出的头号嫌疑：它让元素的 min-content
   * 等于整行文字的宽度，flex 收缩对它无效。所以全站只允许出现在
   * **已实测过**的这几处；新增一处就要重新跑 audit 并把它加进白名单。
   */
  const ALLOWED = [
    // ⚠️ Segmented 已从白名单移除：它现在靠 min-w-0 + truncate 收缩，
    //    不再用 whitespace-nowrap（那样 min-content = 整行宽度，收不住）
    'components/task/TaskRow.tsx', // 逾期行的时间文案，父级有 min-w-0
    'views/TodayView.tsx', // 「已完成 8 / 12」，内容长度有界
  ];

  it('没有白名单之外的 whitespace-nowrap', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      const rel = file.slice(SRC_ROOT.length).replace(/\\/g, '/');
      if (ALLOWED.includes(rel)) continue;
      if (stripComments(readFileSync(file, 'utf8')).includes('whitespace-nowrap')) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('白名单里的文件确实还在使用它（防止白名单腐化成死名单）', () => {
    for (const rel of ALLOWED) {
      const src = stripComments(readFileSync(join(SRC_ROOT, rel), 'utf8'));
      expect(src, rel).toContain('whitespace-nowrap');
    }
  });
});
