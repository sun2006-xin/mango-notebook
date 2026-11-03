import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../markdown';
import { compressImage, dataUrlBytes } from '../image';

/* ============================================================================
   F4 错题拍照：图片渲染白名单 + 压缩的降级行为

   安全重点是**白名单**：`data:image/svg+xml` 里可以带脚本，
   `javascript:` 更不用说。只有 png/jpeg/webp 的 base64 与 http(s) 能过。
   ========================================================================= */

const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

describe('Markdown 图片（F4）', () => {
  it('本机压缩出来的 data:image/png;base64 能渲染成 img', () => {
    const html = renderMarkdown(`![错题](${PNG_DATA_URL})`);
    expect(html).toContain('<img class="md-img"');
    expect(html).toContain(PNG_DATA_URL);
    expect(html).toContain('alt="错题"');
  });

  it('http(s) 图片也放行（用户可能从别处粘链接）', () => {
    const html = renderMarkdown('![图](https://example.com/a.png)');
    expect(html).toContain('<img class="md-img"');
  });

  it('javascript: / file: / svg data URL 一律拒绝（原样留在文本里，不生成 img）', () => {
    for (const bad of [
      'javascript:alert(1)',
      'file:///c:/a.png',
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    ]) {
      const html = renderMarkdown(`![x](${bad})`);
      expect(html).not.toContain('<img');
    }
  });

  it('图片语法不会被链接规则抢先拆开（顺序不能反）', () => {
    const html = renderMarkdown(`![错题](${PNG_DATA_URL})`);
    expect(html).not.toContain('<a href');
  });

  it('alt 里的尖括号被转义（不能靠 alt 注入）', () => {
    const html = renderMarkdown(`![<script>](${PNG_DATA_URL})`);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('compressImage：任何失败都只是返回 null', () => {
  it('非图片类型直接拒绝', async () => {
    const file = new Blob(['x'], { type: 'text/plain' });
    expect(await compressImage(file)).toBeNull();
  });

  it('没有 canvas 环境（本测试跑在 node 下）→ null，不抛', async () => {
    const file = new Blob(['x'], { type: 'image/png' });
    await expect(compressImage(file)).resolves.toBeNull();
  });

  it('dataUrlBytes 按 base64 长度估算（4 字符 → 3 字节）', () => {
    expect(dataUrlBytes('data:image/jpeg;base64,AAAA')).toBe(3);
    expect(dataUrlBytes('')).toBe(0);
  });
});

/* ============================================================================
   F13 错题图片遮挡：复习时图片默认糊住，点一张看一张
   ========================================================================= */
describe('renderMarkdown 的 maskImages 选项（F13）', () => {
  it('默认**不**遮挡（记事本 / 日记要看的就是内容本身）', () => {
    const html = renderMarkdown(`![错题](${PNG_DATA_URL})`);
    expect(html).not.toContain('md-img-mask');
    expect(html).toContain('<img class="md-img"');
  });

  it('开启后图片被包进可点击的遮罩，并带提示文案', () => {
    const html = renderMarkdown(`![错题](${PNG_DATA_URL})`, 0, { maskImages: true });
    expect(html).toContain('<button type="button" class="md-img-mask"');
    expect(html).toContain('md-img-mask__hint');
    expect(html).toContain('点击显示图片');
    // img 本身还在（只是被 CSS 糊住），否则点开后没有东西可看
    expect(html).toContain(PNG_DATA_URL);
  });

  it('一张图只包一层（引用块里的图片不会被套两次）', () => {
    const html = renderMarkdown(`> ![错题](${PNG_DATA_URL})`, 0, { maskImages: true });
    const opens = (html.match(/class="md-img-mask"/g) ?? []).length;
    expect(opens).toBe(1);
    expect(html).toContain('<blockquote>');
  });

  it('多张图各自独立遮挡（点开一张不影响另一张）', () => {
    const html = renderMarkdown(`![a](${PNG_DATA_URL})\n\n![b](${PNG_DATA_URL})`, 0, {
      maskImages: true,
    });
    expect((html.match(/class="md-img-mask"/g) ?? []).length).toBe(2);
  });

  it('非白名单 URL 压根不渲染成 img，所以也不会被遮罩（安全面不扩大）', () => {
    const html = renderMarkdown('![x](javascript:alert(1))', 0, { maskImages: true });
    expect(html).not.toContain('md-img-mask');
    expect(html).not.toContain('<img');
  });

  it('没有图片时开启遮罩不改变输出', () => {
    const plain = '只是一段文字\n\n- 列表项';
    expect(renderMarkdown(plain, 0, { maskImages: true })).toBe(renderMarkdown(plain));
  });
});
