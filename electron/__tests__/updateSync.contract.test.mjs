import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/* ============================================================================
   "桌面端每次都要更新" 的回归守卫

   历史故障（v0.22 用户报告"你不是直接更新桌面端吗，怎么每次还要更新"）：
   - `electron/main.cjs` 加载前端时，**热更新目录优先于出厂包**：
       userData/web  >  resources/web
   - 而 `scripts/release_desktop.py` 当时只铺 `resources/web`。
   - 于是只要机器上曾经自动更新过一次，出厂包就再也不会被读到 ——
     我铺的新版等于白铺，桌面端跑的还是旧包，每次启动都判定"线上比我新"。

   修复的关键不是改加载优先级（那会破坏在线热更新的意义），而是让
   **发布脚本把两份都写掉**。这组用例就是钉住这一点：
   谁把这步"顺手清理"掉，这里立刻红。
   ========================================================================= */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

const script = fs.readFileSync(path.join(ROOT, 'scripts/release_desktop.py'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'electron/main.cjs'), 'utf8');
const updaterSrc = fs.readFileSync(path.join(ROOT, 'electron/updater.cjs'), 'utf8');

describe('加载优先级（这是前提，不是可选项）', () => {
  it('main.cjs 里热更新目录排在出厂包前面', () => {
    // resolveWebDir 的 candidates 顺序即优先级
    const block = mainSrc.slice(mainSrc.indexOf('function resolveWebDir'));
    const hot = block.indexOf('hot,');
    const factory = block.indexOf("path.join(process.resourcesPath || '', 'web')");
    expect(hot).toBeGreaterThan(-1);
    expect(factory).toBeGreaterThan(-1);
    expect(hot).toBeLessThan(factory);
  });

  it('localBuildId 读的是"当前生效包"的身份证，不是 asar', () => {
    expect(updaterSrc).toContain('const info = readJson(paths().activeMark);');
  });
});

describe('发布脚本必须把两份都写掉', () => {
  it('有同步热更新目录这一步，并且在 main 里真的被调用', () => {
    expect(script).toContain('def sync_hot_update_dir(');
    expect(script).toMatch(/sync_hot_update_dir\(str\(info\.get\('version'/);
  });

  it('同步时更新身份证（否则 localBuildId 一直报旧版）', () => {
    expect(script).toContain("(base / 'web.active.json').write_text(");
    expect(script).toContain("'buildId': build_id");
  });

  it('同步时补上通行证（缺了会被判成"换入后没渲染成功" → 回滚 + 拉黑）', () => {
    expect(script).toContain("(base / 'web.ok').write_text(");
  });

  it('清掉旧的待换入 / 可回滚包（防止回滚到更旧的版本）', () => {
    expect(script).toContain("for stale in ('web.prev', 'web.staging')");
  });

  it('文档不再宣称"不动 %APPDATA%"（这句话曾经就是这个 bug 的思想来源）', () => {
    expect(script).not.toContain('不动 %APPDATA% 用户数据');
    expect(script).toContain('热更新换入的那套');
  });

  it('结尾做三处字节校验，不一致就非零退出', () => {
    expect(script).toContain('def verify()');
    expect(script).toContain('sys.exit(1)');
  });
});
