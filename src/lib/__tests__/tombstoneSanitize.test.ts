import { describe, expect, it } from 'vitest';
import { sanitizeTombstones } from '../sanitize';

/* ============================================================================
   墓碑的 deletedAt 必须**可解析**（v0.29.2）
   ----------------------------------------------------------------------------
   原来只校验"非空字符串"，于是 `deletedAt: "abc"` 能大摇大摆进内存：
   - `toMillis("abc")` = NaN → 排序结果不确定；
   - 回收站显示 `NaN年NaN月NaN日 · NaN 天`，用户无法判断"这条还能留几天"。
   脏数据来源真实存在：旧版本写出来的、手改过的备份、云端某一行。

   口径与 focusSessions 一致：解析不了就当"刚刚删的"（保守，不会让它立刻过期）。
   ========================================================================= */
describe('sanitizeTombstones · deletedAt', () => {
  it('非法时间字符串 → 换成合法时间，不再产出 NaN', () => {
    const [stone] = sanitizeTombstones([{ id: 't1', deletedAt: 'abc', date: '2026-10-31' }]);
    expect(Number.isFinite(Date.parse(stone.deletedAt))).toBe(true);
  });

  it('合法时间原样保留（不能把好的也改掉）', () => {
    const [stone] = sanitizeTombstones([
      { id: 't1', deletedAt: '2026-10-20T10:00:00.000Z', date: '2026-10-31' },
    ]);
    expect(stone.deletedAt).toBe('2026-10-20T10:00:00.000Z');
  });

  it('数字时间戳 / 空串同样按非法处理', () => {
    for (const bad of [12345, '', null, undefined]) {
      const [stone] = sanitizeTombstones([
        { id: 't1', deletedAt: bad as unknown as string, date: '2026-10-31' },
      ]);
      expect(Number.isFinite(Date.parse(stone.deletedAt))).toBe(true);
    }
  });

  /**
   * 非法值按"刚刚删的"算 —— 这是**保守方向**，不是随手选的：
   * 复活判定是 `task.updatedAt > tombstone.deletedAt`，把非法值当"很久以前"
   * 会让任何一条后续更新的任务把已删的东西顶回来（删除失效）；
   * 当"刚刚"则最多是删除时间不准，任务不会复活。
   * 关键是**结果确定**：不能因为 NaN 比较而每次取值不同。
   */
  it('同 id 合并结果确定：非法值按"刚刚删的"处理，稳定胜出', () => {
    const list = sanitizeTombstones([
      { id: 't1', deletedAt: 'abc', date: '2026-10-31' },
      { id: 't1', deletedAt: '2026-10-01T00:00:00.000Z', date: '2026-10-31' },
    ]);
    expect(list).toHaveLength(1);
    expect(Number.isFinite(Date.parse(list[0].deletedAt))).toBe(true);
    // 时间是合法 ISO，且不早于那条真实记录（说明它被当成"现在"）
    expect(list[0].deletedAt >= '2026-10-01T00:00:00.000Z').toBe(true);
  });
});

/* ============================================================================
   超期清理（v0.29.6）
   ----------------------------------------------------------------------------
   回收站的文案一直写着「保留 90 天，超期自动清理」，而代码里**没有清理逻辑**：
   墓碑只增不减，每条都进 payload、进云同步、占配额，回收站每行还永远显示
   "还剩 0 天"。承诺与行为不一致，比一开始就不承诺更糟。
   ========================================================================= */
describe('sanitizeTombstones · 90 天超期清理', () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();

  it('89 天前的墓碑保留（还差一天）', () => {
    const list = sanitizeTombstones([{ id: 'old', deletedAt: daysAgo(89), date: '2026-10-01' }]);
    expect(list.map((s) => s.id)).toEqual(['old']);
  });

  it('91 天前的墓碑被清掉（文案承诺的"超期自动清理"）', () => {
    const list = sanitizeTombstones([{ id: 'ancient', deletedAt: daysAgo(91), date: '2026-10-01' }]);
    expect(list).toEqual([]);
  });

  it('新旧混在一起时只清超期的那些', () => {
    const list = sanitizeTombstones([
      { id: 'keeper', deletedAt: daysAgo(3), date: '2026-10-01' },
      { id: 'ancient', deletedAt: daysAgo(200), date: '2026-10-01' },
    ]);
    expect(list.map((s) => s.id)).toEqual(['keeper']);
  });
});
