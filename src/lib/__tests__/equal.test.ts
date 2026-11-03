import { describe, expect, it } from 'vitest';
import { sameByIdentity, sameFields, sameRows, sameValue } from '../equal';

/* ============================================================================
   结构化比较的单元测试

   重点不在"相等时返回 true"（这种谁都会写对），而在**不等时能不能发现**。
   历史上两次事故都出在"该发现却没发现"这一侧：

   - `sameHabits` 漏了 `autoTask` 字段 → 开关点了没反应；
   - `sameNoteSet` 漏了 `updatedAt` → 记事的任何改动都判成"没变"，永远同步不了。

   所以下面专门用「改动一个字段」和「多出一个未知字段」两种手法去戳它。
   ========================================================================= */

describe('sameValue：null 与 undefined 视为同一态', () => {
  it('undefined 与 null 相等', () => {
    expect(sameValue(undefined, null)).toBe(true);
    expect(sameValue(null, undefined)).toBe(true);
  });

  it('空串 / 0 / false 与 null 不等（不能被 ?? 吞掉）', () => {
    expect(sameValue('', null)).toBe(false);
    expect(sameValue(0, null)).toBe(false);
    expect(sameValue(false, null)).toBe(false);
  });

  it('标量按值比', () => {
    expect(sameValue('a', 'a')).toBe(true);
    expect(sameValue('a', 'b')).toBe(false);
    expect(sameValue(1, 1)).toBe(true);
  });
});

describe('sameFields：键取并集，不手抄字段清单', () => {
  it('同一对象 / 同内容 → 相等', () => {
    const a = { id: 'h1', name: '背单词', autoTask: true };
    expect(sameFields(a, a)).toBe(true);
    expect(sameFields(a, { ...a })).toBe(true);
  });

  it('**任一字段**变化都能发现（逐字段扫一遍）', () => {
    const base = { id: 'h1', name: '背单词', archivedAt: null, autoTask: true, createdAt: 'T0' };
    for (const key of Object.keys(base) as (keyof typeof base)[]) {
      const changed = { ...base, [key]: base[key] === true ? false : '__changed__' };
      expect(sameFields(base, changed), `字段 ${key} 变化没被发现`).toBe(false);
    }
  });

  it('显式把 autoTask 从 true 改成 undefined → 必须判为不同（真实事故的形状）', () => {
    expect(sameFields({ autoTask: true }, {})).toBe(false);
    expect(sameFields({}, { autoTask: true })).toBe(false);
    expect(sameFields({ autoTask: undefined }, {})).toBe(true);
  });

  it('**多出一个未知字段**也要判为不同（证明不是按清单比）', () => {
    const base = { id: 'h1', name: '背单词' };
    expect(sameFields(base, { ...base, futureField: 1 })).toBe(false);
    expect(sameFields({ ...base, futureField: 1 }, base)).toBe(false);
  });

  it('一侧为空时的口径：两边都空才相等', () => {
    expect(sameFields(null, undefined)).toBe(true);
    expect(sameFields({}, null)).toBe(false);
    expect(sameFields(null, {})).toBe(false);
  });

  it('数组不是记录（避免把 [1,2] 与 {0:1,1:2} 判成相等）', () => {
    expect(sameFields([1, 2], [1, 2])).toBe(false);
  });
});

describe('sameRows：逐位比较，长度与顺序都算差异', () => {
  it('逐位相同 → 相等（即使不是同一个数组）', () => {
    expect(sameRows([{ id: 'a' }, { id: 'b' }], [{ id: 'a' }, { id: 'b' }])).toBe(true);
  });

  it('长度不同 → 不等', () => {
    expect(sameRows([{ id: 'a' }], [{ id: 'a' }, { id: 'b' }])).toBe(false);
  });

  it('元素互换位置 → 不等（列表顺序会原样渲染出去）', () => {
    expect(sameRows([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'a' }])).toBe(false);
  });

  it('第 n 项的某个字段变了 → 不等', () => {
    expect(sameRows([{ id: 'a' }, { id: 'b', n: 2 }], [{ id: 'a' }, { id: 'b', n: 3 }])).toBe(false);
  });

  it('同一引用直接返回 true（省掉逐项遍历）', () => {
    const list = [{ id: 'a' }];
    expect(sameRows(list, list)).toBe(true);
  });

  it('两侧都空 → 相等', () => {
    expect(sameRows([], [])).toBe(true);
    expect(sameRows(null as never, undefined as never)).toBe(true);
  });
});

describe('sameByIdentity：按主键 + 版本戳，不比内容', () => {
  interface Row { id: string; updatedAt?: string; title?: string }
  const byId = (item: Row) => item.id;
  const byStamp = (item: Row) => item.updatedAt;

  it('主键与版本戳都相同 → 相等', () => {
    const a = [{ id: '1', updatedAt: 'T1', title: '甲' }];
    const b = [{ id: '1', updatedAt: 'T1', title: '乙' }];
    expect(sameByIdentity(a, b, byId, byStamp)).toBe(true);
  });

  it('版本戳变了 → 不等（漏比这一项 = 那一项永远同步不了）', () => {
    const a = [{ id: '1', updatedAt: 'T1' }];
    const b = [{ id: '1', updatedAt: 'T2' }];
    expect(sameByIdentity(a, b, byId, byStamp)).toBe(false);
  });

  it('多一条 / 少一条 → 不等', () => {
    const a = [{ id: '1', updatedAt: 'T1' }];
    const b = [
      { id: '1', updatedAt: 'T1' },
      { id: '2', updatedAt: 'T1' },
    ];
    expect(sameByIdentity(a, b, byId, byStamp)).toBe(false);
    expect(sameByIdentity(b, a, byId, byStamp)).toBe(false);
  });

  it('主键相同但换了另一组 — 两侧条数相同也不能判等', () => {
    const a = [{ id: '1', updatedAt: 'T1' }];
    const b = [{ id: '2', updatedAt: 'T1' }];
    expect(sameByIdentity(a, b, byId, byStamp)).toBe(false);
  });

  it('脏数据（非对象 / 主键缺失 / 主键为空）先剔除，不抛异常', () => {
    const dirty = [null, undefined, 42, { updatedAt: 'T1' }, { id: '', updatedAt: 'T1' }] as never[];
    expect(sameByIdentity(dirty, [], byId, byStamp)).toBe(true);
    expect(() => sameByIdentity(dirty, dirty, byId, byStamp)).not.toThrow();
  });

  it('重复主键塌成一条时不能把"两条"和"一条"判成相等', () => {
    const two = [
      { id: '1', updatedAt: 'T1' },
      { id: '1', updatedAt: 'T1' },
    ];
    const one = [{ id: '1', updatedAt: 'T1' }];
    expect(sameByIdentity(two, one, byId, byStamp)).toBe(false);
  });

  it('非数组按空集处理（与各调用点原来的 listOf 口径一致）', () => {
    expect(sameByIdentity(null, undefined, byId, byStamp)).toBe(true);
    expect(sameByIdentity([{ id: '1', updatedAt: 'T1' }], null, byId, byStamp)).toBe(false);
  });

  it('单个元素也得看版本戳，不能"都只有一个就是同一份"', () => {
    expect(
      sameByIdentity([{ id: '1', updatedAt: 'T1' }], [{ id: '1', updatedAt: 'T9' }], byId, byStamp),
    ).toBe(false);
  });
});
