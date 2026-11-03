import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { focusEndAt, sessionMs } from '../../lib/focus';
import type { FocusSession } from '../../types';

/* ============================================================================
   专注记录的**写入口径**契约（审查发现的 P1）

   一条纪律，两处曾经踩坑：
     `sessionMs()` 只认 `endedAt - startedAt`，明写"不信 durationMs"。
     所以任何写入点都不能把 `endedAt` 写成 `new Date()` —— 一旦这么写，
     「暂停几小时再继续」的秒表会被算成几小时的专注，
     今日 / 本周 / 热力图 / 连续打卡全部虚增。

   番茄钟那侧早修过（`useFocusTimer` 用 `focusEndAt`），秒表是漏掉的最后一个。
   这里用两条不同的闸把这条口径钉死：
   ① 纯函数层：`sessionMs` + `focusEndAt` 的自洽（真实数值）；
   ② 源码层：全站**每一个** `endedAt:` 写入点都必须是 `focusEndAt(...)`。

   只靠②不够（会漏掉"新增第三个计时器"），只靠①也不够（约束不到未来的写入点）。
   ========================================================================= */

const SRC_ROOT = fileURLToPath(new URL('../..', import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

describe('纯函数：endedAt 必须是 startedAt + elapsed', () => {
  it('focusEndAt 算出来的区间，sessionMs 认它等于 elapsed', () => {
    const startedAt = '2026-10-28T02:00:00.000Z';
    const session: FocusSession = {
      id: 's1',
      taskId: null,
      date: '2026-10-28',
      startedAt,
      endedAt: focusEndAt(startedAt, 15 * 60_000),
      durationMs: 15 * 60_000,
    };
    expect(sessionMs(session)).toBe(15 * 60_000);
  });

  it('反例：endedAt 写成"现在"→ 暂停 3 小时的秒表被算成 3 小时（本修复要消灭的现象）', () => {
    // 10:00 开始跑 10 分钟 → 暂停 → 13:00 继续 → 13:05 记录
    const startedAt = '2026-10-28T05:00:00.000Z'; // 本地 13:00
    const buggy: FocusSession = {
      id: 's2',
      taskId: null,
      date: '2026-10-28',
      startedAt,
      endedAt: '2026-10-28T05:05:00.000Z', // 只差 5 分钟，那是"现在"
      durationMs: 15 * 60_000, // 真实累计 15 分钟
    };
    // 旧写法（endedAt = 现在）统计出来只有 5 分钟；写反了同样虚增
    expect(sessionMs(buggy)).toBe(5 * 60_000);
    expect(sessionMs(buggy)).not.toBe(15 * 60_000);
  });

  it('非法 startedAt 不会让 focusEndAt 抛（云同步的脏数据）', () => {
    expect(() => focusEndAt('not-a-date', 60_000)).not.toThrow();
    expect(() => focusEndAt('', 60_000)).not.toThrow();
  });
});

describe('源码层：全站 endedAt 写入点只准用 focusEndAt', () => {
  it('没有 `endedAt: new Date()` 这类"取现在"的写法', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      const rel = file.slice(SRC_ROOT.length).replace(/\\/g, '/');
      if (rel.includes('__tests__')) continue;
      const src = readFileSync(file, 'utf8');
      for (const line of src.split('\n')) {
        if (!/endedAt:/.test(line)) continue;
        // types.ts 是「类型声明」，不是写入点
        if (rel === 'types.ts') continue;
        if (!line.includes('focusEndAt(')) offenders.push(`${rel}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('两个已知写入点都还在（防止白名单式的断言腐化）', () => {
    for (const rel of ['hooks/useFocusTimer.ts', 'hooks/useStopwatch.ts']) {
      const src = readFileSync(join(SRC_ROOT, rel), 'utf8');
      expect(src, rel).toContain('endedAt: focusEndAt(');
    }
  });
});

describe('番茄钟：放弃了就不该再进休息', () => {
  /**
   * 曾经：休息分支只判 `phase === 'focus' && breakMs > 0`，没判 `record`。
   * 于是点「放弃」（= finish(false, false)）照样开一段休息，
   * 而休息是 tick 自然结束的（auto=true）→ 自动续接开关一开，
   * 放弃之后会自己再开一段专注，和"点放弃就是要停"完全相反。
   * 严格模式中断走的也是 cancel()，同一条路径。
   */
  it('进休息的判定里带 record', () => {
    const src = readFileSync(join(SRC_ROOT, 'hooks/useFocusTimer.ts'), 'utf8');
    const idx = src.indexOf("run?.phase === 'focus' && record && breakMs > 0");
    expect(idx).toBeGreaterThan(-1);
  });

  it('cancel 仍然是不记录 + 不自动续接（finish(false, false)）', () => {
    const src = readFileSync(join(SRC_ROOT, 'hooks/useFocusTimer.ts'), 'utf8');
    const cancelIdx = src.indexOf('const cancel = useCallback(');
    const block = src.slice(cancelIdx, cancelIdx + 200);
    expect(block).toContain('finish(false, false)');
  });
});
