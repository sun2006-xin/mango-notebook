import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/* ============================================================================
   渲染稳定性契约（v0.25）

   三条都是"改一点点就退化，而且退化不会报错、只会变卡"的类型，
   所以只能在源码层面钉死：

   ① `useTaskActions` 的 handler 依赖里**不能有 `tasks`**
      列表行是 memo 的。handler 引用一变 → 所有行重渲 → 勾一个框等于整列表重画。
      读最新任务要经 `tasksRef.current`，依赖里只留真正会变的东西。

   ② `WeekView` 的任务 handler 必须来自 **Map 缓存**
      `onToggle={() => actions.toggleTask(id)}` 这种内联箭头函数每次渲染都是新引用，
      memo 形同虚设；7 列 × 每列 N 条 = 每次渲染新建 7N 个函数。

   ③ 日记 / 记事的 Markdown 预览必须 **useMemo**
      预览是 2 万字级别的同步渲染，每次按键都重算一遍等于把输入法按住不放。

   注意：这些都是"契约"而非"实现细节"——断言的是能保证效果的写法，
   不是某行代码长什么样；但写法一旦被"顺手简化"回内联，测试必须变红。
   ========================================================================= */

function read(rel: string): string {
  const code = readFileSync(new URL(rel, import.meta.url), 'utf8');
  // 剥注释：注释里会引用"错误写法"当反面教材（WeekView 就写着 onToggle={() => ...}），
  // 不剥的话反面教材会把守护用例自己打成红
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '');
}

/**
 * `useCallback` 的收口形式：`    },` 换行 `    [deps],` 再换行 `  );`。
 * 缩进**不能写死**（这里有的是 2 空格、有的是 4 空格）——
 * 第一版就写死了两个空格，结果抓到的是**后面某个函数**的依赖数组，
 * 变异测试里 M16 改回缺陷态居然全绿，守护用例等于没有。
 */
const DEPS_OPEN = /\n\s*\},\s*\[/;

/** 取 `const X = useCallback(...)` 的依赖数组原文 */
function depsOf(src: string, name: string): string {
  const open = depsOpenIndex(src, name);
  const bracket = src.indexOf('[', open);
  const close = src.indexOf(']', bracket); // 依赖数组不嵌套，第一个 ] 就是收口
  return src.slice(bracket + 1, close);
}

/** 函数体（从声明到依赖数组之前） */
function bodyOf(src: string, name: string): string {
  const start = src.indexOf(`const ${name} = useCallback(`);
  if (start < 0) throw new Error(`找不到 ${name}`);
  const rel = src.slice(start).search(DEPS_OPEN);
  if (rel < 0) throw new Error(`找不到 ${name} 的依赖数组`);
  return src.slice(start, start + rel);
}

function depsOpenIndex(src: string, name: string): number {
  const start = src.indexOf(`const ${name} = useCallback(`);
  if (start < 0) throw new Error(`找不到 ${name}`);
  const rel = src.slice(start).search(DEPS_OPEN);
  if (rel < 0) throw new Error(`找不到 ${name} 的依赖数组`);
  return start + rel;
}

describe('① useTaskActions：handler 引用恒定（不随 tasks 变）', () => {
  const src = read('../useTaskActions.ts');

  const stable = ['addSubtask', 'toggleTask', 'deleteTask', 'moveOverdueToToday'];

  for (const name of stable) {
    it(`${name} 的依赖里没有 tasks（改用 tasksRef 读最新值）`, () => {
      const deps = depsOf(src, name);
      // 先自证抽取器没抓错人：这些回调必然依赖 dispatch。
      // 少了这一句，抽取器一旦错位（抓到别的函数）下面的断言就成了摆设
      expect(deps).toMatch(/(^|[^A-Za-z0-9_$])dispatch([^A-Za-z0-9_$]|$)/);
      // 精确匹配单词 tasks，别把 tasksRef 也算进去
      expect(deps).not.toMatch(/(^|[^A-Za-z0-9_$])tasks([^A-Za-z0-9_$]|$)/);
      // 且函数体确实是从 ref 读的（不是"依赖里删了、还在用闭包里的旧值"）
      expect(bodyOf(src, name)).toContain('tasksRef.current');
    });
  }

  it('tasksRef 的存在形式正确：声明后立刻同步，不等 effect', () => {
    expect(src).toContain('const tasksRef = useRef(tasks);');
    expect(src).toContain('tasksRef.current = tasks;');
  });
});

describe('② WeekView：行 handler 走 Map 缓存，不用内联箭头函数', () => {
  const src = read('../../views/WeekView.tsx');

  it('有按 id 建好的 handler 缓存', () => {
    expect(src).toMatch(/const rowHandlers = useMemo\(\s*\(\) => \{/);
    expect(src).toContain('for (const column of columns)');
    expect(src).toContain('map.set(task.id,');
  });

  it('行上取的是缓存里的同一个函数，缺失时回落到模块级 NOOP', () => {
    expect(src).toContain('rowHandlers.get(task.id)?.toggle ?? NOOP');
    expect(src).toContain('rowHandlers.get(task.id)?.open ?? NOOP');
    expect(src).toContain('rowHandlers.get(task.id)?.remove ?? NOOP');
    // NOOP 必须是模块级常量：写成内联 () => {} 又变回"每次都新"
    expect(src).toMatch(/^const NOOP = /m);
  });

  it('行上不再出现内联箭头（内联 = memo 失效）', () => {
    expect(src).not.toContain('onToggle={() =>');
    expect(src).not.toContain('onOpen={() =>');
  });
});

describe('③ Markdown 预览：渲染结果进 useMemo', () => {
  it('DiaryView：previewHtml 由 useMemo 产出，且依赖 draft/mode', () => {
    const src = read('../../views/DiaryView.tsx');
    expect(src).toMatch(/const previewHtml = useMemo\(/);
    expect(src).toMatch(/renderMarkdown\(draft\)/);
    expect(src).toMatch(/\[mode, draft\]/);
    // 渲染期不再现场求值
    expect(src).not.toContain('__html: renderMarkdown(');
  });

  it('NotesView：previewHtml 由 useMemo 产出，且依赖正文', () => {
    const src = read('../../views/NotesView.tsx');
    expect(src).toMatch(/const previewHtml = useMemo\(/);
    expect(src).toMatch(/renderMarkdown\(draft\?\.content/);
    expect(src).not.toContain('__html: renderMarkdown(');
  });
});
