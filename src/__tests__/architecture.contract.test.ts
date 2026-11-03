import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ============================================================================
   架构闸门（v0.29.6）
   ----------------------------------------------------------------------------
   这个项目一直没有 linter，也没有任何"谁可以 import 谁"的约束 —— 全靠人记。
   结果就是：加一个新功能时，最容易的不是写业务，而是**在错误的层里写** ——
   视图里直接读 localStorage、lib 里 import 一个 React 组件、
   两个视图互相 import 一个工具函数…… 这些都能编译通过、测试全绿，
   然后在某个平台（安卓 / 桌面）上 quietly 崩掉。

   这里把 `scripts/audit_architecture.mjs` 当成闸门跑一遍，断言：
   ① 没有**层序反转**（下层 import 上层）；
   ② 没有**循环依赖**；
   ③ 没有**视图互相 import**（跨视图复用必须下沉）；
   ④ lib 里碰浏览器 API 的文件**都已登记理由**（不是禁止，是要求登记）。

   为什么用 spawn 而不是在测试里重写一遍分析逻辑：规则只能有一份。
   两份实现迟早走岔，而"闸门和报告说的不是一回事"比没有闸门更糟。
   ========================================================================= */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

function runAudit(): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, ['scripts/audit_architecture.mjs', '--strict'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const report = runAudit();

describe('架构闸门', () => {
  it('没有分层违规 / 循环依赖 / 视图互相 import（退出码 0）', () => {
    // 失败时把报告原文带出来，而不是只报一句"退出码 1"
    expect(report.code, report.out).toBe(0);
  });

  it('报告里确实声明了三类检查都通过（防止脚本被改成"永远绿"）', () => {
    expect(report.out).toContain('分层 / 纯逻辑 / 视图隔离 全部通过');
  });

  it('结论行是"干净"', () => {
    expect(report.out).toContain('结论：干净');
  });
});

describe('体量红线（只提示，不拦截）', () => {
  /**
   * 单个文件超过 700 行（**不计注释**）就该考虑拆了 —— 但它不是硬失败：
   * 有些文件（cloudSync）拆分成本高于收益。所以这里只把现状钉住，
   * 一旦新增一个超大文件就会红，逼人当场决定"拆还是留下理由"。
   */
  const BIG_ALLOWED = new Set(['lib/cloudSync.ts', 'lib/storage.ts', 'views/FocusView.tsx']);

  it('没有新增的超大文件', () => {
    const lines = report.out.split('\n');
    const at = lines.findIndex((l) => l.includes('文件体量 ≥'));
    expect(at, '报告里没有体量段').toBeGreaterThan(-1);
    const big = new Set<string>();
    for (const line of lines.slice(at + 1)) {
      const m = /^\s+\d+\s+(\S+)$/.exec(line);
      if (!m) break;
      big.add(m[1]);
    }
    const unexpected = [...big].filter((f) => !BIG_ALLOWED.has(f));
    expect(unexpected, `新增了超大文件：${unexpected.join(', ')} —— 拆掉，或加进这个白名单并写明理由`).toEqual([]);
  });
});
