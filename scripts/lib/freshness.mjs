/**
 * 产物新鲜度守卫。
 *
 * 为什么需要：布局 / 交互审计跑的是 `dist-single/index.html`（单文件产物），
 * 不是源码。如果忘了重新构建，脚本会**拿旧包跑出一片绿**，而结论已经完全
 * 不适用于当前代码 —— 这是最危险的一种"测试通过"。（本项目真踩过：
 * `npx vite build` 默认输出到 `dist/`，不是 `dist-single/`，而审计脚本读后者。）
 *
 * 判据：`src/**` 里任何一个非测试文件比 `dist-single/index.html` 新 → 产物过期。
 * 注意用**内容**判断更好，但 mtime 已经能挡住"改了没重建"这一类；
 * 变异测试会改写源文件再还原（内容相同、mtime 变新），那种情况会被判过期 ——
 * 宁可多重跑一次构建，也不要拿旧包下结论。
 */
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      walk(full, out);
    } else if (/\.(ts|tsx|css|json)$/.test(name)) {
      out.push({ file: full, mtime: st.mtimeMs });
    }
  }
  return out;
}

/**
 * @returns {{ok: boolean, newest?: string, builtAt?: number, newestAt?: number}}
 */
export function checkFreshness(root, artifactRel) {
  const artifact = path.join(root, artifactRel);
  const builtAt = statSync(artifact).mtimeMs;
  const files = walk(path.join(root, 'src'));
  let newest = null;
  for (const item of files) {
    if (item.mtime > builtAt + 1000 && (!newest || item.mtime > newest.mtime)) newest = item;
  }
  return {
    ok: !newest,
    builtAt,
    newestAt: newest?.mtime,
    newest: newest ? path.relative(root, newest.file) : undefined,
  };
}

/** 过期就直接失败退出（fail-closed，绝不带着旧包继续） */
export function assertFresh(root, artifactRel, buildCmd) {
  const info = checkFreshness(root, artifactRel);
  if (info.ok) return info;
  console.error(
    `\n产物已过期：${info.newest} 比 ${artifactRel} 更新。\n` +
      `请先重新构建：${buildCmd}\n` +
      `（现在继续只会拿旧包跑出一片绿，结论对当前代码无效。）\n`,
  );
  process.exit(2);
}
