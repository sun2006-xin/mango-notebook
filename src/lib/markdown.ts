/* ============================================================================
   极简 Markdown 渲染器

   为什么不引 marked / markdown-it：日记只需要**够用**的那几个语法，
   一个第三方库要为此多背几十 KB 和一条供应链风险。

   最重要的一条纪律：**先转义，再渲染**。
   输出是要交给 dangerouslySetInnerHTML 的，日记内容会经云同步从别的设备过来，
   谁也不能保证里面没有 <script>。所以第一步永远是 escapeHtml()，
   之后所有替换都只可能在安全文本上产生标签。

   支持：标题 / 粗体 / 斜体 / 删除线 / 行内代码 / 代码块 / 引用 / 无序列表 / 有序列表 / 任务清单 / 分割线 / 链接（白名单协议）
   ========================================================================= */

import { TEXT } from '../constants';

/** 行内代码占位符前缀（含罕见字符组合，正常文本里撞不上） */
const TOKEN_PREFIX = '@@MDCODE';
const TOKEN_SUFFIX = '@@';

/** 输出前必须走这里：把五个 HTML 元字符全部实体化 */
function escapeHtml(raw: string): string {
  return String(raw)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 只放行 http / https / mailto。
 * `javascript:` `data:` 之类一律拒绝 —— 这是日记内容唯一能外跳的地方，
 * 一个 `javascript:` 链接就等于把整个应用的数据交给了写这段日记的人。
 */
function safeUrl(raw: string): string | null {
  const url = String(raw).trim();
  if (!/^(https?:\/\/|mailto:)/i.test(url)) return null;
  // 转义已完成，引号都是 &quot;，无法闭合属性；这里只需挡掉换行抹掉的写法
  return /[\n\r]/.test(url) ? null : url;
}

/**
 * 图片 URL 白名单（F4 错题拍照）。
 *
 * 只放行两类：`data:image/...;base64,` （本机压缩后内嵌的照片，不上传）
 * 与 `http(s)://`。**不放行 `javascript:` / `file:` / 其它 data: 类型** ——
 * `data:image/svg+xml` 里可以带脚本，是经典的 XSS 面。
 */
function safeImageUrl(raw: string): string | null {
  const url = String(raw).trim();
  if (/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/i.test(url)) {
    return /[\n\r]/.test(url) ? null : url;
  }
  if (/^https?:\/\//i.test(url)) {
    return /[\n\r"'<>]/.test(url) ? null : url;
  }
  return null;
}

/**
 * 行内语法。入参是**原始文本**，出参可安全交给 innerHTML。
 *
 * ⚠️ 转义必须在这里做，而不是指望调用方先转义。
 * 最初的设计是"入参已转义"，结果段落 / 标题 / 列表三个调用点全都忘了先转义，
 * `<script>alert(1)</script>` 一路直达成品 HTML —— 日记内容来自云同步，
 * 等于任何拿到账号的人都能在别人设备上执行脚本。
 * 现在把转义内置，调用方不可能再漏。
 */
function renderInline(raw: string): string {
  const codes: string[] = [];

  // ⓪ 一切替换都只能在**已转义**的文本上进行
  let out = escapeHtml(raw);

  // ① 行内代码先摘出来，避免 `**a**` 里的星号被当成强调
  out = out.replace(/`([^`]+)`/g, (_match, code: string) => {
    codes.push(String(code));
    return `${TOKEN_PREFIX}${codes.length - 1}${TOKEN_SUFFIX}`;
  });

  /**
   * ② 图片（必须排在链接**之前**：`![a](b)` 里也含一段 `[a](b)`，
   * 先处理链接会把它拆成 `<a>!a</a>`）。
   * URL 走 safeImageUrl 白名单，不合规就原样留着（已转义，安全）。
   */
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (whole, alt, url) => {
    const safe = safeImageUrl(url);
    if (!safe) return whole;
    return `<img class="md-img" src="${safe}" alt="${alt}" loading="lazy" />`;
  });

  // ② 链接（协议白名单；不合规就退化成纯文本标题）
  out = out.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_match, text: string, url: string) => {
    const safe = safeUrl(url);
    if (!safe) return String(text);
    return `<a href="${safe}" target="_blank" rel="noreferrer noopener">${text}</a>`;
  });

  // ③ 强调：先粗后斜，避免 **bold** 被当成两层斜体
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  // ④ 把行内代码放回去
  out = out.replace(
    new RegExp(`${TOKEN_PREFIX}(\\d+)${TOKEN_SUFFIX}`, 'g'),
    (_match, index: string) => `<code>${codes[Number(index)] ?? ''}</code>`,
  );

  return out;
}

const RE_FENCE = /^\s{0,3}```/;
const RE_HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const RE_HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const RE_QUOTE = /^\s{0,3}>\s?/;
const RE_UL = /^\s*[-*+]\s+(.*)$/;
const RE_OL = /^\s*\d+[.)]\s+(.*)$/;
const RE_TASK = /^\[([ xX])\]\s+(.*)$/;

/** 这一行是否会**开启一个新块**（用于判断段落该在哪里收尾） */
function isBlockStart(line: string): boolean {
  return (
    RE_FENCE.test(line) ||
    RE_HEADING.test(line) ||
    RE_HR.test(line) ||
    RE_QUOTE.test(line) ||
    RE_UL.test(line) ||
    RE_OL.test(line)
  );
}

interface ListBlock {
  items: string[];
  next: number;
}

/** 收集连续的同类型列表项；缩进续行并入上一项 */
function collectList(lines: string[], start: number, ordered: boolean): ListBlock {
  const re = ordered ? RE_OL : RE_UL;
  const items: string[] = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i] ?? '';
    const matched = re.exec(line);

    if (matched) {
      const text = String(matched[1] ?? '');
      const task = RE_TASK.exec(text);
      if (task) {
        const checked = String(task[1] ?? '').toLowerCase() === 'x';
        items.push(
          `<span class="md-check${checked ? ' md-check-done' : ''}">${
            checked ? '\u2611' : '\u2610'
          }</span> ${renderInline(String(task[2] ?? ''))}`,
        );
      } else {
        items.push(renderInline(text));
      }
      i += 1;
      continue;
    }

    // 缩进两格以上且已有上一项 → 视为续行
    if (items.length > 0 && /^\s{2,}\S/.test(line)) {
      const last = items.pop() as string;
      items.push(`${last}<br />${renderInline(line.trim())}`);
      i += 1;
      continue;
    }

    break;
  }

  return { items, next: i };
}

/**
 * 引用块的递归深度上限。
 *
 * 引用块是**递归**渲染的（每层剥一个前导 `>`），于是一段 `n` 个 `>` 的文本
 * 会递归 `n` 层 —— 日记上限 5000、笔记上限 20000，一篇全由 `>` 组成的正文
 * 就能打爆调用栈（RangeError）。而 `renderMarkdown` 是在**渲染期**同步求值的
 * （`dangerouslySetInnerHTML`），一次抛异常若没人兜住就是整棵树卸载＝白屏。
 *
 * 所以这里限深：超过阈值后剩下的 `>` **不再剥、当普通文本**（转义后）渲染。
 * 视觉上引用效果变朴素，但内容一个字不丢、也绝不会炸。
 * 10 层足够覆盖真实书写深度（真 Markdown 嵌套引用很少超过 3 层）。
 */
const MAX_QUOTE_DEPTH = 10;

export interface RenderMarkdownOptions {
  /**
   * 把图片包进「点击显示」的遮罩里（F13 错题遮挡自测）。
   *
   * 只给复习视图用：那里"答案"是一整块，而错题照片往往就是解法本身 ——
   * 先盖住、自己默一遍、再一张张点开，比一口气把答案摊开有用得多。
   * 记事本 / 日记**绝不开**：那里要看的就是内容本身。
   */
  maskImages?: boolean;
}

/**
 * 给已经渲染好的 HTML 里的图片套上遮罩。
 *
 * 为什么用后处理而不是把开关一路穿进 `renderInline`：
 * 生成 img 的地方只有 `renderInline` 一处，但它的调用点有段落 / 标题 / 列表 /
 * 表格四个，一路穿参数要改五六个签名。而这里的安全性是有保证的 ——
 * `md-img` 这个 class 只可能由我们自己拼出来（用户文本在这一步之前已经全部转义，
 * 注入不出 `<img class="md-img">`），所以按它做替换不会被用户内容骗到。
 */
function maskRenderedImages(html: string): string {
  return html.replace(
    /<img class="md-img" ([^>]*?)\/>/g,
    '<button type="button" class="md-img-mask" aria-label="图片已遮挡，点击显示">'
      + '<img class="md-img" $1/>'
      + `<span class="md-img-mask__hint">${TEXT.imageCoverHint}</span>`
      + '</button>',
  );
}

/**
 * Markdown → HTML 字符串。
 * 入参非字符串 / 空串 → 返回空串（绝不抛异常）。
 *
 * @param source 原始 Markdown 文本
 * @param depth  当前递归深度（外部调用不要传，内部处理嵌套引用时自增）
 * @param options 渲染选项；遮罩只在最外层套一次（递归层已经包含在结果里）
 */
export function renderMarkdown(
  source: string,
  depth = 0,
  options: RenderMarkdownOptions = {},
): string {
  const html = renderBlocks(source, depth, options);
  /**
   * 遮罩只在 depth 0 套：递归（引用块）返回的片段会拼进外层结果，
   * 每层都套的话同一张图会被包两层 `<button>`。
   */
  return depth === 0 && options.maskImages ? maskRenderedImages(html) : html;
}

/** 真正的渲染主体（不含遮罩后处理） */
function renderBlocks(source: string, depth: number, options: RenderMarkdownOptions): string {
  if (typeof source !== 'string' || source.length === 0) return '';

  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    if (/^\s*$/.test(line)) {
      i += 1;
      continue;
    }

    // 代码块（围栏）：整段原样保留
    if (RE_FENCE.test(line)) {
      /**
       * 围栏后面那截是**语言标签**（```js / ```python）。
       * 只留安全字符、最长 12 —— 它会被写进 HTML，不做限制就是一个注入口。
       */
      const lang = line
        .trim()
        .slice(3)
        .trim()
        .replace(/[^A-Za-z0-9+#._-]/g, '')
        .slice(0, 12);
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !RE_FENCE.test(lines[i] ?? '')) {
        body.push(lines[i] ?? '');
        i += 1;
      }
      i += 1; // 吃掉收尾围栏
      /**
       * 头部的「语言标签 + 复制」是给记代码片段的人用的：
       * 记 STM32 报错、YOLOv5 配置，抄的时候不想用鼠标拖选。
       * 复制走**事件委托**（App 里监听 document），所以这里只放一个标记属性，
       * 不写内联 onclick —— 内联事件会让 Markdown 渲染器背上一份脚本。
       */
      const head = `<div class="md-code-head">${
        lang ? `<span class="md-code-lang">${escapeHtml(lang)}</span>` : '<span></span>'
      }<button type="button" class="md-code-copy" data-md-copy>复制</button></div>`;
      blocks.push(
        `<div class="md-code">${head}<pre><code>${escapeHtml(body.join('\n'))}</code></pre></div>`,
      );
      continue;
    }

    if (RE_HR.test(line)) {
      blocks.push('<hr />');
      i += 1;
      continue;
    }

    const heading = RE_HEADING.exec(line);
    if (heading) {
      const level = String(heading[1] ?? '#').length;
      blocks.push(`<h${level}>${renderInline(String(heading[2] ?? '').trim())}</h${level}>`);
      i += 1;
      continue;
    }

    if (RE_QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && RE_QUOTE.test(lines[i] ?? '')) {
        body.push(String(lines[i] ?? '').replace(RE_QUOTE, ''));
        i += 1;
      }
      // 到深度上限后停止递归，剩下的 `>` 留在正文里当普通文字
      // （renderInline 内部已转义 → `&gt;`，不会变成标签，也不会继续下钻）
      if (depth >= MAX_QUOTE_DEPTH) {
        blocks.push(
          `<blockquote><p>${body.map((row) => renderInline(row)).join('<br />')}</p></blockquote>`,
        );
        continue;
      }
      blocks.push(`<blockquote>${renderBlocks(body.join('\n'), depth + 1, options)}</blockquote>`);
      continue;
    }

    const isOrdered = RE_OL.test(line);
    if (isOrdered || RE_UL.test(line)) {
      const { items, next } = collectList(lines, i, isOrdered);
      const tag = isOrdered ? 'ol' : 'ul';
      blocks.push(`<${tag}>${items.map((item) => `<li>${item}</li>`).join('')}</${tag}>`);
      i = next;
      continue;
    }

    // 普通段落：吃到空行或下一个块开头；段内换行用 <br />
    const buf: string[] = [];
    while (i < lines.length && !/^\s*$/.test(lines[i] ?? '') && !isBlockStart(lines[i] ?? '')) {
      buf.push(lines[i] ?? '');
      i += 1;
    }
    if (buf.length > 0) {
      blocks.push(`<p>${buf.map((row) => renderInline(row)).join('<br />')}</p>`);
    }
  }

  return blocks.join('\n');
}

/**
 * 去掉标记只留纯文本 —— 日记列表摘要、搜索命中预览用。
 * 不是 renderMarkdown 的逆运算，只做粗去噪：摘要里出现 `**` 会很难看。
 */
export function stripMarkdown(source: string): string {
  if (typeof source !== 'string') return '';
  return source
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/gm, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/\n{2,}/g, '\n')
    .trim();
}
