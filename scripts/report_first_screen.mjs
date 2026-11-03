/**
 * 首屏构成报告（真实 Chromium 实测）。
 *
 * 为什么需要它：讨论"今日页该重排什么"时，凭印象说"上面东西太多"没有说服力，
 * 而"第一条任务在第 1.6 屏"是可以量出来的。这个脚本只做一件事：
 * 在 390×780（最常见的安卓竖屏）下，把今日页从顶部到第一条任务之间
 * 每个区块的高度、以及首屏能看到几条任务，打印成一张表。
 *
 * 用法：node scripts/report_first_screen.mjs
 * 退出码恒为 0 —— 它是**报告**不是门禁（门禁是 audit_mobile_layout）。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, startServer, waitForApp } from './lib/browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist-single');

const WIDTH = 390;
const HEIGHT = 780;

/**
 * 最小样例：只放"会让今日页变高"的那几样。
 * 回顾卡要有**昨天**的数据才出现；习惯条要有习惯；目标倒计时要有 goals。
 */
function seed() {
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

  const habitId = crypto.randomUUID();
  return {
    schemaVersion: 5,
    savedAt: new Date().toISOString(),
    tasks: [
      // 昨天的痕迹：让「昨日回顾」卡出现
      mk({ title: '昨天的任务一', date: day(-1), done: true, doneAt: iso(-1, 20) }),
      mk({ title: '昨天的任务二', date: day(-1), done: true, doneAt: iso(-1, 21) }),
      // 逾期区
      mk({ title: '昨天没做完的逾期任务', date: day(-1), time: '20:00' }),
      // 今天的清单
      mk({ title: '高数第七章课后题 12–30', time: '09:00', priority: 'high', estimatedMinutes: 120 }),
      mk({ title: 'STM32 软件 I2C 写 MPU6050', time: '14:00', category: 'STM32' }),
      mk({ title: '背单词 Unit 7', repeat: 'daily' }),
      mk({ title: '跑五公里', category: '运动' }),
      mk({ title: '已经做完的一件事', done: true, doneAt: iso(0, 10) }),
    ],
    settings: {
      lastView: 'today',
      lastSelectedDate: today,
      categories: [
        { id: 'c1', name: '学习' },
        { id: 'c2', name: 'STM32' },
        { id: 'c3', name: '运动' },
      ],
      habits: [{ id: habitId, name: '早起', archivedAt: null, autoTask: false }],
      habitChecks: [{ habitId, date: today }],
      sleepLog: [],
      dailyFocusGoalMinutes: 240,
      goals: [{ id: crypto.randomUUID(), name: '转本考试', date: day(60) }],
      weekPlanTemplate: null,
    },
    diary: [],
    tombstones: [],
    focusSessions: [],
    notes: [],
  };
}

/** 在页面里量：区块高度 + 首屏可见任务数 */
const MEASURE = `(() => {
  const vh = window.innerHeight;
  const rect = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top + window.scrollY), h: Math.round(r.height) };
  };
  const blocks = [
    ['昨日回顾', '[data-testid="daily-recap"]'],
    ['复习横幅', '[data-testid="review-banner"]'],
    ['目标倒计时', '[data-testid="goal-countdown"]'],
    ['作息打卡', '[data-testid="sleep-log"]'],
    ['习惯条', '[data-testid="habit-strip"]'],
    ['今日预算', '[data-testid="today-budget"]'],
    ['快速添加', '[data-testid="quickadd-input"]'],
    ['逾期区', 'section[aria-label="逾期任务"]'],
  ].map(([name, sel]) => ({ name, ...(rect(sel) ?? { top: null, h: 0 }) }))
   .filter((b) => b.top !== null);

  const rows = [...document.querySelectorAll('[data-task-id]')];
  const firstRow = rows.length ? Math.round(rows[0].getBoundingClientRect().top + window.scrollY) : null;
  // 完全落在首屏内（不跨屏）的任务行数
  const inFirstScreen = rows.filter((el) => {
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= vh;
  }).length;

  return {
    vh,
    scrollH: Math.round(document.documentElement.scrollHeight),
    blocks,
    firstRow,
    rowCount: rows.length,
    inFirstScreen,
  };
})()`;

async function main() {
  const { server, port } = await startServer(DIST);
  const { cdp, close } = await launch({ tag: 'first-screen' });
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await waitForApp(cdp);
    // 灌一份最小样例后重载（数据走 localStorage，与真实路径一致）
    await cdp.evaluate(
      `localStorage.setItem('dt:app:v1', ${JSON.stringify(JSON.stringify(seed()))}); location.reload();`,
    );
    await new Promise((r) => setTimeout(r, 900));
    await waitForApp(cdp);

    const data = await cdp.evaluate(MEASURE);
    const screens = (n) => (n / data.vh).toFixed(2);

    console.log(`\n今日页首屏构成 · ${WIDTH}×${HEIGHT}\n${'─'.repeat(58)}`);
    console.log('区块'.padEnd(12) + '起始 y'.padStart(8) + '高度'.padStart(8) + '折算屏'.padStart(10));
    for (const b of data.blocks) {
      console.log(
        b.name.padEnd(12) + String(b.top).padStart(8) + String(b.h).padStart(8) +
          screens(b.top).padStart(10),
      );
    }
    console.log('─'.repeat(58));
    if (data.firstRow !== null) {
      console.log(`第一条任务出现在 y=${data.firstRow}（第 ${screens(data.firstRow)} 屏）`);
    }
    console.log(`首屏内完整可见的任务行：${data.inFirstScreen} / ${data.rowCount}`);
    console.log(`整页高度 ${data.scrollH}px ≈ ${screens(data.scrollH)} 屏`);
  } finally {
    close();
    server.close();
  }
  process.exitCode = 0;
}

main().catch((error) => {
  console.error('测量失败：', error);
  process.exitCode = 1;
});
