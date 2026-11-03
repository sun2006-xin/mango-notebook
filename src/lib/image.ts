/* ============================================================================
   图片压缩（F4 错题拍照）

   需求场景：拍纸质错题本 → 存进记事本 → 进复习队列。
   约束是**载荷**：所有笔记都塞在 localStorage 的一个 key 里（约 5 MB 总量），
   原图一张 3 MB 直接就能把存储撑爆。所以必须在**写入前**把图压到几十 KB。

   为什么用 canvas 而不是引库：压缩只做两件事（缩放到长边上限、转 JPEG），
   canvas 原生就能干，引一个图片处理库等于为 30 行代码换 100 KB 体积。
   ========================================================================= */

export interface CompressedImage {
  /** `data:image/jpeg;base64,...` */
  dataUrl: string;
  /** 近似字节数（base64 长度 × 0.75） */
  bytes: number;
  width: number;
  height: number;
}

export interface CompressOptions {
  /** 长边上限（像素）。1024 够看清错题的手写批注 */
  maxEdge?: number;
  /** JPEG 质量 0–1。0.72 是"看得清又不糊"的常用值 */
  quality?: number;
}

/** base64 data URL 的近似字节数 */
export function dataUrlBytes(dataUrl: string): number {
  const index = dataUrl.indexOf(',');
  const base64 = index >= 0 ? dataUrl.slice(index + 1) : '';
  return Math.round((base64.length * 3) / 4);
}

/**
 * 把用户选的文件压成一段 data URL。
 *
 * 任何一步失败都返回 null（选到非图片、没有 canvas 环境、解码失败……），
 * 调用方给一句人话提示即可 —— **绝不能因为插图失败而影响记笔记本身**。
 */
export async function compressImage(
  file: Blob,
  options: CompressOptions = {},
): Promise<CompressedImage | null> {
  const { maxEdge = 1024, quality = 0.72 } = options;
  if (typeof document === 'undefined') return null;
  if (!file || typeof file.arrayBuffer !== 'function') return null;
  if (file.type && !file.type.startsWith('image/')) return null;

  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    // JPEG 不支持透明：先铺白底，否则拍 PNG 截图会出现黑块
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();

    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    if (!dataUrl.startsWith('data:image/jpeg')) return null;
    return { dataUrl, bytes: dataUrlBytes(dataUrl), width, height };
  } catch {
    return null;
  }
}
