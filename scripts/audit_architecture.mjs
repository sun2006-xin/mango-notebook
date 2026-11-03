/**
 * 架构审计（源码级，零依赖）。
 *
 * 为什么不用 ESLint：这个项目已经有一套"契约测试"的传统（源码里 grep + 断言），
 * 而 ESLint 还带一整套插件与配置维护成本。更重要的是，这里要查的不是"代码风格"，
 * 而是**模块边界**：谁可以 import 谁、有没有循环依赖。这类规则用 AST 写一遍，
 * 既能当 CI 闸门，也能当解释文档（每条违规都打印出"为什么不允许"）。
 *
 * 用法：
 *   node scripts/audit_architecture.mjs          # 只报告
 *   node scripts/audit_architecture.mjs --strict # 有违规时退出码 1
 *
 * 分层（从下到上，**下层不许 import 上层**）：
 *   types  →  lib  →  store  →  hooks  →  components  →  views
 * 另有两条正交约束：
 *   - lib 必须是纯逻辑：不许 import react，也不许碰 store / DOM 组件；
 *   - views 之间不许互相 import（跨视图复用必须下沉到 components 或 lib）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'src');

/** 目录 → 层级权重（越大越"上层"）。文件首个路径段决定它属于哪一层 */
const LAYER = {
  types: 1,
  lib: 2,
  store: 3,
  hooks: 4,
  components: 5,
  views: 6,
};
/** 这几个在 Root 级别，单独处理 */
const ROOT_FILES = new Set(['main.tsx', 'App.tsx', 'vite-env.d.ts']);

/**
 * 已知且**有意为之**的例外。每一条都要写清楚理由 —— 白名单不是垃圾桶，
 * 它是一份"我们明知违反分层，但权衡后接受"的记录。
 */
const ALLOWED = [
  {
    file: 'store/StoreContext.tsx',
    imports: ['components/common/BootSplash'],
    why: '启动门控：装载期间必须渲染启动页，而它是 UI。放在 App 里会晚一步（App 还没挂载）',
  },
];

/**
 * 允许直接碰浏览器 API 的 lib 文件（**必须写理由**）。
 *
 * 这一条是"提示"不是"铁律"：`lib/storage.ts` 的职责本来就是 localStorage，
 * 让它"不碰 DOM"等于让它不存在。真正要防的是"随便哪个纯函数顺手读了 localStorage"
 * —— 那会让它没法在 node 里单测、也没法复用。
 * 所以规则是：**新的 lib 文件想碰浏览器 API，必须来这张表登记**。
 */
const BROWSER_GLUE = {
  'lib/storage.ts': '它就是存储层本身（localStorage / 快照 / 配额）',
  'lib/update.ts': '触发 APK 下载必须 createElement + click；跳过记录是设备本地偏好',
  'lib/image.ts': 'canvas 压缩图片，没有 DOM 就没有缩图',
  'lib/sound.ts': 'AudioContext 蜂鸣',
  'lib/network.ts': 'navigator.onLine / 事件监听',
  'lib/desktopBackup.ts': 'window.desktopBackup 桥；探测不到就降级为 no-op',
  'lib/cloud.ts': '云端 SDK 初始化（读 location / session）',
  'lib/apkUpdate.ts': '安卓安装包下载与版本探测',
  'lib/quickParse.ts': '（若命中）自然语言时间解析会读当前时间',
};

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__') continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** 剥掉注释：注释里写 `localStorage` 不算"用了 localStorage"（这一版踩过） */
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

/** 抽取一个文件里的相对 import 目标（只关心 src 内部） */
function importsOf(code) {
  const out = [];
  const re = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(code))) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (!spec || !spec.startsWith('.')) continue;
    out.push(spec);
  }
  return out;
}

/** 把相对路径解析成 src 下的绝对路径（可能是目录 / 省略扩展名） */
function resolveImport(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ];
  for (const c of candidates) {
    try {
      if (statSync(c).isFile()) return c;
    } catch {
      /* 下一个 */
    }
  }
  return null;
}

function layerOf(rel) {
  const seg = rel.split('/')[0];
  return { seg, weight: LAYER[seg] ?? null };
}

const files = walk(SRC);
/** rel → { file, code, deps: [rel] } */
const graph = new Map();
for (const file of files) {
  const rel = path.relative(SRC, file).replace(/\\/g, '/');
  const raw = readFileSync(file, 'utf8');
  const code = stripComments(raw);
  const deps = [];
  for (const spec of importsOf(code)) {
    const target = resolveImport(file, spec);
    if (!target) continue;
    const targetRel = path.relative(SRC, target).replace(/\\/g, '/');
    if (!targetRel.startsWith('..')) deps.push(targetRel);
  }
  graph.set(rel, { file, code, deps });
}

const violations = [];
function add(kind, file, detail) {
  const allowed = ALLOWED.some(
    (a) => a.file === file && (a.imports.length === 0 || a.imports.some((i) => detail.includes(i))),
  );
  if (allowed) return;
  violations.push({ kind, file, detail });
}

/* ---------- 1. 分层：下层不许依赖上层 ---------- */
for (const [rel, node] of graph) {
  const mine = layerOf(rel);
  if (mine.weight === null) continue;
  for (const dep of node.deps) {
    const theirs = layerOf(dep);
    if (theirs.weight === null) continue;
    if (theirs.weight > mine.weight) {
      add('层序反转', rel, `${rel}（第${mine.weight}层）→ ${dep}（第${theirs.weight}层）`);
    }
  }
}

/* ---------- 2. lib 必须是纯逻辑 ---------- */
for (const [rel, node] of graph) {
  if (layerOf(rel).seg !== 'lib') continue;
  if (/(^|\n)\s*import[^'"]*from\s*['"]react(-dom)?['"]/.test(node.code)) {
    add('lib 引入 react', rel, `${rel} 引了 react —— lib 是纯函数层，不能有 React 依赖`);
  }
  const domHits = [
    ['document.', /\bdocument\.(?!createElement\b)/], // createElement 在 downloadFile 里是必需的最小用法
    ['localStorage', /\blocalStorage\./],
    ['navigator.', /\bnavigator\./],
  ]
    .filter(([, re]) => re.test(node.code))
    .map(([name]) => name);
  if (domHits.length > 0 && !BROWSER_GLUE[rel]) {
    add(
      'lib 直接碰浏览器 API（未登记）',
      rel,
      `${rel} 直接用了 ${domHits.join(' / ')} —— 要么下沉到 storage，要么在 BROWSER_GLUE 里登记理由`,
    );
  }
}

/* ---------- 3. views 之间不许互相 import ---------- */
for (const [rel, node] of graph) {
  if (layerOf(rel).seg !== 'views') continue;
  for (const dep of node.deps) {
    if (layerOf(dep).seg === 'views') {
      add('视图互相依赖', rel, `${rel} → ${dep}（跨视图复用应下沉到 components / lib）`);
    }
  }
}

/* ---------- 4. 循环依赖（任何长度） ---------- */
const WHITE = 0;
const GREY = 1;
const BLACK = 2;
const color = new Map([...graph.keys()].map((k) => [k, WHITE]));
const stack = [];
const cycles = [];

function dfs(node) {
  color.set(node, GREY);
  stack.push(node);
  for (const dep of graph.get(node)?.deps ?? []) {
    if (!graph.has(dep)) continue;
    const c = color.get(dep);
    if (c === GREY) {
      const at = stack.indexOf(dep);
      cycles.push([...stack.slice(at), dep]);
    } else if (c === WHITE) {
      dfs(dep);
    }
  }
  stack.pop();
  color.set(node, BLACK);
}

for (const rel of graph.keys()) {
  if (color.get(rel) === WHITE) dfs(rel);
}

/* ---------- 5. 体量：单个文件过大（可维护性红线） ---------- */
const SIZE_WARN = 700;
const sizeReport = [...graph]
  .map(([rel, node]) => ({ rel, lines: node.code.split('\n').length }))
  .filter((f) => f.lines >= SIZE_WARN)
  .sort((a, b) => b.lines - a.lines);

/* ---------- 报告 ---------- */
const byKind = new Map();
for (const v of violations) {
  if (!byKind.has(v.kind)) byKind.set(v.kind, []);
  byKind.get(v.kind).push(v);
}

console.log(`\n架构审计 · ${graph.size} 个源文件\n${'─'.repeat(64)}`);
if (violations.length === 0) {
  console.log('✓ 分层 / 纯逻辑 / 视图隔离 全部通过');
} else {
  for (const [kind, list] of byKind) {
    console.log(`\n✗ ${kind}（${list.length}）`);
    for (const v of list.slice(0, 20)) console.log(`   ${v.detail}`);
    if (list.length > 20) console.log(`   … 还有 ${list.length - 20} 条`);
  }
}

if (cycles.length > 0) {
  console.log(`\n✗ 循环依赖（${cycles.length}）`);
  for (const c of cycles.slice(0, 8)) console.log('   ' + c.join(' → '));
}

console.log(`\n文件体量 ≥ ${SIZE_WARN} 行：${sizeReport.length} 个`);
for (const f of sizeReport) console.log(`   ${String(f.lines).padStart(5)}  ${f.rel}`);

const strict = process.argv.includes('--strict');
const bad = violations.length + cycles.length;
console.log(`\n结论：${bad === 0 ? '干净' : `${bad} 处待处理`}`);
process.exitCode = strict && bad > 0 ? 1 : 0;
