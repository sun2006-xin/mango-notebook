import { clampEstimateMinutes } from './task';

/* ============================================================================
   任务拆解（长期迭代「AI 任务拆解」）
   ----------------------------------------------------------------------------
   要解决的事：一条「复习高数第 3 章」躺在清单上，用户看着它不想动 ——
   不是懒，是**它不是一个能立刻开始的动作**。拆成 4 个 15 分钟的步骤之后，
   "先做第一步"的门槛会低得多。

   ⚠️ 关于「AI」这两个字，必须说清楚：
   本工程是纯前端（网页 / 桌面 / 安卓三端同源，离线可用），**没有服务端可以
   调大模型**。所以这里做的是**本地规则拆解**，不是模型推理：
   - 认标题里的显式分点（`1.` `①` `、`）→ 按分点拆，这是最准的一路；
   - 认几类学习任务的关键词（背 / 刷题 / 复习 / 输入 / 产出 / 整理）→ 套阶段模板；
   - 都认不出 → 通用四步（读 → 做 → 测 → 收）。
   三条都不联网、都有确定答案，所以能单测、能离线、不会突然收费或改口。

   为什么不假装成 AI：一条拆错的步骤用户要手动删四次才回到原状。
   **给出"我怎么拆的"比给出"我很聪明"更重要** —— 所以 `reason` 会显示在界面上，
   拆完还能逐条删改。
   ========================================================================= */

/** 最多拆成几步：再多就不是"降低门槛"，而是把一件事变成第二份待办清单 */
export const BREAKDOWN_MAX_STEPS = 6;

/** 每步最短 1 分钟（0 会被当成"未估时"，语义完全不同） */
const MIN_STEP_MINUTES = 1;

export interface BreakdownStep {
  title: string;
  /** 这步预估分钟数；未估时的情况下等于一个番茄 */
  estimatedMinutes: number;
}

export type BreakdownStrategy = 'explicit' | 'template' | 'generic';

export interface BreakdownPlan {
  steps: BreakdownStep[];
  strategy: BreakdownStrategy;
  /** 给界面看的一句话："怎么拆的"（数字必须能对上，不能是空话） */
  reason: string;
}

/**
 * 「这次拆解实际落了什么」的摘要（界面用它回话）。
 *
 * 为什么 `added` 和 `reason` 必须一起返回：只报"拆成 4 步"而不说"其实加了 0 条"
 * （因为都已经存在）就是撒谎。两个数字放一个结构里，调用方就没法只显示一半。
 */
export interface BreakdownResult {
  added: number;
  reason: string;
}

export interface BreakdownInput {
  title: string;
  /** 备注也参与"显式分点"的识别（很多人把步骤写在备注里） */
  note?: string;
  /** 父任务的预计用时；0 = 未估时 */
  estimatedMinutes?: number;
  /** 番茄时长（分钟），未估时时每步用它 */
  focusMinutes?: number;
}

/** 圈号分点：①②③…（中文笔记里极常见） */
const CIRCLED_MARKERS = /[①②③④⑤⑥⑦⑧⑨⑩]/;

/**
 * 阿拉伯序号分点：`1.` `1、` `1)`，且要求**从 1 开始、连续递增、至少两个**。
 *
 * 为什么要这么严：`复习 3.1 节` 里的 `3.` 长得也像序号。只看"有没有数字加号"
 * 会把一条正常标题劈成两半，而且拆出来的两半都不知所云。要求"首项是 1 且递增"
 * 之后，`3.1 节`、`第 2 章` 这类就自然排除了。
 */
function numberedParts(text: string): string[] {
  const markers = [...text.matchAll(/(?:^|\s)(\d{1,2})[.、)）]\s*/g)];
  if (markers.length < 2) return [];
  const numbers = markers.map((match) => Number(match[1]));
  if (numbers[0] !== 1) return [];
  if (numbers.some((value, index) => value !== index + 1)) return [];
  return text
    .split(/(?:^|\s)\d{1,2}[.、)）]\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** 从标题/备注里找显式分点；找不到就返回空数组 */
function splitExplicit(title: string, note: string): string[] {
  const sources = [title, note];
  for (const source of sources) {
    const text = source.trim();
    if (!text) continue;
    if (CIRCLED_MARKERS.test(text)) {
      const parts = text
        .split(CIRCLED_MARKERS)
        .map((part) => part.trim())
        .filter(Boolean);
      if (parts.length >= 2) return parts;
    }
    const numbered = numberedParts(text);
    if (numbered.length >= 2) return numbered;
    /**
     * 顿号/逗号分隔：只在**标题**里认（备注里逗号太多，几乎每句话都有，
     * 拿它拆分点会把一句完整的备注拆成一堆碎片）。
     */
    if (source === title) {
      const parts = text
        .split(/[、；;]/)
        .map((part) => part.trim())
        .filter((part) => part.length >= 2);
      if (parts.length >= 2) return parts;
    }
  }
  return [];
}

/**
 * 关键词 → 阶段模板。
 *
 * 顺序有意义：`复习` 排在 `阅读` 前（"复习讲义"是复习不是输入），
 * `刷题` 排在 `复习` 前（"复习错题并刷题"更该按刷题拆）。
 */
const TEMPLATES: { test: RegExp; label: string; steps: string[] }[] = [
  {
    test: /(真题|刷题|做题|练习题|套卷|模拟卷|试卷)/,
    label: '刷题',
    steps: ['限时做一组', '对答案标出错题', '逐个搞懂错题', '重做一遍错题'],
  },
  {
    test: /(背|单词|词汇|记忆|默写|背诵|口语)/,
    label: '记忆',
    steps: ['过一遍新词', '遮住中文回想', '默写或跟读一遍', '标出没记住的'],
  },
  {
    test: /(复习|回顾|过一遍|复盘|巩固)/,
    label: '复习',
    steps: ['读一遍笔记', '合上复述要点', '做两道检查题', '补上漏洞'],
  },
  {
    test: /(阅读|看书|教材|网课|视频|课程|听课|讲义|公开课)/,
    label: '输入',
    steps: ['过一遍内容', '记下关键点', '做配套练习', '用一句话小结'],
  },
  {
    test: /(写|作文|论文|报告|代码|实现|项目|设计)/,
    label: '产出',
    steps: ['列提纲／理清需求', '写第一版', '跑通或改一遍', '定稿收尾'],
  },
  {
    test: /(整理|总结|笔记|归纳|思维导图|错题本)/,
    label: '整理',
    steps: ['收集材料', '整理成结构', '补上遗漏', '自测一遍'],
  },
];

const GENERIC_STEPS = ['读材料', '动手做', '自测检查', '收尾整理'];

/**
 * 把总时长分到 N 步：**总和严格等于总时长**（余数补给最后几步）。
 *
 * 为什么不用"每步 = 总时长/N 再四舍五入"：那会让 4 步加起来比原估时多出
 * 几分钟 —— 而"今日预算"是按估时求和的，用户会看到拆完之后预算凭空变多。
 */
function distribute(total: number, count: number): number[] {
  if (count <= 0) return [];
  if (total <= 0) return [];
  const base = Math.floor(total / count);
  const remainder = total - base * count;
  return Array.from({ length: count }, (_, index) =>
    Math.max(MIN_STEP_MINUTES, base + (index >= count - remainder ? 1 : 0)),
  );
}

/**
 * 生成一份拆解方案（纯函数，不读时钟、不碰存储、不联网）。
 *
 * @param maxSteps 上限（默认 `BREAKDOWN_MAX_STEPS`）；显式分点超过它时，
 *                 多出来的会合并成最后一条「其余 N 项」，绝不静默丢弃用户写的内容。
 *                 `0` / 负数 / `NaN` 一律**回落默认上限** —— 那是"没设"的意思，
 *                 不是"别拆"（要别拆就别调用这个函数）。
 */
export function planBreakdown(input: BreakdownInput, maxSteps = BREAKDOWN_MAX_STEPS): BreakdownPlan {
  const title = typeof input?.title === 'string' ? input.title.trim() : '';
  const note = typeof input?.note === 'string' ? input.note : '';
  const focusMinutes = Number.isFinite(input?.focusMinutes) ? Math.trunc(input.focusMinutes as number) : 0;
  const total = clampEstimateMinutes(input?.estimatedMinutes);
  const limit = Math.max(1, Math.min(BREAKDOWN_MAX_STEPS, Math.trunc(maxSteps) || BREAKDOWN_MAX_STEPS));

  if (!title) return { steps: [], strategy: 'generic', reason: '标题为空，没有可拆的内容' };

  const explicit = splitExplicit(title, note);
  let titles: string[];
  let strategy: BreakdownStrategy;
  let reason: string;

  if (explicit.length >= 2) {
    strategy = 'explicit';
    // 分点里出现与标题完全相同的片段（"复习高数：复习高数"）没有意义，过滤掉
    const cleaned = explicit.filter((part) => part !== title);
    const kept = cleaned.length >= 2 ? cleaned : explicit;
    if (kept.length > limit) {
      const head = kept.slice(0, limit - 1);
      titles = [...head, `其余 ${kept.length - head.length} 项`];
    } else {
      titles = kept;
    }
    reason = `按标题里的 ${kept.length} 个分点拆分`;
  } else {
    const matched = TEMPLATES.find((template) => template.test.test(title));
    if (matched) {
      strategy = 'template';
      titles = matched.steps.slice(0, limit);
      reason = `按「${matched.label}」类任务拆成 ${titles.length} 步`;
    } else {
      strategy = 'generic';
      titles = GENERIC_STEPS.slice(0, limit);
      reason = `没认出具体类型，按通用 ${titles.length} 步拆（读 → 做 → 测 → 收）`;
    }
  }

  if (titles.length === 0) return { steps: [], strategy, reason };

  /**
   * 时长：给了估时就按估时分（总和不变）；没给就每步一个番茄。
   * 估时比步数还少（例如 3 分钟 4 步）时**减少步数**——一步 0 分钟等于
   * "未估时"，会让今日预算把它当没填，语义就乱了。
   */
  const count = total > 0 ? Math.min(titles.length, Math.max(1, total)) : titles.length;
  const kept = titles.slice(0, count);
  const minutes = total > 0 ? distribute(total, count) : kept.map(() => Math.max(MIN_STEP_MINUTES, focusMinutes || 0) || MIN_STEP_MINUTES);

  const steps: BreakdownStep[] = kept.map((stepTitle, index) => ({
    title: stepTitle,
    estimatedMinutes: Math.max(MIN_STEP_MINUTES, minutes[index] ?? MIN_STEP_MINUTES),
  }));

  return { steps, strategy, reason };
}
