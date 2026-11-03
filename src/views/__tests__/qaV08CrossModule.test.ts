import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VIEW_META, VIEW_ORDER } from '../../constants';
import { sanitizeSettings } from '../../lib/storage';

/* ============================================================================
   QA 独立验证（v0.8 · F1/F2/F4）：跨模块契约

   为什么这些必须"读源码"而不是"跑函数"：
   - `VIEWS` / `VIEW_ORDER` 是模块内私有常量，行为只能从 `sanitizeSettings` 反推
     （review 不在白名单 → 读到它必须回落默认视图）；
   - 「只冻结一次队列」「只消费一次 pending」「busy 分支不许切视图/写盘」
     是**结构约束**，纯函数测不出来，但破坏后的现象很严重（丢卡 / 重复计时）。
   读源码前一律剥离注释，避免注释里的字样造成假阳性。
   ========================================================================= */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../..');

/** 剥注释：块注释 + 行注释（保留字符串里的 URL，因为 `://` 前不是空白） */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '');
}

function read(relFromSrc: string): string {
  return stripComments(fs.readFileSync(path.join(SRC, relFromSrc), 'utf8'));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** 从 `if (...) {` 处取出一段配平的花括号内容 */
function balancedBlock(code: string, anchor: string): string {
  const start = code.indexOf(anchor);
  expect(start).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = code.indexOf('{', start); i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(start, i + 1);
    }
  }
  throw new Error(`未闭合的花括号：${anchor}`);
}

/* ============================================================================
   G. 视图白名单：review 绝不能进（否则复习到一半关应用，冷启动落在空复习页）
   ============================================================================ */
describe('G1 review 不是可持久化视图', () => {
  it('VIEW_ORDER（导航）里没有 review，但 VIEW_META 有元数据（穷举要求）', () => {
    expect(VIEW_ORDER as readonly string[]).not.toContain('review');
    expect(VIEW_META.review.label).toBe('复习');
  });

  it('settings.lastView = review → 落到默认视图（白名单不含它）', () => {
    const s = sanitizeSettings({ lastView: 'review' });
    expect(s.lastView).toBe('today');
  });

  it('settings.defaultView = review → 同样回落', () => {
    const s = sanitizeSettings({ defaultView: 'review' });
    expect(s.defaultView).toBe('today');
  });

  it('对照：today / notes 这类白名单内的视图会被原样保留（说明上面不是因为全都不认）', () => {
    expect(sanitizeSettings({ lastView: 'notes' }).lastView).toBe('notes');
    expect(sanitizeSettings({ defaultView: 'focus' }).defaultView).toBe('focus');
  });
});

/* ============================================================================
   C. 复习会话：队列冻结 + 评级落库口径
   ============================================================================ */
describe('C 复习会话的结构约束（剥注释后验证）', () => {
  const view = read('views/ReviewView.tsx');

  it('队列用 useState 惰性初始化**冻结**（不是每次渲染重算）', () => {
    expect(/useState<string\[\]>\(\s*\(\)\s*=>\s*buildReviewQueue\(/.test(view)).toBe(true);
  });

  it('不存在 useMemo 版本的 buildReviewQueue（那就是"评完一张就跳走"的元凶）', () => {
    expect(/useMemo\s*\(\s*\(\)\s*=>\s*buildReviewQueue/.test(view)).toBe(false);
    // 任何 useMemo 里都不允许出现 buildReviewQueue
    expect(view.includes('buildReviewQueue')).toBe(true);
    const memoCalls = view.match(/useMemo\([\s\S]*?\);/g) ?? [];
    for (const call of memoCalls) expect(call).not.toContain('buildReviewQueue');
  });

  it('current 通过 id 从**当前 notes** 里取（不缓存 note 对象，避免显示旧正文）', () => {
    expect(view.includes('notes.find((note) => note.id === queueIds[cursor])')).toBe(true);
  });

  it('评级 dispatch NOTE_UPSERT，且 now 就是 grade 写进 note 的 updatedAt', () => {
    expect(view.includes("dispatch({ type: 'NOTE_UPSERT', note: next, now: next.updatedAt })")).toBe(
      true,
    );
    expect(view.includes('grade(current, rating, today, now)')).toBe(true);
  });

  it('「这题不再复习」走 unenroll（删 sr 键），不是删除笔记', () => {
    expect(view.includes('unenroll(current, now)')).toBe(true);
    expect(view.includes("type: 'NOTE_DELETE'")).toBe(false);
  });

  it('reducer 里 NOTE_UPSERT 原样收下 note（不会把 sr 剥掉或补回）', () => {
    // v0.20 起 reducer 按域拆开，记事本的 case 在 domains/content.ts
    const contentSrc = read('store/domains/content.ts');
    const block = balancedBlock(contentSrc, "case 'NOTE_UPSERT'");
    expect(block).toContain('...action.note');
    expect(block).not.toContain('sr:');
  });

  it('F1 没有新增 reducer action（评级 / 入队 / 退出 全走 NOTE_UPSERT）', () => {
    // action 联合自 v0.20 起住在 store/actions.ts（唯一声明处）
    const actionsSrc = read('store/actions.ts');
    const actions = [...actionsSrc.matchAll(/type:\s*'([A-Z_]+)'/g)].map((m) => m[1]);
    expect(actions.length).toBeGreaterThan(20); // 确认真的抓到了 action 联合类型
    for (const forbidden of actions) {
      expect(forbidden).not.toMatch(/^(GRADE|REVIEW|SRS|ENROLL|UNENROLL)/);
    }
    expect(actions).toContain('NOTE_UPSERT');
    expect(actions).toContain('DIARY_UPSERT');
  });
});

/* ============================================================================
   D. 任务 ↔ 专注：三分支的并发防护 + 只消费一次
   ============================================================================ */
describe('D startFocus 的三分支（源码契约 + 结构）', () => {
  const hook = read('hooks/useTaskActions.ts');

  it('判据是磁盘运行态 loadRunningTimer()，不是内存 state', () => {
    expect(hook.includes('loadRunningTimer()')).toBe(true);
  });

  it('① 同一任务在跑 → 只切视图（有 SET_VIEW，没有 saveRunningTimer）', () => {
    const block = balancedBlock(hook, 'if (running) {');
    const [sameTaskPart] = block.split('TEXT.focusBusy');
    expect(sameTaskPart).toContain("dispatch({ type: 'SET_VIEW', view: 'focus' })");
    expect(sameTaskPart).not.toContain('saveRunningTimer');
    expect(sameTaskPart).not.toContain('onRequestFocusRef');
  });

  it('② 在跑别的 → 只提示：不出现 SET_VIEW、不写 saveRunningTimer、不请求开局', () => {
    const block = balancedBlock(hook, 'if (running) {');
    const busyPart = block.slice(block.indexOf('TEXT.focusBusy'));
    expect(busyPart).toContain('return;');
    expect(busyPart).not.toContain('SET_VIEW');
    expect(busyPart).not.toContain('saveRunningTimer');
    expect(busyPart).not.toContain('onRequestFocusRef');
  });

  it('③ 空闲 → 先交意图（onRequestFocusRef）再切视图', () => {
    const fnStart = hook.indexOf('const startFocus');
    const tail = hook.slice(fnStart);
    const requestAt = tail.indexOf('onRequestFocusRef.current?.(taskId)');
    const viewAt = tail.indexOf("dispatch({ type: 'SET_VIEW', view: 'focus' })", requestAt);
    expect(requestAt).toBeGreaterThan(-1);
    expect(viewAt).toBeGreaterThan(requestAt);
  });

  it('这个 hook 自己不造计时器（useFocusTimer 只在 FocusView 里挂）', () => {
    expect(hook.includes('useFocusTimer')).toBe(false);
  });
});

describe('D 自动开局只被消费一次', () => {
  /**
   * v0.29.6：`PomodoroPanelInner` 搬到了 `components/focus/TimerPanels.tsx`。
   * 消费逻辑（ref 去重 / 只在 idle 时 start）跟着走，断言原样保留。
   */
  const focusView = read('components/focus/TimerPanels.tsx');

  it('`timer.start(autoStartTaskId)` 全文只出现 1 次', () => {
    const hits = focusView.split('timer.start(autoStartTaskId)').length - 1;
    expect(hits).toBe(1);
  });

  it('消费用 ref 去重（父级 pending 清理是异步的，中间会再渲染一帧）', () => {
    expect(focusView.includes('const consumedRef = useRef<string | null>(null)')).toBe(true);
    expect(focusView.includes('if (consumedRef.current === autoStartTaskId) return;')).toBe(true);
  });

  it('只有 phase === idle 才真的 start（已经在跑只应"接上"，不能重开）', () => {
    expect(focusView.includes("if (timer.phase === 'idle') timer.start(autoStartTaskId);")).toBe(true);
  });

  it('App 持有 pendingFocusTaskId，并在切视图时清掉', () => {
    const app = read('App.tsx');
    expect(app.includes('const [pendingFocusTaskId, setPendingFocusTaskId]')).toBe(true);
    expect(app.includes('pendingFocusTaskId={pendingFocusTaskId}')).toBe(true);
    expect(app.includes('setPendingFocusTaskId(null)')).toBe(true);
  });
});

/* ============================================================================
   F. 恢复唯一入口：全工程只允许一处构造 HYDRATE
   ============================================================================ */
describe('F 恢复唯一入口（扫全工程，剥注释）', () => {
  const files = walk(SRC).map((full) => ({ full, code: stripComments(fs.readFileSync(full, 'utf8')) }));

  it('构造 `type: \'HYDRATE\'` 的地方只有 reducer.ts（actions.ts 里那份是类型声明）', () => {
    const owners = files
      .filter((f) => /type:\s*'HYDRATE'/.test(f.code))
      .map((f) => path.relative(SRC, f.full).replace(/\\/g, '/'))
      .sort();
    // actions.ts = 联合类型声明；reducer.ts = hydrateFromPayload 唯一一处构造
    expect(owners).toEqual(['store/actions.ts', 'store/reducer.ts']);
  });

  it('reducer.ts 里只出现一处 `type: \'HYDRATE\'`（就是 hydrateFromPayload），没有手抄', () => {
    const reducerSrc = read('store/reducer.ts');
    expect((reducerSrc.match(/type:\s*'HYDRATE'/g) ?? []).length).toBe(1);
    // 声明处也只许一处：联合类型是契约，重复声明就等于有两个"真相"
    const actionsSrc = read('store/actions.ts');
    expect((actionsSrc.match(/type:\s*'HYDRATE'/g) ?? []).length).toBe(1);
  });

  it('lib/backup.ts 只导出 parseBackupJson / listLocalBackups，且不碰 HYDRATE', () => {
    const backup = read('lib/backup.ts');
    const exported = [
      ...(backup.match(/export\s+(?:async\s+)?function\s+(\w+)/g) ?? []),
      ...(backup.match(/export\s+const\s+(\w+)/g) ?? []),
    ]
      .map((line) => line.replace(/export\s+(?:async\s+)?(?:function|const)\s+/, ''))
      .sort();
    expect(exported).toEqual(['listLocalBackups', 'parseBackupJson']);
    expect(backup).not.toContain('HYDRATE');
    expect(backup).not.toContain('hydrateFromPayload');
  });

  /**
   * v0.29.x 起这条契约又升了一级：从"设置页里只许有一个 hydrateFrom 定义"
   * 升级成"**全工程只有一个构造点** `hooks/useHydrateFrom.ts`"。
   *
   * 为什么必须升级：设置页被拆成「云同步 / 数据备份 / 历史回滚」几块之后，
   * 每块都得把 payload 装回状态。若各自 `import hydrateFromPayload`，
   * 手抄四份的老问题会**在文件的维度上重演** —— 新增持久化字段时又是满仓库找调用点。
   * 现在统一调 `useHydrateFrom()`，构造点只有一处。
   */
  it('全工程只有一处构造 HYDRATE 载荷（hooks/useHydrateFrom.ts）', () => {
    const owners = files
      .filter((f) => f.code.includes('hydrateFromPayload('))
      .map((f) => path.relative(SRC, f.full).replace(/\\/g, '/'))
      .filter((name) => !name.includes('__tests__'))
      .sort();
    /**
     * 三个白名单，各有各的理由：
     * - `store/reducer.ts`      定义处
     * - `hooks/useHydrateFrom.ts` 唯一常规调用处
     * - `App.tsx`               **后台合并**专用：它必须把 `lastView` 改回当前页面再装，
     *   否则每 60 秒一次自动同步会把用户从日记页拽到别处（云端那份 lastView 是
     *   "另一台设备停在哪个页面"）。这是刻意不走 hook 的唯一例外 ——
     *   想把它也塞进 hook 之前，先想清楚"别抢用户正在看的页面"这条怎么保。
     */
    expect(owners).toEqual(['App.tsx', 'hooks/useHydrateFrom.ts', 'store/reducer.ts']);
  });

  it('App.tsx 那个例外仍然保留当前视图（自动同步不许拽走用户）', () => {
    const app = read('App.tsx');
    expect(app).toContain('lastView: viewRef.current');
  });

  it('拆出的两个设置子块都只调 useHydrateFrom()，不自己构造', () => {
    /**
     * 设置页按「外观 / 数据 / 云 / 关于」切开之后，调用点分散在两个子块里：
     * **云**（云端拉取 / 合并 / 历史回滚）在 `CloudSection`，
     * **数据**（导入备份 / 本地备份恢复）在 `DataSection`。
     * 所以这里把两处**合起来**查：各自都必须用 hook，且加起来要有足够多的调用点 ——
     * 少一处就等于某条恢复路径绕过了唯一出口。
     */
    const data = read('components/settings/DataSection.tsx');
    const cloud = read('components/settings/CloudSection.tsx');
    for (const [name, src] of [
      ['DataSection', data],
      ['CloudSection', cloud],
    ] as const) {
      expect(src, `${name} 没走 useHydrateFrom`).toContain('useHydrateFrom()');
      expect(src, `${name} 自己构造了 HYDRATE`).not.toContain('hydrateFromPayload');
      expect(src.split('const hydrateFrom = useCallback').length - 1).toBe(0);
    }
    /**
     * 外壳（`SettingsView`）自身**不许再碰 hydrateFrom** ——
     * 它只是把两块拼起来。若哪天它又长出一次装回状态的代码，
     * 说明有人绕过了子块，直接把恢复逻辑粘回了外壳。
     */
    const settings = read('views/SettingsView.tsx');
    expect(settings, '设置页外壳又自己装回状态了').not.toContain('hydrateFrom(');
    expect(settings).not.toContain('useHydrateFrom');

    expect(data.split('hydrateFrom(').length - 1).toBeGreaterThan(1);
    expect(cloud.split('hydrateFrom(').length - 1).toBeGreaterThan(1);
    // 合起来仍是四条路径：云端拉取 / 合并 / 历史回滚 / 导入 + 本地备份恢复
    expect(data.split('hydrateFrom(').length + cloud.split('hydrateFrom(').length - 2)
      .toBeGreaterThan(3);
  });
});

/* ============================================================================
   补充：F4 的桌面桥只暴露 4 个方法（IPC 面越小越好）
   ============================================================================ */
describe('F4 preload 只暴露受限的备份桥', () => {
  const preload = fs.readFileSync(path.join(SRC, '..', 'electron', 'preload.cjs'), 'utf8');

  it('window.desktopBackup 只有 write / list / read / openDir', () => {
    const block = preload.slice(preload.indexOf("exposeInMainWorld('desktopBackup'"));
    const methods = [...block.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
    expect(methods.slice(0, 4).sort()).toEqual(['list', 'openDir', 'read', 'write']);
  });

  it('不把 ipcRenderer 整个暴露给页面', () => {
    expect(preload.includes('exposeInMainWorld') ).toBe(true);
    expect(/exposeInMainWorld\(\s*['"]ipcRenderer/.test(preload)).toBe(false);
  });
});

/* ============================================================================
   兜底：F2 的接线没有把别的视图/动作带坏（TaskRow ▷ 只在需要时出现）
   ============================================================================ */
describe('F2 任务行 ▷ 的渲染条件', () => {
  const row = read('components/task/TaskRow.tsx');
  const list = read('components/task/TaskList.tsx');

  it('TaskRow 只在 focusable（有 onStartFocus 且非子任务/未完成/非紧凑）时渲染 ▷', () => {
    expect(row.includes('onStartFocus')).toBe(true);
    expect(row.includes('const focusable = Boolean(onStartFocus)')).toBe(true);
    // 文案走常量（组件里不写死中文），源码里出现的是标识符
    expect(row.includes('TEXT.startFocus')).toBe(true);
  });

  it('TaskList 用 useCallback 稳住 handler（TaskRow 是 memo，否则整列表重渲染）', () => {
    expect(list.includes('useCallback')).toBe(true);
    expect(list.includes('onStartFocus')).toBe(true);
  });
});
