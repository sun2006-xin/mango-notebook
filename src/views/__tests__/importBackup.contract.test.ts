import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/* ============================================================================
   P0 回归：导入备份不能"选什么文件都照单全收"

   曾经设置页的「导入备份」是 `JSON.parse(text)` → `migrate(parsed)`：
   `migrate({})` 会补出一份"合法但全空"的载荷，于是随手选一个 package.json
   就能把任务 / 日记 / 记事 / 专注 / 墓碑全部清空，而且**没有二次确认**。

   这里守三件事（本环境不渲染 DOM，走源码级契约）：
   ① 导入必须先过 parseBackupJson 的形状校验；
   ② 导入是两段式（选文件 → 再点一次才覆盖），与「清空数据」同级；
   ③ 有取消按钮，读错文件能退出来重选。
   ========================================================================= */

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '');
}

/**
 * 2026-10-31：整块「数据备份」从 `views/SettingsView.tsx` 搬到了
 * `components/settings/DataSection.tsx`（六个不可逆操作挤在一起，得单独成文件）。
 * 断言内容一字未改，只是换了扫描目标 —— 搬家最容易丢的就是这类契约。
 */
const src = stripComments(
  readFileSync(new URL('../../components/settings/DataSection.tsx', import.meta.url), 'utf8'),
);

describe('导入备份：形状校验（P0）', () => {
  it('onFilePicked 走 parseBackupJson，不再自己 JSON.parse + migrate', () => {
    const start = src.indexOf('const onFilePicked = useCallback(');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, start + 1400);
    expect(block).toContain('parseBackupJson(text)');
    expect(block).not.toContain('JSON.parse(text)');
    // 也不该把未校验的结果直接塞给 migrate
    expect(block).not.toContain('migrate(parsed)');
  });

  it('形状不通过时提示"不是有效的备份"，且不 hydrate', () => {
    const start = src.indexOf('const onFilePicked = useCallback(');
    const block = src.slice(start, start + 1400);
    expect(block).toContain('这个文件不是有效的备份');
    expect(block).not.toContain('hydrateFrom(');
  });
});

describe('导入备份：两段式确认（不可逆操作）', () => {
  it('选文件只写入 pendingImport，不直接覆盖本机', () => {
    expect(src).toContain('setPendingImport({ name: file.name, payload })');
  });

  it('第二段才真的覆盖：按钮在 pendingImport 存在时变成「确认导入」', () => {
    const start = src.indexOf('const onImportClick = useCallback(');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, start + 600);
    expect(block).toContain('hydrateFrom(pendingImport.payload)');
    expect(src).toContain("data-testid=\"data-import\"");
    expect(src).toContain('确认导入（再点一次）');
  });

  it('有取消入口：读错文件可以退出来重选', () => {
    expect(src).toContain('data-testid="data-import-cancel"');
    expect(src).toContain('onClick={() => setPendingImport(null)}');
  });

  it('确认前把"会覆盖多少东西"说清楚', () => {
    expect(src).toContain('将覆盖本机全部数据');
  });
});
