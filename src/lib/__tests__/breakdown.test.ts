import { describe, expect, it } from 'vitest';
import { BREAKDOWN_MAX_STEPS, planBreakdown } from '../breakdown';

/* ============================================================================
   任务拆解（长期迭代「AI 任务拆解」）
   ----------------------------------------------------------------------------
   ⚠️ 这里是**本地规则**，不是大模型（本应用没有服务端，见 breakdown.ts 的注释）。
   规则引擎的测试重点与模型不同：不是"答得好不好"，而是
   ① 认出什么、按什么顺序认（优先级错了会把"复习讲义"拆成输入类）；
   ② 认错时**不劈碎用户的话**（`复习 3.1 节` 绝不能被当成序号分点）；
   ③ 时长分布**总和不变**（变了会让「今日预算」凭空膨胀）。
   ========================================================================= */

describe('planBreakdown · 显式分点（最准的一路）', () => {
  it('圈号 ①②③ → 按分点拆', () => {
    const plan = planBreakdown({ title: '复习计划 ①看网课 ②做练习 ③总结错题' });
    expect(plan.strategy).toBe('explicit');
    /**
     * 第一个圈号**之前**那段文字也会成为一步（'复习计划'）。
     * 这是刻意的：宁可多一条能删掉的，也不静默丢掉用户写的字 ——
     * 拆完本来就可以逐条改。
     */
    expect(plan.steps.map((step) => step.title)).toEqual([
      '复习计划',
      '看网课',
      '做练习',
      '总结错题',
    ]);
    expect(plan.reason).toContain('4 个分点');
  });

  it('阿拉伯序号 1. 2. 3. → 按分点拆', () => {
    const plan = planBreakdown({ title: '英语 1.背单词 2.做阅读 3.写作文' });
    expect(plan.strategy).toBe('explicit');
    expect(plan.steps).toHaveLength(4); // 序号前的"英语"也是一段，不丢内容
    expect(plan.steps.map((step) => step.title)).toContain('背单词');
  });

  it('顿号分隔的标题 → 按分点拆', () => {
    const plan = planBreakdown({ title: '整理笔记、补错题、做一套真题' });
    expect(plan.strategy).toBe('explicit');
    expect(plan.steps.map((step) => step.title)).toEqual(['整理笔记', '补错题', '做一套真题']);
  });

  it('备注里的分点也认（很多人把步骤写在备注里）', () => {
    const plan = planBreakdown({ title: '高数第三章', note: '①看定义 ②做例题 ③刷课后题' });
    expect(plan.strategy).toBe('explicit');
    expect(plan.steps).toHaveLength(3);
  });

  /**
   * 这条是**反向守护**：`复习 3.1 节` 里的 `3.` 长得像序号，但首项不是 1、
   * 也不递增。如果按序号劈开，会得到「复习」「1 节」两条都不知所云的任务。
   */
  it('`复习 3.1 节` 不会被当成序号分点（首项必须从 1 开始）', () => {
    const plan = planBreakdown({ title: '复习 3.1 节' });
    expect(plan.strategy).toBe('template');
    expect(plan.steps.map((step) => step.title)).not.toContain('1 节');
  });

  it('分点比上限多 → 多出来的合并成「其余 N 项」，不静默丢弃', () => {
    const plan = planBreakdown({ title: '①a ②b ③c ④d ⑤e ⑥f ⑦g ⑧h' }, 4);
    expect(plan.steps).toHaveLength(4);
    expect(plan.steps[3]?.title).toBe('其余 5 项');
  });
});

describe('planBreakdown · 关键词模板（顺序有意义）', () => {
  it('背单词 → 记忆类', () => {
    const plan = planBreakdown({ title: '背 50 个单词' });
    expect(plan.strategy).toBe('template');
    expect(plan.reason).toContain('记忆');
    expect(plan.steps).toHaveLength(4);
  });

  /** 刷题排在复习前：`复习错题并刷题` 更该按刷题拆（先做后复盘） */
  it('`复习错题并刷题` 归到刷题类，而不是复习类', () => {
    const plan = planBreakdown({ title: '复习错题并刷题' });
    expect(plan.reason).toContain('刷题');
  });

  /** 复习排在输入前：`复习讲义` 是复习，不是"读教材" */
  it('`复习讲义` 归到复习类，而不是输入类', () => {
    const plan = planBreakdown({ title: '复习讲义' });
    expect(plan.reason).toContain('复习');
  });

  it('认不出类型 → 通用四步，且 reason 说明是通用', () => {
    const plan = planBreakdown({ title: '嗯' });
    expect(plan.strategy).toBe('generic');
    expect(plan.steps.map((step) => step.title)).toEqual([
      '读材料',
      '动手做',
      '自测检查',
      '收尾整理',
    ]);
    expect(plan.reason).toContain('通用');
  });

  it('空标题 → 不拆（返回空 steps，并说明原因）', () => {
    const plan = planBreakdown({ title: '   ' });
    expect(plan.steps).toEqual([]);
    expect(plan.reason).toContain('标题为空');
  });
});

describe('planBreakdown · 时长', () => {
  /** 总和必须严格等于原估时：多一分钟，今日预算就凭空变大 */
  it('给了估时 → 每一步的估时加起来刚好等于原估时', () => {
    const plan = planBreakdown({ title: '背单词', estimatedMinutes: 90 });
    const sum = plan.steps.reduce((acc, step) => acc + step.estimatedMinutes, 0);
    expect(plan.steps).toHaveLength(4);
    expect(sum).toBe(90);
  });

  it('不能整除时余数补给后面几步，总和仍然不变', () => {
    const plan = planBreakdown({ title: '背单词', estimatedMinutes: 91 });
    const sum = plan.steps.reduce((acc, step) => acc + step.estimatedMinutes, 0);
    expect(sum).toBe(91);
  });

  it('没给估时 → 每步一个番茄（用 focusMinutes）', () => {
    const plan = planBreakdown({ title: '背单词', estimatedMinutes: 0, focusMinutes: 25 });
    expect(plan.steps.every((step) => step.estimatedMinutes === 25)).toBe(true);
  });

  /** 估时比步数还少时减少步数：0 分钟会被当成"未估时"，语义就乱了 */
  it('估时只有 3 分钟 → 只拆 3 步，且每步至少 1 分钟', () => {
    const plan = planBreakdown({ title: '背单词', estimatedMinutes: 3 });
    expect(plan.steps).toHaveLength(3);
    expect(plan.steps.every((step) => step.estimatedMinutes >= 1)).toBe(true);
  });

  /**
   * 上限夹在 1–6。
   * 传 0 / 负数不是"拆 0 步"，而是**回落默认上限** —— 那是"没设"的意思，
   * 不是"别拆"（要别拆就别调这个函数）。
   */
  it('步数上限被夹在 1–BREAKDOWN_MAX_STEPS', () => {
    const eight = { title: '①a ②b ③c ④d ⑤e ⑥f ⑦g ⑧h' };
    expect(planBreakdown(eight, 1).steps).toHaveLength(1);
    expect(planBreakdown(eight, 99).steps).toHaveLength(BREAKDOWN_MAX_STEPS);
    expect(planBreakdown(eight, 0).steps).toHaveLength(BREAKDOWN_MAX_STEPS);
  });
});

describe('planBreakdown · 纯函数', () => {
  it('同一输入两次结果完全一致（没有随机 / 没有读时钟）', () => {
    const first = planBreakdown({ title: '背单词', estimatedMinutes: 60 });
    const second = planBreakdown({ title: '背单词', estimatedMinutes: 60 });
    expect(second).toEqual(first);
  });
});
