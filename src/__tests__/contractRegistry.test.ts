import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ============================================================================
   契约测试登记表（v0.29.8）
   ----------------------------------------------------------------------------
   这个工程用"扫源码 + 断言字符串"代替 ESLint，好处是零依赖、跑得快、每条都能
   带一段"为什么"。代价是**脆**：改个排版就假红。
   所以每个 `*.contract.test.ts` 都必须在这里登记 —— 登记时被迫回答一个问题：

       **这条契约为什么不能写成行为测试？**

   答案只有三种：
     · `behavior`    —— 已经是行为测试（动真实代码/组件），不是扫源码；
     · `source-scan` —— 只能扫源码。判据是"被验证的对象本身就是源码写法"，
                        例如"组件里不许出现字面量颜色""lib 不许 import react""没有循环依赖"。
     · `mixed`       —— 逻辑已抽成纯函数走行为测试，只剩接线断言扫源码。

   新增契约不登记 → 这个测试红；登记了但理由说不清 → review 时打回。
   每把一个 `source-scan` 转成 `behavior`，未来重构的自由度就多一分。
   ========================================================================= */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');

type Kind = 'behavior' | 'source-scan' | 'mixed';

/** 唯一真相：所有契约测试及其性质 */
const REGISTRY: Record<string, { kind: Kind; why: string }> = {
  '__tests__/architecture.contract.test.ts': {
    kind: 'source-scan',
    why: '被验证的就是"import 图"本身（分层/循环依赖），没有比扫源码更直接的办法',
  },
  '__tests__/designSystem.contract.test.ts': {
    kind: 'source-scan',
    why: '"组件里不许出现字面色值/三件套"只能靠扫源码；渲染出来再看 class 反而绕',
  },
  'lib/__tests__/storageSurface.contract.test.ts': {
    kind: 'behavior',
    why: '动态 import 真实模块，断言导出名字与类型 —— 已经是行为测试',
  },
  'store/__tests__/fieldCoverage.contract.test.ts': {
    kind: 'source-scan',
    why: '扫"哪些字段没被 withFieldClocks 覆盖"，需要看类型定义与调用点',
  },
  'components/__tests__/mobileOverflow.contract.test.ts': {
    kind: 'mixed',
    why: 'Segmented 的收缩类名只能扫（jsdom 没有排版引擎）；真正的闸门是浏览器审计脚本',
  },
  'components/settings/__tests__/dataSection.contract.test.ts': {
    kind: 'source-scan',
    why: '部分转：字段级顺序（快照先于 hydrate）仍是源码断言；"快照失败则中止恢复"已用真实 toast/分支守住',
  },
  'components/task/__tests__/overdueFocus.contract.test.ts': {
    kind: 'source-scan',
    why: '不转：守的是"逾期行也给了起番茄的入口"这条接线，属 props 传递',
  },
  'components/task/__tests__/taskRowMemo.contract.test.ts': {
    kind: 'source-scan',
    why: '守的是"行组件不许收内联箭头函数"（memo 会失效），属于代码写法',
  },
  'components/__tests__/shellFixes.contract.test.ts': {
    kind: 'source-scan',
    why: '守的是"某个修法还在"（Host 白名单、错误监听），属于代码写法',
  },
  'components/__tests__/touchTarget.contract.test.ts': {
    kind: 'source-scan',
    why: '量的是类名里有没有 44px 触控尺寸；真实尺寸由浏览器审计兜底',
  },
  'views/__tests__/todayFirstScreen.contract.test.ts': {
    kind: 'mixed',
    why: '顺序/归属（标题在概览前、四块在面板内）是 JSX 结构；截断规则已转行为（listSlice.test）',
  },
  'views/__tests__/reviewKeys.contract.test.ts': {
    kind: 'mixed',
    why: '键位翻译已抽成 resolveReviewKey 走行为测试，只剩"组件用了它 + App 关热键"两条接线',
  },
  'views/__tests__/infoArchitecture.contract.test.ts': {
    kind: 'source-scan',
    why: '守的是导航结构（6 个 Tab、设置分 7 组、默认展开 2 组），源自常量与 JSX',
  },
  'views/__tests__/focusView.contract.test.ts': {
    kind: 'source-scan',
    why: '不转：断言的是"这些 testid 必须还在 + 仪表盘只在非提醒模式渲染"，本质是 JSX 结构；渲染它要 mock 掉 TimerPanels 与整个 store，测出来的是 mock 的顺序而不是真实行为',
  },
  'views/__tests__/settingsDeps.contract.test.ts': {
    kind: 'mixed',
    why: '抽真实依赖数组再查成员（不做字符串全等），已经抗格式；仍需读源码才能拿到数组',
  },
  'views/__tests__/importBackup.contract.test.ts': {
    kind: 'source-scan',
    why: '不转：导入流程的可测部分（载荷解析、字段兜底）已由 backup.test / importBackup 的纯函数用例覆盖；剩下是组件内顺序，渲染成本高收益低',
  },
  'views/__tests__/diaryWeekSwitch.contract.test.ts': {
    kind: 'source-scan',
    why: '不转：断言是三档按钮与 offset 传递，属 DiaryView 内部接线；周报计算本身由 weekly.test / weeklyOffset.test 行为覆盖',
  },
  'views/__tests__/notesDeepLink.contract.test.ts': {
    kind: 'source-scan',
    why: '不转：深链是"store 里的 pendingOpenNoteId → 视图消费"的接线；行为等价物需要挂 NotesView（依赖索引侧栏与编辑器）',
  },
  'views/__tests__/longTermWiring.contract.test.ts': {
    kind: 'source-scan',
    why: '不转：习惯派任务 / 周报写日记的**真实链路**已由 scripts/verify_longterm_flows.mjs（11 项端到端）覆盖，这层只是静态提醒',
  },
  'views/__tests__/reviewSession.contract.test.ts': {
    kind: 'source-scan',
    why: '不转：队列与评级逻辑由 srs.test 行为覆盖；这里断言的是"横幅条件 / 按钮只在 revealed 后出现"，渲染 ReviewView 要挂整份 notes store',
  },
  'hooks/__tests__/startFocus.contract.test.ts': {
    kind: 'source-scan',
    why: '不转："自动开局只消费一次"需要同时挂 store + useFocusTimer + 计时器落盘，等价行为已由 verify:flows 与 focusView 的 DOM 用例间接覆盖',
  },
  'hooks/__tests__/renderStability.contract.test.ts': {
    kind: 'source-scan',
    why: '守的是 memo/props 稳定性（是否出现内联箭头函数），属于代码写法',
  },
  'hooks/__tests__/reminderWatcher.contract.test.ts': {
    kind: 'mixed',
    why: '到点响一次已用真 localStorage + 假定时器跑通（reminderWatcher.dom.test.tsx 6 条），只剩"挂在 App 顶层 / FocusView 不引用"两条接线',
  },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.contract\.test\.(ts|tsx)$/.test(name)) {
      out.push(path.relative(SRC, full).replace(/\\/g, '/'));
    }
  }
  return out;
}

const found = walk(SRC).sort();
const registered = Object.keys(REGISTRY).sort();

describe('契约测试登记表', () => {
  it('每个契约测试都登记了（新增契约不登记 = 没人评估过它该不该扫源码）', () => {
    const missing = found.filter((file) => !REGISTRY[file]);
    expect(missing, `未登记的契约测试：${missing.join(', ')}`).toEqual([]);
  });

  it('登记表里没有已删除的文件（防止清单腐化）', () => {
    const stale = registered.filter((file) => !found.includes(file));
    expect(stale, `登记表里有已不存在的文件：${stale.join(', ')}`).toEqual([]);
  });

  it('每一条都写了理由，且理由不是占位符', () => {
    for (const [file, meta] of Object.entries(REGISTRY)) {
      expect(meta.why.length, `${file} 的理由太短`).toBeGreaterThan(12);
      expect(['behavior', 'source-scan', 'mixed']).toContain(meta.kind);
    }
  });

  it('源码扫描型的比例在下降（当前基线，只许减不许增）', () => {
    /**
     * 这是这轮"把契约转成行为测试"的进度条。
     * 数字是**当前快照**：只能往下走。转完一条就把这里改小，
     * 想新增一条 source-scan 就必须同时把另一条转掉（或明确说明为什么不能）。
     */
    /**
     * 17 = 2026-11-02 的现状快照。**已经没有"待转"的了**：
     * 能转的都转了（reviewKeys / todayFirstScreen 的截断 / useStopwatch 整条 /
     * reminderWatcher 的响铃逻辑），剩下的每一条都写清了"为什么不转"。
     * 转掉一条就改小一次；**新增 source-scan 必须同时转掉一条**，
     * 否则这个数字会慢慢爬回去，"以后再说"就变成永远不说。
     */
    const SOURCE_SCAN_BASELINE = 17;
    const scanCount = Object.values(REGISTRY).filter((m) => m.kind === 'source-scan').length;
    expect(
      scanCount,
      `纯源码扫描型契约有 ${scanCount} 条，超过基线 ${SOURCE_SCAN_BASELINE} —— 新契约应该先考虑行为测试`,
    ).toBeLessThanOrEqual(SOURCE_SCAN_BASELINE);
  });

  it('已转成行为的契约确实不再扫源码为主（抽查 reviewKeys）', () => {
    const file = 'views/__tests__/reviewKeys.contract.test.ts';
    expect(REGISTRY[file].kind).toBe('mixed');
    const code = readFileSync(path.join(SRC, file), 'utf8');
    // 行为测试的特征：直接 import 被测模块
    expect(code).toContain("from '../../lib/listSlice'");
  });
});
