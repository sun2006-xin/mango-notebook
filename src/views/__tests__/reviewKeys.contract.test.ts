import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveReviewKey } from '../../lib/listSlice';

/* ============================================================================
   复习页的键盘：**逻辑测行为，接线测存在**（v0.29.8 从纯源码扫描改过来）
   ----------------------------------------------------------------------------
   原来的写法是把 ReviewView.tsx 当字符串，断言 `event.preventDefault()` 出现在
   `rate('again')` 之前。它守住过一次真实事故（评一次级顺带把页面切走），
   但代价是**一切排版改动都会假红** —— 这轮把 if 链换成 resolveReviewKey 时，
   它红了，而行为其实完全没变。

   现在：键位翻译是纯函数（`lib/listSlice.ts`），用行为测试覆盖 5 种情形；
   只留两条"接线"断言，确认组件真的用了它、且 App 在复习视图关掉了全局热键
   —— 这两件事没有更便宜的验证方式（组件要挂整个 store 才能渲染）。
   ========================================================================= */

const REVIEW = readFileSync(new URL('../ReviewView.tsx', import.meta.url), 'utf8');
const APP = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8');

describe('键位翻译（行为）', () => {
  it('翻开后 1/2/3 分别是 again / hard / good', () => {
    expect(resolveReviewKey('1', true)).toBe('again');
    expect(resolveReviewKey('2', true)).toBe('hard');
    expect(resolveReviewKey('3', true)).toBe('good');
  });

  it('没翻开时数字键不评级（交还给全局，不拦）', () => {
    expect(resolveReviewKey('1', false)).toBeNull();
  });

  it('空格已翻开时也返回 reveal（no-op 但必须拦，否则整页滚）', () => {
    expect(resolveReviewKey(' ', true)).toBe('reveal');
  });

  it('Esc 永远退出', () => {
    expect(resolveReviewKey('Escape', false)).toBe('exit');
  });
});

describe('接线（只有两条）', () => {
  it('ReviewView 用纯函数翻译按键，并在拿到动作后 preventDefault', () => {
    expect(REVIEW).toContain('resolveReviewKey(event.key, revealed)');
    // 顺序：先翻译 → 再拦默认行为 → 再执行
    const call = REVIEW.indexOf('resolveReviewKey(event.key, revealed)');
    const prevent = REVIEW.indexOf('event.preventDefault()', call);
    const act = REVIEW.indexOf("if (action === 'exit')", call);
    expect(call).toBeGreaterThan(-1);
    expect(prevent).toBeGreaterThan(call);
    expect(act).toBeGreaterThan(prevent);
  });

  it('App 在复习视图里关掉全局快捷键（第二道保险）', () => {
    expect(APP).toContain("view !== 'review'");
  });
});
