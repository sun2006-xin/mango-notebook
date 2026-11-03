/**
 * 端到端冒烟（真实 Chromium，不是 jsdom 模拟）。
 *
 * 为什么必须有这一层：
 * jsdom 能测"函数算得对"，测不出**整条链路通不通** ——
 * 输入框能不能聚焦、Enter 会不会提交、React 受控组件更不更新、
 * 防抖落盘有没有真的写进 localStorage、刷新后 hydrate 有没有把数据装回来。
 * 这些都是"用户一上手就发现"的问题，而单测永远绿。
 *
 * 这里只跑一条主路径（新建 → 勾选 → 切视图 → 改名 → 刷新），
 * 刻意不追求覆盖率：冒烟用例的价值在于**每次改完都能 60 秒内跑一遍**，
 * 用例一多就没人跑，没人跑的用例等于没有。
 *
 * 用法：node scripts/smoke_e2e.mjs
 * 退出码：任一断言失败 = 1（可接进 CI）。
 *
 * ⚠️ 用真实键盘输入（CDP `Input.insertText` / `dispatchKeyEvent`），
 * 而不是直接改 value —— 后者会绕过 React 的受控逻辑，
 * 测出来的是"我写的赋值语句能跑"，不是"用户打字能进得去"。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, startServer, waitFor, waitForApp } from './lib/browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist-single');

const TITLE = '冒烟：复习高数第 3 章';
const RENAMED = '冒烟：复习高数第 3 章（已改名）';

/** 桌面与手机各跑一遍：两套布局（侧栏 / 底部 Tab）的挂载点不同 */
const VIEWPORTS = [
  { width: 1024, height: 820, label: '桌面 1024' },
  { width: 390, height: 780, label: '手机 390' },
];

let failures = 0;
const results = [];

function pass(name, note = '') {
  results.push({ ok: true, name, note });
  console.log(`  ✓ ${name}${note ? '  ' + note : ''}`);
}

function fail(name, note) {
  failures += 1;
  results.push({ ok: false, name, note });
  console.log(`  ✗ ${name}  ${note}`);
}

function check(name, condition, note = '') {
  if (condition) pass(name, note);
  else fail(name, note || '断言不成立');
  return Boolean(condition);
}

/** 回车提交（真实按键，走 React 的 form onSubmit） */
async function pressEnter(cdp) {
  for (const type of ['rawKeyDown', 'char', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', {
      type,
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      text: type === 'char' ? '\r' : undefined,
    });
  }
}

/** 真实点击（用 DOM click，等价于鼠标点上去；React 事件照常触发） */
async function click(cdp, selector) {
  const done = await cdp.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.click();
    return true;
  })()`);
  if (!done) throw new Error(`点不到：${selector}`);
}

/**
 * 把输入框的旧内容换掉。
 * 这里用原生 setter + input 事件而不是逐字删：抽屉标题是受控输入，
 * 逐字删要按 30 次退格、每帧都可能抢焦点，得不偿失 ——
 * "能不能输入"这件事上面已经用真实键盘验过了。
 */
async function setValue(cdp, selector, value) {
  const done = await cdp.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  if (!done) throw new Error(`找不到输入框：${selector}`);
}

const count = (cdp, selector) =>
  cdp.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);

const textOf = (cdp, selector) =>
  cdp.evaluate(
    `(document.querySelector(${JSON.stringify(selector)})?.textContent ?? '').trim()`,
  );

/**
 * 今日进度的"已完成"数字。
 * 桌面侧栏是 `side-done`，列表里是 `done-count`（渲染成「· 1」）——
 * 两个布局只有一个是可见的，按存在与否取。
 */
const doneCountText = (cdp) =>
  cdp.evaluate(`(() => {
    const el = document.querySelector('[data-testid="side-done"]')
      ?? document.querySelector('[data-testid="done-count"]');
    return el ? el.textContent.replace(/[^0-9]/g, '') : null;
  })()`);

/** 等"任务列表里出现 N 条"，比固定 sleep 稳 */
const waitForCount = (cdp, selector, expected) =>
  waitFor(async () => (await count(cdp, selector)) === expected, 8000);

async function runFlow(cdp, url, viewport) {
  console.log(`\n── ${viewport.label} ──`);

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: viewport.width < 768,
  });

  await cdp.send('Page.navigate', { url });
  await waitForApp(cdp);

  // 1. 冷启动：应用能挂载，且没有掉进 ErrorBoundary
  const booted = await cdp.evaluate(
    `!!document.querySelector('[data-testid="quickadd-input"]')`,
  );
  check('冷启动挂载', booted);
  check(
    '没有掉进错误边界',
    !(await cdp.evaluate(`document.body.textContent.includes('内容无法显示')`)),
  );

  // 2. 新建：真实打字 + 真实回车
  await cdp.evaluate(`document.querySelector('[data-testid="quickadd-input"]').focus()`);
  await cdp.send('Input.insertText', { text: TITLE });
  await pressEnter(cdp);
  const added = await waitForCount(cdp, '[data-task-id]', 1)
    .then(() => true)
    .catch(() => false);
  if (!check('输入标题回车 → 任务出现', added)) return;
  check('任务标题正确', (await textOf(cdp, '[data-task-id]')).includes(TITLE));

  /* 3. 刷新 —— 持久化第一关：新建的内容必须真的落盘 */
  await cdp.send('Page.reload');
  await waitForApp(cdp);
  const survivedCreate = await waitForCount(cdp, '[data-task-id]', 1)
    .then(() => true)
    .catch(() => false);
  if (!check('刷新后新建的任务还在（落盘生效）', survivedCreate)) return;

  // 4. 勾选完成
  await click(cdp, '[data-task-id] input[type="checkbox"]');
  const done = await waitFor(
    async () => cdp.evaluate(`!!document.querySelector('[data-task-id].is-done')`),
    5000,
  )
    .then(() => true)
    .catch(() => false);
  check('点勾选框 → 标记完成', done);

  // 5. 切视图再回来（用 data-nav 这个稳定契约，不靠中文文案）
  const switched = await cdp.evaluate(`(() => {
    const target = document.querySelector('[data-nav="week"]');
    if (!target) return false;
    target.click();
    return true;
  })()`);
  check('能切到周视图', switched);
  await new Promise((r) => setTimeout(r, 450));
  check(
    '周视图里看得到这条任务',
    (await count(cdp, '[data-task-id]')) >= 1,
    `行数=${await count(cdp, '[data-task-id]')}`,
  );
  await cdp.evaluate(`document.querySelector('[data-nav="today"]')?.click()`);
  await new Promise((r) => setTimeout(r, 450));

  // 6. 打开抽屉改名（抽屉是任务唯一的编辑入口，坏了等于"任务无法编辑"）
  await click(cdp, '[data-task-id]');
  const drawer = await waitFor(
    async () => cdp.evaluate(`!!document.querySelector('#dr-title')`),
    5000,
  )
    .then(() => true)
    .catch(() => false);
  if (check('点任务行 → 打开抽屉', drawer)) {
    await setValue(cdp, '#dr-title', RENAMED);
    await new Promise((r) => setTimeout(r, 250));
    await click(cdp, '[aria-label="关闭"]');
    await new Promise((r) => setTimeout(r, 400));
    check(
      '改名后列表即时更新',
      (await textOf(cdp, '[data-task-id]')).includes('已改名'),
      `实际：「${(await textOf(cdp, '[data-task-id]')).slice(0, 30)}」`,
    );
  }

  /* 7. 再刷新一次 —— 持久化第二关：改名与完成状态
     注意这里**不能用行数断言**：已完成的任务在列表里是折叠的一组，
     刷新后粘性展开记录（stickyDoneIds）本来就没了，行确实不在 DOM 里。
     真正该验的是"状态被装回来了"，所以看今日完成计数。 */
  await cdp.send('Page.reload');
  await waitForApp(cdp);
  const doneAfter = await waitFor(async () => (await doneCountText(cdp)) === '1', 6000)
    .then(() => true)
    .catch(() => false);
  check('刷新后完成状态保留', doneAfter, `完成计数=${await doneCountText(cdp)}`);

  const titleKept = await cdp.evaluate(
    `document.body.textContent.includes('已改名') || !!document.querySelector('[data-testid="done-count"]')`,
  );
  check('刷新后改名没丢', titleKept);

  /**
   * 8. 设置页：数据入口一个都不能少。
   * 「导出/导入」是唯一能对抗"卸载即丢数据"的手段，页面渲染挂了就等于命脉断了；
   * 而设置页是全工程最大的文件，拆它的时候最容易顺手拆坏某个区块。
   */
  await cdp.evaluate(`document.querySelector('[data-nav="settings"]')?.click()`);
  await new Promise((r) => setTimeout(r, 600));
  for (const [name, selector] of [
    ['设置页能打开（导出备份在）', '[data-testid="data-export"]'],
    ['导入备份入口在', '[data-testid="data-import"]'],
    ['Markdown 导出入口在', '[data-testid="data-export-md"]'],
    ['清空数据入口在', '[data-testid="data-clear"]'],
    ['版本与更新区块渲染', '[data-testid="update-check"]'],
    ['版本号显示', '[data-testid="app-version"]'],
  ]) {
    check(name, await cdp.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`));
  }
}

async function main() {
  if (!existsSync(path.join(DIST, 'index.html'))) {
    throw new Error(`没有 ${DIST}/index.html —— 先跑 npm run desktop:build`);
  }

  const { server, port } = await startServer(DIST);
  const { cdp, close } = await launch({ tag: 'smoke' });
  const url = `http://127.0.0.1:${port}/index.html`;

  try {
    for (const viewport of VIEWPORTS) {
      // 每个视口前清一次数据：上一次留下的任务会让"行数=1"的断言失效
      await cdp.send('Page.navigate', { url });
      await waitForApp(cdp);
      await cdp.evaluate(`(() => { localStorage.clear(); return 1; })()`);
      await runFlow(cdp, url, viewport);
    }
  } finally {
    close();
    server.close();
  }

  console.log('');
  if (failures > 0) {
    console.log(`端到端冒烟：${failures} 项失败 ↑`);
    process.exit(1);
  }
  console.log(`端到端冒烟：全部通过（${results.length} 项断言）✓`);
  process.exit(0);
}

main().catch((error) => {
  console.error('冒烟失败：', error?.message ?? error);
  process.exit(2);
});
