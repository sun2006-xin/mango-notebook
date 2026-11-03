import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isDocumentVisible, shouldAutoContinue } from '../timer';
import { createEmptyState, reducer } from '../../store/reducer';

/* ============================================================================
   番茄自动续接（F16）的判据

   "自动帮你开下一段"是一件**越权**的事，所以三条闸门一条都不能少。
   而这三条的共同点是：漏掉任何一条都不会报错，只会产出错误的数据
   （或者让用户按三次才停得下来）。所以逐条钉死。
   ========================================================================= */

describe('shouldAutoContinue', () => {
  const ALL_ON = { enabled: true, auto: true, visible: true };

  it('三个条件都满足才续接', () => {
    expect(shouldAutoContinue(ALL_ON)).toBe(true);
  });

  it('开关没开 → 不续（默认就是关的：替用户做决定是越权）', () => {
    expect(shouldAutoContinue({ ...ALL_ON, enabled: false })).toBe(false);
  });

  it('用户手点「结束」→ 不续（否则他要按三次才能真的停下来）', () => {
    expect(shouldAutoContinue({ ...ALL_ON, auto: false })).toBe(false);
  });

  it('页面不可见（切标签页 / 锁屏）→ 不续（否则记录里全是"人不在场"的时长）', () => {
    expect(shouldAutoContinue({ ...ALL_ON, visible: false })).toBe(false);
  });

  it('脏输入（undefined / 0 / 空串）一律当 false，不抛', () => {
    expect(shouldAutoContinue({ enabled: undefined as unknown as boolean, auto: true, visible: true })).toBe(false);
    expect(shouldAutoContinue({ enabled: 1 as unknown as boolean, auto: 1 as unknown as boolean, visible: 1 as unknown as boolean })).toBe(true);
  });
});

describe('isDocumentVisible', () => {
  it('测试环境没有 document → 按可见处理（不在 undefined 上炸）', () => {
    expect(isDocumentVisible()).toBe(true);
  });
});

describe('SET_AUTO_CONTINUE', () => {
  it('默认关闭；打开后写入 settings', () => {
    const s0 = createEmptyState();
    expect(s0.settings.autoContinue).toBe(false);
    const s1 = reducer(s0, { type: 'SET_AUTO_CONTINUE', value: true });
    expect(s1.settings.autoContinue).toBe(true);
  });

  it('幂等：值没变 → 同一个 state（settings 会触发写盘 + 云推送）', () => {
    const s0 = reducer(createEmptyState(), { type: 'SET_AUTO_CONTINUE', value: true });
    expect(reducer(s0, { type: 'SET_AUTO_CONTINUE', value: true })).toBe(s0);
  });
});

/* ============================================================================
   接线契约：纯函数只管"要不要续"，还有三处接线错了不会报错
   ========================================================================= */
describe('useFocusTimer 的接线（源码契约）', () => {
  const src = readFileSync(new URL('../../hooks/useFocusTimer.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '');

  it('自然结束（tick）才算 auto —— 传的是 finish(true, true)', () => {
    expect(src).toContain('finish(true, true)');
  });

  it('手点「结束」/「放弃」不续接 —— 传的是 false', () => {
    expect(src).toContain('finish(true, false)');
    expect(src).toContain('finish(false, false)');
  });

  it('续接时接着上一段的任务（不是丢成一个自由专注）', () => {
    expect(src).toContain('beginFocus(lastTaskIdRef.current)');
    // 记住任务的地方：开计时那一刻就写进 ref
    expect(src).toContain('lastTaskIdRef.current = next.taskId');
  });

  it('判据只走 shouldAutoContinue 一个入口（不内联重写条件）', () => {
    expect(src).toContain('shouldAutoContinue({');
    // 内联重写会出现这种组合；出现即说明有第二份判断
    expect(src).not.toContain('settings.autoContinue && auto');
  });
});
