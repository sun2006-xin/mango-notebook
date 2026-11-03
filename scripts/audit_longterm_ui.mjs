/**
 * 长期迭代三块新 UI 的「能不能看见 / 点得到」实测（真实 Chromium）。
 *
 * 为什么单独一个脚本，而不是并进 audit_mobile_layout.mjs：
 * 那支脚本按"视图"巡检，而这三块都在**空数据时根本不渲染**：
 * - 设置页的习惯编辑器：一个习惯都没有时只显示一句空态文案；
 * - 日记页的自动周报开关：藏在「本周回顾」折叠面板里，默认是收起来的；
 * - 抽屉的智能拆解：要真的点开某条顶层任务才出现。
 * 所以必须灌一份"三样都开满"的数据，再**主动展开**，否则量到的是一片空气。
 *
 * 检查三件事（逐元素，不是只看 scrollWidth）：
 * ① 溢出：文档 scrollWidth > 视口宽，或元素右/左边缘越过视口；
 * ② 可见：元素有排版盒（不是 display:none / 被祖先裁剪成 0 高）；
 * ③ 可点：用 elementFromPoint 打它中心点，命中的必须是它自己或它的后代
 *    —— 这一条专治"按钮画在屏幕外 / 被别的层盖住"，光看宽高查不出来。
 *
 * 用法：node scripts/audit_longterm_ui.mjs [宽度...]
 * 退出码：任何一项不通过 = 1。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, startServer, waitFor, waitForApp } from './lib/browser.mjs';
import { assertFresh } from './lib/freshness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist-single');

const argv = process.argv.slice(2).map(Number).filter((n) => n > 0);
const WIDTHS = argv.length > 0 ? argv : [320, 360, 390, 414];
const HEIGHT = 780;

function seedPayload() {
  const now = new Date();
  const day = (delta) => {
    const d = new Date(now.getTime() + delta * 86400000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const iso = (delta, hour) => {
    const d = new Date(now.getTime() + delta * 86400000);
    d.setHours(hour, 0, 0, 0);
    return d.toISOString();
  };
  const today = day(0);

  const mk = (over) => ({
    id: crypto.randomUUID(),
    title: '',
    note: '',
    date: today,
    endDate: null,
    time: null,
    repeat: 'none',
    priority: 'medium',
    category: '学习',
    done: false,
    doneAt: null,
    createdAt: iso(0, 8),
    updatedAt: iso(0, 8),
    parentId: null,
    estimatedMinutes: 30,
    order: 0,
    ...over,
  });

  // 8 个习惯、名字有长有短、全部开「每天生成任务」（最坏情况：每行都带一条长文案）
  const habitNames = [
    '背单词',
    '跑步',
    '早睡',
    '不刷短视频',
    '写日记',
    '喝水',
    '拉伸',
    '把每天的高数错题按章节整理一遍',
  ];
  const habits = habitNames.map((name, i) => ({
    id: `h${i}`,
    name,
    createdAt: iso(-30, 8),
    archivedAt: null,
    autoTask: true,
  }));

  const tasks = [
    // 用来点开抽屉的那条：标题带分点，拆解会走 explicit 分支
    mk({
      title: '复习高数第七章 ①看定义 ②做例题 ③刷课后题 ④标出错题',
      estimatedMinutes: 120,
      time: '09:00',
      priority: 'high',
    }),
    mk({ title: '把《高等数学 第七章》的课后习题从第 12 题做到第 30 题' }),
    mk({ title: 'STM32 软件 I2C 写 MPU6050（江协科技 P14）', category: 'STM32嵌入式开发' }),
    mk({ title: '背单词', note: 'Unit 7' }),
  ];

  // 上一周要有数据，否则自动周报判定为空周、日记里根本不会出现那个区块
  const focusSessions = [0, 1, 2, 3].map((i) => {
    const started = new Date(now.getTime() - (i + 2) * 86400000);
    started.setHours(9 + i, 0, 0, 0);
    return {
      id: crypto.randomUUID(),
      taskId: null,
      date: day(-(i + 2)),
      startedAt: started.toISOString(),
      endedAt: new Date(started.getTime() + 50 * 60000).toISOString(),
      durationMs: 50 * 60000,
      category: '学习',
    };
  });

  return {
    schemaVersion: 5,
    savedAt: new Date().toISOString(),
    tasks,
    settings: {
      lastView: 'settings',
      lastSelectedDate: today,
      categories: [
        { id: 'c1', name: '学习' },
        { id: 'c2', name: 'STM32嵌入式开发' },
        { id: 'c3', name: '这是一个特别长的分类名称用来撑爆筛选条' },
      ],
      habits,
      habitChecks: [],
      habitTaskLog: [],
      weeklyAutoReport: true,
      weeklyReportLog: [],
      lastRecapSeen: today,
      dailyFocusGoalMinutes: 240,
    },
    diary: [],
    tombstones: [],
    focusSessions,
    notes: [],
  };
}

/** 量：溢出 + 每个关注元素是否"方方正正地在屏幕里且点得到" */
const MEASURE = (selectors) => `(() => {
  const vw = document.documentElement.clientWidth;
  const sx = window.scrollX || 0;
  const bad = [];
  const pathOf = (el) => {
    const parts = [];
    let node = el;
    for (let i = 0; i < 4 && node && node.nodeType === 1; i += 1) {
      let s = node.tagName.toLowerCase();
      const tid = node.getAttribute && node.getAttribute('data-testid');
      if (tid) s += '[data-testid=' + tid + ']';
      else {
        const cls = (node.getAttribute('class') || '').trim().split(/\\s+/).slice(0, 3).join('.');
        if (cls) s += '.' + cls;
      }
      parts.unshift(s);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };
  const inScroller = (el) => {
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const s = getComputedStyle(n).overflowX;
      if (s === 'auto' || s === 'scroll' || s === 'hidden' || s === 'clip') return true;
    }
    return false;
  };

  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed') continue;
    if (inScroller(el)) continue;
    const left = r.left + sx;
    const right = r.right + sx;
    const over = Math.round(Math.max(right - vw, -left));
    if (over > 1) {
      bad.push({ sel: pathOf(el), over, w: Math.round(r.width), text: (el.textContent || '').trim().slice(0, 40) });
    }
  }

  const targets = [];
  for (const spec of ${JSON.stringify(selectors)}) {
    const sel = typeof spec === 'string' ? spec : spec.sel;
    /** 'control' 必须整块在视口内；'block' 只要存在且有排版盒（长列表本来就比屏幕高） */
    const kind = typeof spec === 'string' ? 'control' : (spec.kind || 'control');
    const el = document.querySelector(sel);
    if (!el) {
      targets.push({ sel, state: 'missing' });
      continue;
    }
    /**
     * ⚠️ 必须先把它滚到自己可见，再测"点不点得到"。
     * 不滚的话，抽屉 / 折叠面板里的控件大多在滚动区下方，
     * elementFromPoint 会命中屏幕外的空白 —— 那是**测量方法的假阳性**，
     * 会被误报成"按钮显示不出来"。（这一条自己踩过一次。）
     * 滚完仍然看不见，才是真的看不见。
     */
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const visible = r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    const fits =
      r.top >= -1 && r.bottom <= window.innerHeight + 1 && r.left >= -1 && r.right <= vw + 1;
    const inViewport = kind === 'block' ? true : fits;
    let hit = false;
    if (visible && inViewport) {
      const found = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      hit = Boolean(found && (el === found || el.contains(found) || found.contains(el)));
    }
    targets.push({
      sel,
      state: !visible ? 'invisible' : !inViewport ? 'out-of-viewport' : kind === 'block' ? 'ok' : hit ? 'ok' : 'covered',
      kind,
      w: Math.round(r.width),
      left: Math.round(r.left + sx),
      right: Math.round(r.right + sx),
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      text: (el.textContent || '').trim().slice(0, 30),
    });
  }

  return {
    vw,
    scrollW: document.documentElement.scrollWidth,
    overflow: document.documentElement.scrollWidth > vw + 1,
    count: bad.length,
    worst: bad.sort((a, b) => b.over - a.over).slice(0, 6),
    targets,
  };
})()`;

async function main() {
  if (!existsSync(path.join(DIST, 'index.html'))) {
    throw new Error(`没有 ${DIST}/index.html —— 先跑 npm run desktop:build`);
  }
  // 拿旧包跑出来的绿是假的：源码比产物新就直接失败
  assertFresh(ROOT, 'dist-single/index.html', 'npm run desktop:build');

  const { server, port } = await startServer(DIST);
  const { cdp, close } = await launch({ tag: 'audit-longterm' });
  const url = `http://127.0.0.1:${port}/index.html`;
  const seed = JSON.stringify(seedPayload());

  await cdp.send('Page.navigate', { url });
  await waitForApp(cdp);
  await cdp.evaluate(`(() => { localStorage.setItem('dt:app:v1', ${JSON.stringify(seed)}); return 1; })()`);

  let failures = 0;
  const report = [];

  const reload = async (view) => {
    await cdp.evaluate(
      `(() => {
         const obj = JSON.parse(localStorage.getItem('dt:app:v1'));
         obj.settings.lastView = ${JSON.stringify(view)};
         localStorage.setItem('dt:app:v1', JSON.stringify(obj));
         return 1;
       })()`,
    );
    await cdp.send('Page.navigate', { url });
    await waitForApp(cdp);
    await new Promise((r) => setTimeout(r, 400));
  };

  const click = async (selector) => {
    const ok = await cdp.evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`,
    );
    await new Promise((r) => setTimeout(r, 400));
    return ok;
  };

  const check = async (width, label, selectors) => {
    const result = await cdp.evaluate(MEASURE(selectors));
    const brokenTargets = result.targets.filter((t) => t.state !== 'ok');
    const bad = result.overflow || result.count > 0 || brokenTargets.length > 0;
    if (bad) failures += 1;
    report.push({ width, label, ...result, brokenTargets });
    console.log(
      `${bad ? '✗' : '✓'} ${String(width).padStart(4)}px  ${label.padEnd(28)} scrollW=${result.scrollW} vw=${result.vw} 越界=${result.count} 控件=${result.targets.map((t) => t.state).join(',')}`,
    );
    for (const item of result.worst) {
      console.log(`      +${item.over}px  w=${item.w}  ${item.sel}`);
      if (item.text) console.log(`         «${item.text}»`);
    }
    for (const t of brokenTargets) {
      console.log(`      ! ${t.state}  ${t.sel}  [${t.left},${t.right}] w=${t.w} «${t.text}»`);
    }
  };

  for (const width of WIDTHS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height: HEIGHT,
      deviceScaleFactor: 1,
      mobile: width < 768,
    });

    /**
     * ① 设置页：习惯编辑器的「每天生成任务」开关（8 个习惯全开）。
     *
     * ⚠️ 设置页从 v0.29.5 起是**分组的**（默认只展开「外观」与「数据」），
     * 习惯编辑器在收起的分组里 —— 不先点开，这里量到的永远是 null。
     * 这不是脚本在迁就实现：收起状态本来就没有这块布局可量，
     * 要量它就得把它展开，和真人操作一致。
     */
    await reload('settings');
    await cdp.evaluate(`(() => {
      const toggle = document.querySelector('[data-testid="settings-group-habits-toggle"]');
      if (toggle && toggle.getAttribute('aria-expanded') === 'false') toggle.click();
      return 1;
    })()`);
    await new Promise((r) => setTimeout(r, 260));
    await cdp.evaluate(`(() => {
      const el = document.querySelector('[data-testid="habits-editor"]');
      if (el) el.scrollIntoView({ block: 'start' });
      return 1;
    })()`);
    await new Promise((r) => setTimeout(r, 300));
    await check(width, '设置 · 习惯编辑器', [
      { sel: '[data-testid="habits-editor"]', kind: 'block' },
      '[data-testid="habit-auto-task"]',
    ]);

    // ② 日记页：展开「本周回顾」，看自动周报开关
    await reload('diary');
    const opened = await click('[data-testid="weekly-toggle"]');
    if (!opened) console.log(`      (${width}px 没找到 weekly-toggle)`);
    await cdp.evaluate(`(() => {
      const el = document.querySelector('[data-testid="weekly-auto"]');
      if (el) el.scrollIntoView({ block: 'center' });
      return 1;
    })()`);
    await new Promise((r) => setTimeout(r, 300));
    await check(width, '日记 · 本周回顾(展开)', [
      '[data-testid="weekly-auto"]',
      '[data-testid="weekly-write"]',
      '[data-testid="weekly-this"]',
    ]);

    // ③ 今日页：打开任务抽屉 → 点「智能拆解」→ 看结果文案有没有撑破
    await reload('today');
    const drawer = await click('[data-task-id]');
    if (!drawer) console.log(`      (${width}px 没找到任务行)`);
    await check(width, '抽屉 · 子任务区', ['[data-testid="subtask-breakdown"]']);
    await click('[data-testid="subtask-breakdown"]');
    await cdp.evaluate(`(() => {
      const el = document.querySelector('[data-testid="subtask-breakdown"]');
      if (el) el.scrollIntoView({ block: 'center' });
      return 1;
    })()`);
    await new Promise((r) => setTimeout(r, 300));
    await check(width, '抽屉 · 拆解后(带回话)', ['[data-testid="subtask-breakdown"]']);
  }

  close();
  server.close();

  console.log('');
  if (failures > 0) {
    console.log(`长期迭代 UI 审计：${failures} 个「视口 × 场景」不合格 ↑`);
    process.exit(1);
  }
  console.log('长期迭代 UI 审计：全部视口 × 场景均合格（无越界、控件可见可点）✓');
  process.exit(0);
}

main().catch((error) => {
  console.error('审计失败：', error?.message ?? error);
  process.exit(2);
});
