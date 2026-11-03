/**
 * 长期迭代三件的**联动**验证（真实 Chromium，真的点，真的读回 localStorage）。
 *
 * 为什么不能只靠单测：
 * 三个功能的链路都是「UI → dispatch → reducer → 另一个 hook → 再 dispatch」，
 * 中间任何一环没接上，单测各自都是绿的：
 * - 开关点了 dispatch，但 reducer 判"没变"→ 状态不动（`sameHabits` 就漏过 autoTask）；
 * - 状态变了，但生成的 hook 没挂 / 依赖数组漏了 → 任务永远不出现；
 * - 任务出现了，但每次都重新生成 → 一天两条，删一条还长回来。
 * 只有把整条链真的跑一遍才看得见。
 *
 * 五个流程：
 * ① 设置页打开「每天生成任务」→ 今日页当场出现同名任务（不刷新）
 * ② 刷新之后不重复生成（流水挡住了）
 * ③ 抽屉点「智能拆解」→ 子任务真的出现，且回话里报的条数与实际一致
 * ④ 日记页关掉「自动生成」→ 刷新后仍是关（设置真的落盘）
 * ⑤ 上一周有数据 + 开关开 → 首次打开自动把周报写进那一周最后一天
 *
 * 用法：node scripts/verify_longterm_flows.mjs
 * 退出码：任何一条流程不成立 = 1。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, startServer, waitFor, waitForApp } from './lib/browser.mjs';
import { assertFresh } from './lib/freshness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist-single');

const KEY = 'dt:app:v1';

function seedPayload({ withLastWeek } = { withLastWeek: true }) {
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const day = (delta) => {
    const d = new Date(now.getTime() + delta * 86400000);
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const iso = (delta, hour) => {
    const d = new Date(now.getTime() + delta * 86400000);
    d.setHours(hour, 0, 0, 0);
    return d.toISOString();
  };
  const today = day(0);

  const focusSessions = withLastWeek
    ? [-3, -5].map((delta, index) => {
        const started = new Date(now.getTime() + delta * 86400000);
        started.setHours(9, 0, 0, 0);
        return {
          id: `f${index}`,
          taskId: null,
          date: day(delta),
          startedAt: started.toISOString(),
          endedAt: new Date(started.getTime() + 50 * 60000).toISOString(),
          durationMs: 50 * 60000,
          category: '学习',
        };
      })
    : [];

  return {
    schemaVersion: 5,
    savedAt: new Date().toISOString(),
    tasks: [
      {
        id: 't-split',
        title: '复习高数第七章：①看定义 ②做例题 ③刷课后题',
        note: '',
        date: today,
        endDate: null,
        time: '09:00',
        repeat: 'none',
        priority: 'high',
        category: '学习',
        done: false,
        doneAt: null,
        createdAt: iso(0, 8),
        updatedAt: iso(0, 8),
        parentId: null,
        estimatedMinutes: 90,
        order: 0,
      },
    ],
    settings: {
      lastView: 'settings',
      lastSelectedDate: today,
      categories: [{ id: 'c1', name: '学习' }],
      // 一个习惯，autoTask 关着 —— 流程 ① 会把它打开
      habits: [{ id: 'h1', name: '背单词', createdAt: iso(-10, 8), archivedAt: null }],
      habitChecks: [],
      habitTaskLog: [],
      weeklyAutoReport: true,
      weeklyReportLog: [],
      lastRecapSeen: today,
      dailyFocusGoalMinutes: 120,
    },
    diary: [],
    tombstones: [],
    focusSessions,
    notes: [],
  };
}


/**
 * 上一周的两个日期（周一为一周起点，与默认 weekStart=1 一致）。
 *
 * ⚠️ 不能写死 "-3 天 / -5 天"：今天是周几会决定它们落在本周还是上一周。
 * 第一次就栽在这里 —— 周六跑的时候 -3/-5 全在本周，"上一周"是空的，
 * 于是自动周报被判成空周跳过，看起来像功能没生效。
 */
function previousWeekDates() {
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const key = (d) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const sinceMonday = (now.getDay() + 6) % 7; // 周一 = 0
  const thisMonday = new Date(now.getTime() - sinceMonday * 86400000);
  const lastMonday = new Date(thisMonday.getTime() - 7 * 86400000);
  return {
    lastMonday: key(lastMonday),
    a: key(new Date(lastMonday.getTime() + 2 * 86400000)),
    b: key(new Date(lastMonday.getTime() + 4 * 86400000)),
  };
}

let pass = 0;
let fail = 0;
function ok(name, detail = '') {
  pass += 1;
  console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`);
}
function bad(name, detail = '') {
  fail += 1;
  console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`);
}

async function main() {
  if (!existsSync(path.join(DIST, 'index.html'))) {
    throw new Error(`没有 ${DIST}/index.html —— 先跑 npm run desktop:build`);
  }
  // 拿旧包跑出来的绿是假的：源码比产物新就直接失败
  assertFresh(ROOT, 'dist-single/index.html', 'npm run desktop:build');
  const { server, port } = await startServer(DIST);
  const { cdp, close } = await launch({ tag: 'verify-longterm' });
  const url = `http://127.0.0.1:${port}/index.html`;

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 780,
    deviceScaleFactor: 1,
    mobile: true,
  });

  const evalIn = (expr) => cdp.evaluate(expr);
  const readState = () => evalIn(`(() => JSON.parse(localStorage.getItem(${JSON.stringify(KEY)}) || 'null'))()`);
  const click = async (selector) => {
    const hit = await evalIn(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`,
    );
    await new Promise((r) => setTimeout(r, 350));
    return hit;
  };
  const clickText = async (text) => {
    const hit = await evalIn(
      `(() => {
         const el = [...document.querySelectorAll('button, a')].find((b) => (b.textContent || '').trim() === ${JSON.stringify(text)});
         if (!el) return false; el.click(); return true;
       })()`,
    );
    await new Promise((r) => setTimeout(r, 400));
    return hit;
  };
  const reload = async () => {
    await cdp.send('Page.navigate', { url });
    await waitForApp(cdp);
    await new Promise((r) => setTimeout(r, 400));
  };

  await cdp.send('Page.navigate', { url });
  await waitForApp(cdp);
  await evalIn(`(() => { localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(JSON.stringify(seedPayload({ withLastWeek: true })))}); return 1; })()`);

  // ─────────────────────────────────────────────────────────────
  console.log('\n① 设置页打开「每天生成任务」→ 今日页当场出现任务');
  await reload();
  // 落盘里 lastView=settings，但保存可能被节流；直接点导航更稳
  await clickText('设置');
  /**
   * ⚠️ 设置页从 v0.29.5 起分组了（默认只展开「外观」与「数据」），
   * 习惯编辑器在收起的分组里 —— 不先点开分组标题，下面全是 undefined。
   * 这是脚本在模拟真人的操作顺序，不是迁就实现：折叠面板本来就要先展开。
   */
  await evalIn(`(() => {
    const t = document.querySelector('[data-testid="settings-group-habits-toggle"]');
    if (t && t.getAttribute('aria-expanded') === 'false') t.click();
    return 1;
  })()`);
  await new Promise((r) => setTimeout(r, 260));
  const toggleBefore = await evalIn(
    `(() => document.querySelector('[data-testid="habit-auto-task"]')?.getAttribute('aria-pressed'))()`,
  );
  if (toggleBefore === 'false') ok('初始是关的');
  else bad('初始状态不对', `aria-pressed=${toggleBefore}`);

  await click('[data-testid="habit-auto-task"]');
  const toggleAfter = await evalIn(
    `(() => document.querySelector('[data-testid="habit-auto-task"]')?.getAttribute('aria-pressed'))()`,
  );
  if (toggleAfter === 'true') ok('点击后按钮变开（sameHabits 没把它吞掉）');
  else bad('按钮没变开 —— reducer 又把 SET_HABITS 判成「没变化」了');

  await clickText('今日');
  const hasTask = await evalIn(
    `(() => [...document.querySelectorAll('[data-task-id]')].some((el) => (el.textContent || '').includes('背单词')))()`,
  );
  if (hasTask) ok('今日页出现「背单词」任务（hook → action → 任务真的落库了）');
  else bad('今日页没有出现习惯生成的任务');

  // ─────────────────────────────────────────────────────────────
  console.log('\n② 刷新后不重复生成');
  await reload();
  let state = await readState();
  const autoTasks = (state?.tasks || []).filter((t) => t.title === '背单词');
  if (autoTasks.length === 1) ok('仍然只有一条（流水挡住了重复派发）');
  else bad('任务条数不对', `期望 1，实际 ${autoTasks.length}`);

  // ─────────────────────────────────────────────────────────────
  console.log('\n③ 抽屉「智能拆解」→ 子任务出现且条数一致');
  await clickText('今日');
  await click('[data-task-id]');
  const drawerOpen = await evalIn(`(() => !!document.querySelector('[data-testid="subtask-breakdown"]'))()`);
  if (!drawerOpen) {
    bad('抽屉里没有拆解按钮');
  } else {
    await click('[data-testid="subtask-breakdown"]');
    await new Promise((r) => setTimeout(r, 500));
    state = await readState();
    const children = (state?.tasks || []).filter((t) => t.parentId === 't-split');
    const note = await evalIn(
      `(() => {
         const btn = document.querySelector('[data-testid="subtask-breakdown"]');
         return btn ? (btn.parentElement?.textContent || '') : '';
       })()`,
    );
    if (children.length >= 3) ok('子任务真的挂到了父任务下', `${children.length} 条`);
    else bad('没生成子任务', `${children.length} 条`);

    const claimed = Number((note.match(/加了 (\d+) 条/) || [])[1] ?? -1);
    if (claimed === children.length) ok('回话里的条数与实际一致', `「加了 ${claimed} 条」`);
    else bad('回话条数与实际不符', `回话说 ${claimed}，实际 ${children.length}`);

    const listHasChild = await evalIn(
      `(() => [...document.querySelectorAll('*')].some((el) => el.children.length === 0 && (el.textContent || '').trim() === '看定义'))()`,
    );
    if (listHasChild) ok('抽屉里即时显示出拆解出的步骤');
    else bad('步骤没出现在抽屉里');
  }

  // ─────────────────────────────────────────────────────────────
  console.log('\n④ 日记页关掉「自动生成」→ 刷新后仍是关');
  await clickText('日记');
  await click('[data-testid="weekly-toggle"]');
  const autoBefore = await evalIn(
    `(() => document.querySelector('[data-testid="weekly-auto"]')?.getAttribute('aria-pressed'))()`,
  );
  if (autoBefore === 'true') ok('默认是开');
  else bad('自动生成不是默认开', `aria-pressed=${autoBefore}`);

  await click('[data-testid="weekly-auto"]');
  await new Promise((r) => setTimeout(r, 500));
  await reload();
  state = await readState();
  if (state?.settings?.weeklyAutoReport === false) ok('刷新后仍是关（真的落盘了）');
  else bad('开关没落盘', `weeklyAutoReport=${state?.settings?.weeklyAutoReport}`);

  // ─────────────────────────────────────────────────────────────
  console.log('\n⑤ 上一周有数据 + 开关开 → 自动写周报进那一周最后一天');
  const prev = previousWeekDates();
  await evalIn(
    `(() => {
       const obj = JSON.parse(localStorage.getItem(${JSON.stringify(KEY)}));
       obj.settings.weeklyAutoReport = true;
       obj.settings.weekStart = 1;
       obj.settings.weeklyReportLog = [];
       obj.diary = [];
       // 把两条专注记录挪到**上一周**（不是本周）
       obj.focusSessions = ${JSON.stringify([prev.a, prev.b])}.map((date, i) => ({
         id: 'f' + i,
         taskId: null,
         date,
         startedAt: date + 'T09:00:00',
         endedAt: date + 'T09:50:00',
         durationMs: 50 * 60000,
         category: '学习',
       }));
       localStorage.setItem(${JSON.stringify(KEY)}, JSON.stringify(obj));
       return 1;
     })()`,
  );
  await reload();
  await waitFor(async () => {
    const s = await readState();
    return Boolean(s?.diary?.some((d) => (d.content || '').includes('## 本周回顾')));
  }, 8000).catch(() => {});
  state = await readState();
  const weekly = (state?.diary || []).find((d) => (d.content || '').includes('## 本周回顾'));
  if (weekly) ok('周报自动写进了日记', `日期 ${weekly.date}（上一周 ${prev.a}~${prev.b}）`);
  else bad('周报没写进日记');

  if (weekly && state?.settings?.weeklyReportLog?.length === 1) {
    ok('同时记了流水（下次不会再写一遍）', state.settings.weeklyReportLog[0]);
  } else if (weekly) {
    bad('没记流水 —— 每次打开都会重写一遍');
  }

  close();
  server.close();

  console.log(`\n长期迭代联动验证：${pass} 通过 / ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('验证失败：', error?.message ?? error);
  process.exit(2);
});
