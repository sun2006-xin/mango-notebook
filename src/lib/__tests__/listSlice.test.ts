import { describe, expect, it } from 'vitest';
import { resolveReviewKey, sliceForPreview } from '../listSlice';

/* ============================================================================
   两个"从 UI 里抽出来的规则"的行为测试（v0.29.8）
   ----------------------------------------------------------------------------
   这两个函数原本是 JSX 上方三行、以及 keydown 处理里的一段 if。
   抽出来不是为了少写代码，而是因为**它们的边界条件没人测过**：

   · 截断：刚好 N 条算不算溢出？少于 N 条时 overflow 是负数吗？
   · 键位：没翻开时按数字该不该评级？空格在已翻开时该不该拦？
   ========================================================================= */

describe('sliceForPreview（"还有 N 条"的截断）', () => {
  const items = ['a', 'b', 'c', 'd', 'e'];

  it('超过上限且未展开 → 只给前 3 条，并报出剩余数', () => {
    const r = sliceForPreview(items, false);
    expect(r.visible).toEqual(['a', 'b', 'c']);
    expect(r.overflow).toBe(2);
  });

  it('刚好等于上限 → 没有溢出（不能显示"还有 0 条"）', () => {
    const r = sliceForPreview(['a', 'b', 'c'], false);
    expect(r.visible).toHaveLength(3);
    expect(r.overflow).toBe(0);
  });

  it('少于上限 → overflow 是 0 而不是负数（否则按钮写"还有 -1 条"）', () => {
    const r = sliceForPreview(['a'], false);
    expect(r.visible).toEqual(['a']);
    expect(r.overflow).toBe(0);
  });

  it('展开后 → 全部显示，但 overflow 仍按原始长度算', () => {
    const r = sliceForPreview(items, true);
    expect(r.visible).toEqual(items);
    expect(r.overflow).toBe(2);
  });

  it('上限可配；非法上限回落到 3（不产生空列表）', () => {
    expect(sliceForPreview(items, false, 2).visible).toEqual(['a', 'b']);
    expect(sliceForPreview(items, false, 0).visible).toHaveLength(3);
    expect(sliceForPreview(items, false, Number.NaN).visible).toHaveLength(3);
  });

  it('空列表 → 空结果且无溢出（不抛）', () => {
    expect(sliceForPreview([], false)).toEqual({ visible: [], overflow: 0 });
  });
});

describe('resolveReviewKey（复习会话的键位）', () => {
  it('Esc 永远退出（会话没开始也认）', () => {
    expect(resolveReviewKey('Escape', false)).toBe('exit');
    expect(resolveReviewKey('Escape', true)).toBe('exit');
  });

  it('空格在翻开前 = 翻开，翻开后仍算会话的键（no-op 但必须拦）', () => {
    expect(resolveReviewKey(' ', false)).toBe('reveal');
    // 已翻开时不能返回 null：null 意味着"不拦默认行为"→ 整页往下滚
    expect(resolveReviewKey(' ', true)).toBe('reveal');
    expect(resolveReviewKey('Spacebar', true)).toBe('reveal');
  });

  it('没翻开时数字键不评级（否则会把没看过的卡评掉）', () => {
    for (const key of ['1', '2', '3']) {
      expect(resolveReviewKey(key, false)).toBeNull();
    }
  });

  it('翻开后 1/2/3 → again / hard / good', () => {
    expect(resolveReviewKey('1', true)).toBe('again');
    expect(resolveReviewKey('2', true)).toBe('hard');
    expect(resolveReviewKey('3', true)).toBe('good');
  });

  it('其余按键交还给全局（返回 null → 调用方不拦）', () => {
    for (const key of ['4', '9', 'a', 'Enter', 'ArrowLeft']) {
      expect(resolveReviewKey(key, true)).toBeNull();
    }
  });
});
