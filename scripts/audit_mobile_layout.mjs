/**
 * 移动端布局溢出审计（真实 Chromium 实测，不是静态猜）。
 *
 * 为什么要有这个脚本：
 * 「手机上有些界面超出界限」这类问题，源码扫类名扫不出来 —— Tailwind 的
 * `min-w-0 / truncate / flex-wrap` 是否真的生效，只有真实排版引擎说了算。
 * 而 jsdom 没有排版引擎（`getBoundingClientRect` 恒为 0），单测也测不到。
 *
 * 做法：起一个静态服务器托管 `dist-single/index.html`，开无头 Chromium，
 * 用 CDP 把视口设成各档手机宽度，灌入一份"什么都有"的样例数据，
 * 然后逐个视图量 `scrollWidth > clientWidth` 与"越界元素清单"。
 *
 * 用法：
 *   node scripts/audit_mobile_layout.mjs            # 默认 320/360/390/414/768
 *   node scripts/audit_mobile_layout.mjs 360 414     # 只测指定宽度
 *
 * 退出码：发现越界 = 1（可接进 CI）。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, startServer, waitFor, waitForApp } from './lib/browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist-single');

const VIEWPORTS = process.argv.slice(2).map(Number).filter((n) => n > 0);
const WIDTHS = VIEWPORTS.length > 0 ? VIEWPORTS : [320, 360, 390, 414, 768];
const HEIGHT = 780;

/** 参与审计的视图（review 不在导航里，是临时会话，单独手动验） */
const VIEWS = ['today', 'week', 'calendar', 'focus', 'diary', 'notes', 'settings', 'trash'];

/**
 * 覆盖层场景：光测视图不够 —— 抽屉 / 搜索浮层是盖在视图上的，
 * 它们自己也是溢出高发区（底部弹层、长标题、结果列表）。
 */
const OVERLAYS = [
  { view: 'today', open: () => document.querySelector('[data-task-id]')?.click(), name: '任务抽屉' },
  {
    view: 'today',
    open: () => document.querySelector('[data-testid="nav-search-mobile"]')?.click(),
    name: '搜索浮层',
  },
  /** 计时器三个模式的面板长得完全不同（秒表 / 提醒各自一排胶囊），都要量 */
  {
    view: 'focus',
    open: () =>
      [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '秒表')?.click(),
    name: '秒表面板',
  },
  {
    view: 'focus',
    open: () =>
      [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '提醒')?.click(),
    name: '提醒面板',
  },
];

/**
 * 样例数据：刻意把"最容易撑破布局"的东西全塞进去。
 * 超长标题、超长分类名、多天任务、长备注、8 个习惯、长日记、带复习的记事……
 * 真实用户不会一次全占，但每一种都单独出现过。
 */
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

  const longTitle = '把《高等数学 第七章 多元函数微分法及其应用》的课后习题从第 12 题做到第 30 题';
  const p1 = crypto.randomUUID();
  const p2 = crypto.randomUUID();

  // 病态长文本：没有任何断点的超长串，`truncate` / `break-all` 漏一个就撑破
  const unbroken = 'A'.repeat(160);
  const longUrl = 'https://example.com/a/very/long/path/that/never/breaks/anywhere/at/all/really';

  const tasks = [
    mk({ title: longTitle, time: '09:00', priority: 'high', estimatedMinutes: 120 }),
    mk({ title: unbroken }),
    mk({ title: longUrl, note: longUrl, category: 'STM32嵌入式开发' }),
    mk({ title: 'STM32 软件 I2C 写 MPU6050（江协科技 P14）', time: '14:00', category: 'STM32嵌入式开发' }),
    mk({ title: '背单词', note: 'Unit 7 的 50 个', repeat: 'daily' }),
    mk({ title: '跑五公里', category: '运动健康' }),
    mk({ title: short('这是一个用来测试多天任务的标题'), date: day(-2), endDate: day(3) }),
    mk({ title: '已经做完的一件事', done: true, doneAt: iso(0, 10) }),
    mk({ title: '昨天没做完的逾期任务', date: day(-1), time: '20:00' }),
    mk({ title: '上周遗留的逾期任务', date: day(-6), priority: 'high' }),
    mk({ id: p1, title: '父任务：YOLOv5 从零训练一遍', estimatedMinutes: 240 }),
    mk({ title: '子任务一：准备数据集', parentId: p1 }),
    mk({ title: '子任务二：改 yaml', parentId: p1, done: true, doneAt: iso(0, 9) }),
    mk({ id: p2, title: '父任务：PyQt5 做一个窗口', estimatedMinutes: 90 }),
    mk({ title: '子任务：信号与槽', parentId: p2 }),
    mk({ title: '明天的安排', date: day(1), time: '08:30' }),
    mk({ title: '后天要做的事', date: day(2) }),
  ];

  function short(s) {
    return s;
  }

  const habits = ['背单词', '跑步', '早睡', '不刷短视频', '写日记', '喝水', '拉伸', '复盘'].map(
    (name) => ({ id: crypto.randomUUID(), name, createdAt: iso(-30, 8), archivedAt: null }),
  );
  const habitChecks = [];
  for (let i = 0; i < 40; i += 1) {
    for (const habit of habits.slice(0, 5)) {
      if ((i + habit.name.length) % 4 !== 0) {
        habitChecks.push({ habitId: habit.id, date: day(-i) });
      }
    }
  }

  const focusSessions = [];
  for (let i = 0; i < 40; i += 1) {
    const n = 1 + (i % 3);
    for (let k = 0; k < n; k += 1) {
      const started = new Date(now.getTime() - i * 86400000);
      started.setHours(9 + k * 2, 0, 0, 0);
      const ended = new Date(started.getTime() + 25 * 60000);
      focusSessions.push({
        id: crypto.randomUUID(),
        taskId: i % 2 === 0 ? tasks[0].id : null,
        date: day(-i),
        startedAt: started.toISOString(),
        endedAt: ended.toISOString(),
        durationMs: 25 * 60000,
        category: i % 2 === 0 ? '学习' : null,
      });
    }
  }

  const diary = [
    {
      date: day(-1),
      content:
        '# 昨天\n\n今天把多元函数的偏导数过了一遍。\n\n```c\nuint8_t MPU6050_ReadByte(uint8_t addr) { /* 软件 I2C */ }\n```\n\n- 完成了 STM32 P14\n- ' +
        '一段很长很长的日记正文'.repeat(6),
      createdAt: iso(-1, 22),
      updatedAt: iso(-1, 23),
    },
    {
      date: today,
      content: '今天先做高数。\n\n> 引用一下自己的话\n\n普通段落。',
      createdAt: iso(0, 8),
      updatedAt: iso(0, 8),
    },
  ];

  const notes = [
    {
      id: crypto.randomUUID(),
      title: '一个标题长到需要省略号的记事本条目标题测试用',
      content: '# 错题\n\n`a^2 + b^2 = c^2`\n\n内容。',
      category: '学习',
      pinned: true,
      createdAt: iso(-3, 20),
      updatedAt: iso(-1, 20),
      sr: { ivl: 1, due: today, reps: 2, lapses: 0, ease: 2.5 },
    },
    {
      id: crypto.randomUUID(),
      title: 'PyQt5 信号与槽笔记',
      content: '## 写法\n\n```python\nbtn.clicked.connect(self.on_click)\n```',
      category: 'Python',
      pinned: false,
      createdAt: iso(-2, 15),
      updatedAt: iso(-2, 15),
      sr: { ivl: 0, due: today, reps: 0, lapses: 0, ease: 2.5 },
    },
  ];

  return {
    schemaVersion: 5,
    savedAt: new Date().toISOString(),
    tasks,
    settings: {
      lastView: 'today',
      lastSelectedDate: today,
      categories: [
        { id: 'c1', name: '学习' },
        { id: 'c2', name: 'STM32嵌入式开发' },
        { id: 'c3', name: '运动健康' },
        { id: 'c4', name: 'Python' },
        { id: 'c5', name: '这是一个特别长的分类名称用来撑爆筛选条' },
      ],
      habits,
      habitChecks,
      sleepLog: [{ date: today, wakeAt: '11:00', sleepAt: '02:00' }],
      dailyFocusGoalMinutes: 240,
      goals: [{ id: crypto.randomUUID(), name: '转本考试', date: day(60) }],
      weekPlanTemplate: { mon: ['早读'], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
    },
    diary,
    tombstones: [
      { id: crypto.randomUUID(), title: '被删掉的一条任务', date: day(-4), index: 0, deletedAt: iso(-2, 12) },
      { id: crypto.randomUUID(), title: unbroken, date: day(-3), index: 1, deletedAt: iso(-1, 12) },
    ],
    focusSessions,
    notes,
  };
}

/** 在页面里跑：量越界元素 */
const MEASURE = `(() => {
  const vw = document.documentElement.clientWidth;
  const doc = document.documentElement;
  const sx = window.scrollX || window.pageXOffset || 0;
  const bad = [];
  const path = (el) => {
    const parts = [];
    let node = el;
    for (let i = 0; i < 4 && node && node.nodeType === 1; i += 1) {
      let s = node.tagName.toLowerCase();
      const tid = node.getAttribute && node.getAttribute('data-testid');
      if (tid) s += '[data-testid=' + tid + ']';
      else if (node.id) s += '#' + node.id;
      else {
        const cls = (node.getAttribute('class') || '').trim().split(/\\s+/).slice(0, 3).join('.');
        if (cls) s += '.' + cls;
      }
      parts.unshift(s);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };
  // 横向可滚容器（chip 条 / 分段选择器）：里面的按钮本来就该超出可视区 ——
  // 那是"可以横滑"的意思，不是布局 bug。有这种祖先的元素一律跳过。
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
    // rect 是视口坐标；fixed 元素不受横向滚动影响，普通元素要加上 scrollX 才是文档坐标
    const fixed = cs.position === 'fixed';
    const left = r.left + (fixed ? 0 : sx);
    const right = r.right + (fixed ? 0 : sx);
    const over = Math.round(Math.max(right - vw, -left));
    if (over > 1) {
      bad.push({ sel: path(el), over, w: Math.round(r.width), left: Math.round(left), right: Math.round(right), text: (el.textContent || '').trim().slice(0, 40) });
    }
  }
  // 只留每条链路上最深的那个（父元素越界通常只是被子元素撑出来的）
  return {
    vw,
    sx,
    scrollW: doc.scrollWidth,
    bodyScrollW: document.body.scrollWidth,
    overflow: doc.scrollWidth > vw + 1,
    count: bad.length,
    worst: bad.sort((a, b) => b.over - a.over).slice(0, 8),
  };
})()`;

async function main() {
  if (!existsSync(path.join(DIST, 'index.html'))) {
    throw new Error(`没有 ${DIST}/index.html —— 先跑 npm run desktop:build`);
  }

  const { server, port } = await startServer(DIST);
  const { cdp, close } = await launch({ tag: 'audit' });

  const url = `http://127.0.0.1:${port}/index.html`;
  const seed = JSON.stringify(seedPayload());

  // 先落一次种子数据（要在目标 origin 上才有 localStorage）
  await cdp.send('Page.navigate', { url });
  await waitForApp(cdp);
  await cdp.evaluate(`(() => { localStorage.setItem('dt:app:v1', ${JSON.stringify(seed)}); return 1; })()`);

  let failures = 0;
  const report = [];

  for (const width of WIDTHS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height: HEIGHT,
      deviceScaleFactor: 1,
      mobile: width < 768,
    });

    for (const view of VIEWS) {
      // 换视图：改种子里的 lastView 再重载，等价于"下次冷启动落在这个视图"
      await cdp.evaluate(
        `(() => {
           const raw = localStorage.getItem('dt:app:v1');
           const obj = JSON.parse(raw);
           obj.settings.lastView = ${JSON.stringify(view)};
           localStorage.setItem('dt:app:v1', JSON.stringify(obj));
           return 1;
         })()`,
      );
      await cdp.send('Page.navigate', { url });
      await waitFor(async () =>
        cdp.evaluate(`!!(document.querySelector('#root') && document.querySelector('#root').children.length)`),
      );
      // 等一帧排版 + React 副作用（热力图/月报等派生渲染）
      await new Promise((r) => setTimeout(r, 350));

      await check(width, view, MEASURE);

      // 覆盖层场景：只在最窄的两档测（宽屏本来就不会溢出，省时间）
      if (width <= 390) {
        for (const overlay of OVERLAYS) {
          if (overlay.view !== view) continue;
          await cdp.send('Page.navigate', { url });
          await waitForApp(cdp);
          await new Promise((r) => setTimeout(r, 250));
          await cdp.evaluate(`(${overlay.open.toString()})()`);
          await new Promise((r) => setTimeout(r, 450));
          await check(width, `${view}+${overlay.name}`, MEASURE);
        }
      }
    }
  }

  function check(width, label, expr) {
    return cdp.evaluate(expr).then((result) => {
      const bad = result.overflow || result.count > 0;
      if (bad) failures += 1;
      report.push({ width, view: label, ...result });
      const flag = bad ? '✗' : '✓';
      console.log(
        `${flag} ${String(width).padStart(4)}px  ${String(label).padEnd(18)} scrollW=${result.scrollW} vw=${result.vw} 越界元素=${result.count}`,
      );
      if (bad) {
        for (const item of result.worst) {
          console.log(`      +${item.over}px  w=${item.w} [${item.left},${item.right}]  ${item.sel}`);
          if (item.text) console.log(`         «${item.text}»`);
        }
      }
    });
  }

  close();
  server.close();

  console.log('');
  if (failures > 0) {
    console.log(`移动端布局审计：${failures} 个「视口 × 视图」组合存在越界 ↑`);
  } else {
    console.log('移动端布局审计：全部视口 × 视图均无越界 ✓');
  }
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('审计失败：', error?.message ?? error);
  process.exit(2);
});
