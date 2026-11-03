import { describe, expect, it } from 'vitest';
import { renderMarkdown, stripMarkdown } from '../markdown';

/* ============================================================================
   Markdown 渲染的第一职责不是排版，是**不把用户输入当代码执行**。

   输出会交给 dangerouslySetInnerHTML，而日记内容会经云同步从别的设备过来。
   所以这里把"注入"当成主用例写，排版只是附带确认。
   ========================================================================= */

describe('安全：先转义再渲染', () => {
  it('<script> 被实体化，不可能形成标签', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;');
  });

  it('<img onerror> 同样被吃掉', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('javascript: 链接退化成纯文本，不产生 <a>', () => {
    const html = renderMarkdown('[点我](javascript:alert(1))');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('点我');
  });

  it('data: 链接同样被拒', () => {
    expect(renderMarkdown('[x](data:text/html,<script>1</script>)')).not.toContain('<a ');
  });

  it('http / https / mailto 放行，且带 noopener', () => {
    const html = renderMarkdown('[官方](https://example.test)');
    expect(html).toContain('href="https://example.test"');
    expect(html).toContain('rel="noreferrer noopener"');
    expect(renderMarkdown('[信](mailto:a@b.c)')).toContain('href="mailto:a@b.c"');
  });

  it('代码块内容也转义（不能靠"反正是代码"逃过）', () => {
    const html = renderMarkdown('```\n<script>alert(1)</script>\n```');
    expect(html).toContain('<pre><code>');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('块级语法', () => {
  it('标题 1–3 级', () => {
    expect(renderMarkdown('# 一级')).toContain('<h1>一级</h1>');
    expect(renderMarkdown('## 二级')).toContain('<h2>二级</h2>');
    expect(renderMarkdown('### 三级')).toContain('<h3>三级</h3>');
  });

  it('无序 / 有序列表', () => {
    expect(renderMarkdown('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(renderMarkdown('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>');
  });

  it('任务清单渲染成勾选框字符', () => {
    const html = renderMarkdown('- [x] 做完\n- [ ] 没做');
    expect(html).toContain('md-check-done');
    expect(html).toContain('☑');
    expect(html).toContain('☐');
  });

  it('引用块内部还能再解析', () => {
    const html = renderMarkdown('> **重点**');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<strong>重点</strong>');
  });

  it('分割线', () => {
    expect(renderMarkdown('---')).toBe('<hr />');
  });

  it('段内单个换行用 <br />，空行分段', () => {
    expect(renderMarkdown('第一行\n第二行')).toBe('<p>第一行<br />第二行</p>');
    expect(renderMarkdown('段一\n\n段二')).toBe('<p>段一</p>\n<p>段二</p>');
  });
});

describe('行内语法', () => {
  it('粗体 / 删除线', () => {
    expect(renderMarkdown('**粗**')).toBe('<p><strong>粗</strong></p>');
    expect(renderMarkdown('~~删~~')).toBe('<p><del>删</del></p>');
  });

  it('行内代码里的星号不当强调处理', () => {
    const html = renderMarkdown('`a**b**c`');
    expect(html).toContain('<code>a**b**c</code>');
    expect(html).not.toContain('<strong>');
  });

  it('行内代码里的 HTML 同样被转义', () => {
    expect(renderMarkdown('`<b>`')).toContain('<code>&lt;b&gt;</code>');
  });
});

describe('边界', () => {
  it('空串 / 非字符串 → 空串，不抛', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown(undefined as unknown as string)).toBe('');
    expect(renderMarkdown(null as unknown as string)).toBe('');
  });

  it('只有空白 → 空串', () => {
    expect(renderMarkdown('   \n\n  ')).toBe('');
  });

  it('未闭合的代码围栏不会吞掉后面所有内容后再出错', () => {
    expect(() => renderMarkdown('```\nunclosed')).not.toThrow();
  });
});

describe('stripMarkdown：列表摘要去噪', () => {
  it('去掉标题 / 列表 / 强调 / 链接标记', () => {
    const text = stripMarkdown('# 标题\n\n- **粗**项\n- [x] 待办\n\n[链接](https://example.test) `code`');
    expect(text).not.toContain('#');
    expect(text).not.toContain('**');
    expect(text).not.toContain('[x]');
    expect(text).not.toContain('https://example.test');
    expect(text).toContain('标题');
    expect(text).toContain('待办');
    expect(text).toContain('code');
  });

  it('非字符串 → 空串', () => {
    expect(stripMarkdown(undefined as unknown as string)).toBe('');
  });
});

/* ============================================================================
   F11：代码块的语言标签 + 复制
   ========================================================================= */
describe('代码块（语言标签 / 复制 / 注入防护）', () => {
  it('围栏后的语言名会渲染成标签，并带一个复制钩子', () => {
    const html = renderMarkdown('```js\nconst a = 1;\n```');
    expect(html).toContain('md-code-lang');
    expect(html).toContain('>js<');
    expect(html).toContain('data-md-copy');
    expect(html).toContain('const a = 1;');
  });

  it('没写语言时不渲染空标签，但复制按钮仍在', () => {
    const html = renderMarkdown('```\nplain\n```');
    expect(html).not.toContain('md-code-lang');
    expect(html).toContain('data-md-copy');
  });

  it('语言名里的 HTML / 引号被清掉（它会被写进属性与文本）', () => {
    const html = renderMarkdown('```js"><script>alert(1)</script>\nx\n```');
    expect(html).not.toContain('<script>');
    // 只留安全字符（字母数字与 +#._-），长度截到 12：
    // 'js"><script>alert(1)</script>' → 'jsscriptalert1script' → 'jsscriptaler'
    expect(html).toContain('>jsscriptaler<');
    expect(html).not.toContain('"><script');
  });

  it('代码正文仍然被转义（不能因为加了头部就漏掉 escapeHtml）', () => {
    const html = renderMarkdown('```js\nif (a < b && c > d) {}\n```');
    expect(html).toContain('&lt;');
    expect(html).not.toContain('a < b');
  });
});
