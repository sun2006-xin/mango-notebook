import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/* ============================================================================
   构建模式的**产品口径**（v0.31.0）
   ----------------------------------------------------------------------------
   产品定位：官方部署的登录只属于网页版；默认桌面与安卓构建为纯本地应用，
   同时保留使用者显式配置自有云的构建命令。

   这不是文档里的一句话，而是三个命令的约定：
     · `desktop:build`     → `--mode client`（整块清空云配置）
     · `web:build`         → `--mode singlefile`（带云配置，供发布）
     · `inline_icons.py`   → 优先读 `dist-web`（绝不能从客户端的 dist-single 抄）

   为什么要用测试盯住命令：这三条任何一条被"顺手改回统一构建"，
   结果都是**把云凭据打进 APK/桌面包**，而代码、类型、其他测试全都不会报错。
   ========================================================================= */

const pkg = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
) as { scripts: Record<string, string> };

describe('构建模式', () => {
  it('客户端构建用 --mode client（无云）', () => {
    expect(pkg.scripts['desktop:build']).toContain('--mode client');
  });

  it('客户端构建仍然是**单文件**（否则 APK 在 file:// 下白屏）', () => {
    const vite = readFileSync(new URL('../../../vite.config.ts', import.meta.url), 'utf8');
    expect(vite).toMatch(/mode === 'client'/);
    // 单文件插件的开关必须把 client 也算进去
    expect(vite).toMatch(/singlefile = mode === 'singlefile' \|\| mode === 'client'/);
  });

  it('网页构建用 --mode singlefile 且输出到独立目录', () => {
    expect(pkg.scripts['web:build']).toContain('--mode singlefile');
    expect(pkg.scripts['web:build']).toContain('dist-web');
  });

  it('网页发布优先取 dist-web（不从客户端产物抄）', () => {
    const src = readFileSync(new URL('../../../scripts/inline_icons.py', import.meta.url), 'utf8');
    expect(src).toContain("dist-web");
    expect(src).toMatch(/_pick_src/);
  });

  it('想给客户端也开云时，有一条显式命令（而不是改回去）', () => {
    expect(pkg.scripts['desktop:build:cloud']).toContain('--mode singlefile');
  });

  /* v0.31.2：把「先 cloud build、再打包」固化成有名字的命令。
     踩过的坑：文档里写组合命令，用户顺手敲 `npm run desktop:exe`，
     它第一步会重跑 `--mode client` 把刚生成的云产物整块覆盖掉，
     而且不报任何错 —— 装出来的包静默变回纯本地。 */
  it('自建云桌面打包命令不能调用会重建默认客户端的 desktop:exe', () => {
    const cmd = pkg.scripts['desktop:exe:cloud'];
    expect(cmd).toBeDefined();
    expect(cmd).toContain('desktop:build:cloud');
    expect(cmd).toContain('electron-builder');
    expect(cmd).not.toContain('desktop:exe');
  });

  it('自建云 Android 同步命令先出云产物再 cap sync', () => {
    const cmd = pkg.scripts['android:sync:cloud'];
    expect(cmd).toBeDefined();
    expect(cmd).toContain('desktop:build:cloud');
    expect(cmd).toContain('cap sync android');
    expect(cmd.indexOf('desktop:build:cloud')).toBeLessThan(cmd.indexOf('cap sync android'));
  });
});
