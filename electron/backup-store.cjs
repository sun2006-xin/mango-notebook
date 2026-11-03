/* eslint-disable */
/**
 * 自动备份的**纯逻辑**（文件名白名单 / 路径解析 / 保留份数 / 原子写）。
 *
 * 单独抽出来的理由和 serve-guard.cjs 一样：`main.cjs` 一 require 就会拉起
 * Electron 运行时，里面的逻辑没法单测；而"防路径穿越"和"只留 14 份"
 * 恰恰是最需要被钉死的两件事 —— 它们出错会删用户文件、或让 `../evil.json`
 * 读到磁盘上任意位置。
 *
 * 本文件只依赖 node 内置模块，node / vitest 都能直接 require。
 */

const path = require('node:path');
const fs = require('node:fs');

/**
 * 允许读写的文件名白名单。
 *
 * ⚠️ 这是**唯一**的路径穿越防线，且必须写死在服务端（主进程）：
 * 渲染进程传来的 name 完全不可信（页面被 XSS / 用户手改都算）。
 * `../evil.json`、`C:\\Windows\\win.ini`、`%2e%2e/x` 一律不匹配。
 */
const BACKUP_NAME = /^\d{4}-\d{2}-\d{2}\.json$|^pre-restore\.json$/;

/** 保留多少份**按天**的备份（pre-restore 不算在内） */
const KEEP_BACKUPS = 14;

const DATED_NAME = /^\d{4}-\d{2}-\d{2}\.json$/;

/** 文件名是否在白名单内 */
function isSafeBackupName(name) {
  return typeof name === 'string' && BACKUP_NAME.test(name);
}

/**
 * name → 备份目录内的绝对路径；不合法返回 null（绝不抛）。
 *
 * 即使白名单已经排除了 `..`，这里再做一次 `path.relative` 校验：
 * 白名单将来被人放宽（比如允许子目录）时，这一层还能兜住。
 */
function resolveBackupPath(dir, name) {
  if (!isSafeBackupName(name)) return null;
  const base = path.resolve(dir);
  const full = path.resolve(base, name);
  const rel = path.relative(base, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return full;
}

/** 备份目录（不存在时创建）；失败返回 null */
function ensureBackupDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch (e) {
    return null;
  }
}

/** 列出已有的备份（按文件名倒序 = 新的在前）。目录不存在返回空数组 */
function listBackups(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return [];
  }
  const entries = [];
  for (const name of names) {
    if (!isSafeBackupName(name)) continue;
    const full = path.join(dir, name);
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      entries.push({ name, size: stat.size, mtime: stat.mtimeMs });
    } catch (e) {
      /* 读不到的单条直接跳过 */
    }
  }
  return entries.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
}

/**
 * 只保留最新 keep 份**按天**的备份；`pre-restore.json` 永远保留
 * （它是"恢复前那一份"，正是用户最需要回退的那一份）。
 *
 * 返回被删掉的文件名数组。
 */
function pruneBackups(dir, keep = KEEP_BACKUPS) {
  const dated = listBackups(dir).filter((entry) => DATED_NAME.test(entry.name));
  const removed = [];
  for (let i = keep; i < dated.length; i += 1) {
    const name = dated[i].name;
    try {
      fs.unlinkSync(path.join(dir, name));
      removed.push(name);
    } catch (e) {
      /* 删不掉就算了，下次启动再试 */
    }
  }
  return removed;
}

/**
 * 原子写：先写 `.tmp` 再 rename。
 *
 * 直接 writeFileSync 到目标名有个真实风险：写的过程中断电 / 被杀进程，
 * 磁盘上就留下一个**半截 JSON**，而它恰好占着当天的文件名 ——
 * 下次想写当天的备份会被"已存在"顶掉，用户以为有备份，恢复时解析失败。
 * rename 在同一文件系统内是原子的，读到的要么是旧的、要么是完整的新文件。
 */
function writeBackup(dir, name, json) {
  if (!isSafeBackupName(name)) return { ok: false, error: 'bad-name' };
  if (typeof json !== 'string' || !json) return { ok: false, error: 'empty' };
  const target = resolveBackupPath(dir, name);
  if (!target) return { ok: false, error: 'bad-name' };
  if (!ensureBackupDir(dir)) return { ok: false, error: 'mkdir-failed' };

  const tmp = `${target}.tmp`;
  try {
    fs.writeFileSync(tmp, json, 'utf8');
    fs.renameSync(tmp, target);
    return { ok: true, name, size: Buffer.byteLength(json, 'utf8') };
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch (ignored) {
      /* 清理失败忽略 */
    }
    return { ok: false, error: (e && e.message) || 'write-failed' };
  }
}

/** 读一份备份；名字不合法 / 不存在 / 读失败都返回 { ok:false } */
function readBackup(dir, name) {
  const target = resolveBackupPath(dir, name);
  if (!target) return { ok: false, error: 'bad-name' };
  try {
    return { ok: true, name, json: fs.readFileSync(target, 'utf8') };
  } catch (e) {
    return { ok: false, error: 'missing' };
  }
}

module.exports = {
  BACKUP_NAME,
  DATED_NAME,
  KEEP_BACKUPS,
  isSafeBackupName,
  resolveBackupPath,
  ensureBackupDir,
  listBackups,
  pruneBackups,
  writeBackup,
  readBackup,
};
