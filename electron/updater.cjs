/* eslint-disable */
/**
 * 桌面端在线更新（离线包热替换）
 *
 * ── 为什么不替换 exe ────────────────────────────────────────────
 * 这个应用运行时加载的只是 `resources/web` 里的一堆前端文件，浏览器外壳（Electron）
 * 极少变化。所以更新只需要换掉那堆文件 —— 不用管理员权限、不用安装器、
 * 不会出现"装到一半断电变砖"。参考支付宝那套：exe 是"原生包"，
 * web 是"离线包"，日常迭代只发离线包。
 *
 * ── 数据安全的三条硬规矩 ────────────────────────────────────────
 * ① **只允许写 userData 下的 web 相关目录**（web / web.staging / web.prev / 三个标记文件）。
 *    `assertInside` 是每一处写操作的必经之路，路径必须是这些之一，
 *    否则直接抛错 —— 用户的任务和日记在 `Local Storage` 里，绝不能被这个模块碰到。
 * ② **绝不自动删除任何东西**：换下来的旧包改名成 web.prev 留着，回滚全靠它。
 * ③ **只在下一次启动前换包**，运行中不动任何文件。正在写日记的人不会被打断。
 *
 * ── 失败保护 ────────────────────────────────────────────────────
 * 换包后启动没成功渲染，下次启动自动回滚到 web.prev，并按 buildId 拉黑，
 * 避免"坏了→重下→又坏"的死循环。
 *
 * ── 增量 ────────────────────────────────────────────────────────
 * 清单里每个文件带 sha256，只下载本地哈希不一致的。整个前端才 11 个文件，
 * 通常一次更新只有 index.html 变了。
 */
const { app, net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * 更新源（发布域名）：**不再硬编码**。
 *
 * 打包时 `scripts/release_desktop.py` 从 `.env.local` 读 `VITE_CLOUD_ENDPOINT`
 * 写进 asar 内的 package.json（字段 `deployOrigin`）。开源构建没有这个字段 →
 * 更新检查整体禁用（`checkRemote` 直接返回"不可用"），不会去打别人的服务器。
 */
const UPDATE_ORIGIN = (() => {
  try {
    const pkg = require('../package.json');
    return typeof pkg.deployOrigin === 'string' ? pkg.deployOrigin.replace(/\/+$/, '') : '';
  } catch {
    return '';
  }
})();
/**
 * 访问码 —— 这个托管环境**所有路径都要 sharecode 才放行**。
 * 实测不带参数时连 `/icons/icon-192.png` 都是 403，更新请求自然也会被拦。
 * 换站点/换分享码时要和 `src/lib/update.ts` 里的同名常量一起改。
 */
/**
 * 分享码的**唯一真相是 package.json 的 `shareCode`**（与渲染层同源）。
 *
 * 打包时 `release_desktop.py` 会把它注入 asar 内 package.json；
 * 开发期读的则是仓库根的 package.json。两处都读同一个字段，
 * 从此不存在"改了一处忘了另一处"。
 */
const SHARE_CODE = (() => {
  try {
    const pkg = require('../package.json');
    return typeof pkg.shareCode === 'string' ? pkg.shareCode : '';
  } catch {
    return '';
  }
})();
const MANIFEST_URL = `${UPDATE_ORIGIN}/update/version.json?sharecode=${SHARE_CODE}`;

/** 给站内地址补 sharecode（清单里的下载地址是相对路径，同样需要） */
function withShareCode(url) {
  return url + (url.includes('?') ? '&' : '?') + 'sharecode=' + SHARE_CODE;
}

const MARK_OK = 'web.ok'; // 上次换包后成功渲染过
const MARK_BAD = 'web.bad'; // 拉黑的 buildId
const MARK_STAGING = 'web.staging.json'; // 待换入包的元信息
/**
 * 当前生效包的"身份证"。
 *
 * 为什么必须有它：判断"上次启动失败"不能只看"缺通行证"——
 * 第一次换入新包时通行证本来就是清的，于是会把**好包**当成坏包删掉，
 * 还会连带拉黑一个根本没错的构建（实测踩到过，会把更新永久拦住）。
 * 只有「这张身份证存在」才说明这个包是更新器换进来的，才适用回滚判定。
 * 出厂包（resources/web）和用户手动放的包都没有这张证，永远不碰。
 */
const MARK_ACTIVE = 'web.active.json';

function paths() {
  const userData = app.getPath('userData');
  return {
    userData,
    active: path.join(userData, 'web'),
    staging: path.join(userData, 'web.staging'),
    prev: path.join(userData, 'web.prev'),
    okMark: path.join(userData, MARK_OK),
    badMark: path.join(userData, MARK_BAD),
    stagingMark: path.join(userData, MARK_STAGING),
    activeMark: path.join(userData, MARK_ACTIVE),
  };
}

/**
 * 唯一的写操作闸门。
 * 允许的目标必须**严格等于**下面某一个，或是它们目录下的子路径。
 * 用 `path.relative` 判包含关系，比字符串 startsWith 可靠
 * （后者会把 `/a/web-evil` 当成 `/a/web` 的子路径）。
 */
function assertInsideUserDataWeb(target) {
  const p = paths();
  const allowed = [p.active, p.staging, p.prev, p.okMark, p.badMark, p.stagingMark, p.activeMark];
  const resolved = path.resolve(target);
  const ok = allowed.some((base) => {
    const rel = path.relative(base, resolved);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
  if (!ok) throw new Error('更新器拒绝写入非白名单路径: ' + resolved);
  return resolved;
}

function sha256File(file) {
  return new Promise((resolve) => {
    const h = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', () => resolve(null));
    stream.on('data', (chunk) => h.update(chunk));
    stream.on('end', () => resolve(h.digest('hex')));
  });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

function hasIndex(dir) {
  try {
    const stat = fs.statSync(path.join(dir, 'index.html'));
    return stat.isFile() && stat.size > 1000; // 空壳或写了一半的包不算数
  } catch {
    return false;
  }
}

/**
 * 本机当前**实际在跑**的构建标识。
 *
 * ⚠️ 不能只看 asar 里的 buildId。
 * 热更换的是 `userData/web`，asar 永远停留在出厂那一版；如果拿 asar 的 id 去比对，
 * 热更成功后它仍然认为自己是旧的 —— 结果每 6 小时把同一个包重下一遍，白耗流量。
 * 所以优先取"当前生效包的身份证"，没有才回落到出厂值。
 */
function localBuildId() {
  const info = readJson(paths().activeMark);
  if (info && info.buildId) return String(info.buildId);
  try {
    return require('../package.json').buildId || 'unknown';
  } catch {
    return 'unknown';
  }
}

function httpGetJson(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, method: 'GET' });
    const timer = setTimeout(() => {
      try {
        request.abort();
      } catch {}
      reject(new Error('timeout'));
    }, timeoutMs);
    request.on('response', (response) => {
      if (response.statusCode !== 200) {
        clearTimeout(timer);
        response.resume();
        reject(new Error('HTTP ' + response.statusCode));
        return;
      }
      const chunks = [];
      response.on('data', (c) => chunks.push(c));
      response.on('end', () => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
        } catch (e) {
          reject(e);
        }
      });
    });
    request.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    request.end();
  });
}

function downloadTo(url, dest, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    assertInsideUserDataWeb(dest);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const request = net.request({ url, method: 'GET' });
    const timer = setTimeout(() => {
      try {
        request.abort();
      } catch {}
      reject(new Error('timeout'));
    }, timeoutMs);
    request.on('response', (response) => {
      if (response.statusCode !== 200) {
        clearTimeout(timer);
        response.resume();
        reject(new Error('HTTP ' + response.statusCode));
        return;
      }
      const out = fs.createWriteStream(dest);
      response.pipe(out);
      out.on('finish', () => {
        clearTimeout(timer);
        out.close(() => resolve(dest));
      });
      out.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    request.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    request.end();
  });
}

/**
 * 启动时先"结账"：
 * - 上一个包如果没能成功渲染（缺 web.ok），回滚到 web.prev 并拉黑它；
 * - 如果有已经下好的 web.staging，在这里换入（此刻还没有任何窗口在读文件，最安全）。
 */
function settleAtBoot(log) {
  const p = paths();

  // ① 回滚检查：只针对**更新器自己换进来的**包（有身份证），且上次没渲染成功
  const activeInfo = readJson(p.activeMark);
  if (hasIndex(p.active) && activeInfo && activeInfo.buildId && !fs.existsSync(p.okMark)) {
    const prevOk = hasIndex(p.prev);
    log('检测到上次更新后未成功渲染，回滚' + (prevOk ? '到 web.prev' : '并丢弃该包'));
    try {
      // 拉黑的是**当前这个**坏包（身份证上的 buildId），不是待换入的那个
      fs.writeFileSync(assertInsideUserDataWeb(p.badMark), String(activeInfo.buildId), {
        encoding: 'utf-8',
      });
      log('已拉黑构建 ' + activeInfo.buildId);
      fs.rmSync(p.active, { recursive: true, force: true });
      fs.rmSync(p.activeMark, { force: true });
      if (prevOk) fs.renameSync(p.prev, p.active);
    } catch (e) {
      log('回滚失败: ' + e.message);
    }
  }

  // ② 换入已下载好的新包（必须通过完整性校验）
  if (hasIndex(p.staging)) {
    try {
      const meta = readJson(p.stagingMark);
      if (meta && meta.buildId) {
        if (fs.existsSync(p.prev)) fs.rmSync(p.prev, { recursive: true, force: true });
        if (hasIndex(p.active)) fs.renameSync(p.active, p.prev);
        fs.renameSync(p.staging, p.active);
        // 给新包办身份证，并清掉通行证 —— 它还没被验证过能渲染
        fs.writeFileSync(
          assertInsideUserDataWeb(p.activeMark),
          JSON.stringify({ version: meta.version, buildId: meta.buildId, at: Date.now() }),
          'utf-8',
        );
        fs.rmSync(p.okMark, { force: true });
        fs.rmSync(p.stagingMark, { force: true });
        log('已换入新前端 ' + meta.version + ' (' + meta.buildId + ')，等待渲染自检');
        return { applied: meta };
      }
      log('staging 缺少元信息，丢弃');
      fs.rmSync(p.staging, { recursive: true, force: true });
    } catch (e) {
      log('换包失败（保留原包）: ' + e.message);
    }
  }
  return null;
}

/** 窗口渲染成功后调用 —— 给当前这套前端发"通行证" */
/**
 * 新包通过渲染自检后调用：发通行证 + **清掉一切旧残留**。
 *
 * 为什么要在这里清：这是唯一能确定"新包没问题"的时刻 ——
 * 提前删会失去回滚能力，永远不删就会按更新次数堆积旧包占用户磁盘。
 * 清完之后，更新机制在磁盘上的足迹收敛为「当前生效包 + 几个字节大小的标记」。
 *
 * 清理范围（都在 userData 下，逐个过写入闸门）：
 *   web.prev          上一版备份（回滚窗口已关闭）
 *   web.staging       没换入成功的半成品
 *   web.staging.json  它的元信息
 *   web.bad           ⚠️ **故意不删**（见下方注释）
 *   web.old / web.bak / web.tmp / web.staging.bak   历史版本可能留下的命名
 */
const LEGACY_TEMP_DIRS = ['web.old', 'web.bak', 'web.tmp', 'web.staging.bak', 'web.download'];

function cleanupAfterSuccess(log = () => {}) {
  const p = paths();
  const removed = [];

  const rmDir = (dir) => {
    if (!fs.existsSync(dir)) return;
    fs.rmSync(dir, { recursive: true, force: true });
    removed.push(path.basename(dir));
  };
  const rmFile = (file) => {
    if (!fs.existsSync(file)) return;
    fs.rmSync(file, { force: true });
    removed.push(path.basename(file));
  };

  rmDir(p.prev);
  if (!hasIndex(p.staging)) rmDir(p.staging); // 半成品才清；完整 staging 会在下次启动换入
  rmFile(p.stagingMark);
  /**
   * ⚠️ `web.bad` **绝不能在这里删**。
   *
   * 这个标记的含义是"那个远端包在本机启动失败过"。清理发生在"启动成功"之后，
   * 而回滚后的启动一定成功（跑的是旧包）—— 一删，黑名单就没了；
   * 于是下次检查更新又把同一个坏包推下来，用户陷入
   * 「更新 → 启动失败 → 回滚 → 再更新」的死循环。
   *
   * 它只有几字节，留着无害。要解除拉黑只能是远端 buildId 变了（那是另一个包）。
   */
  for (const name of LEGACY_TEMP_DIRS) rmDir(path.join(p.userData, name));

  if (removed.length) log('已清理旧版本残留: ' + removed.join(', '));
}

function markBootOk() {
  try {
    fs.writeFileSync(assertInsideUserDataWeb(paths().okMark), String(Date.now()), 'utf-8');
    // 渲染自检通过 = 回滚窗口关闭，此刻清残留最安全
    cleanupAfterSuccess();
  } catch {
    /* 标记写不进去也不影响使用，只是下次可能误判回滚 —— 回滚本身是安全的 */
  }
}

/**
 * 只查不下：拉清单、和本机比、判断要不要更新。
 *
 * 单独拆出来是为了让界面能"问一句"而不触发下载 ——
 * 用户点了"以后再说"就不该消耗任何流量。
 *
 * @returns { available, version, buildId, localBuildId, manifest }
 */
async function checkRemote(log = () => {}) {
  const local = localBuildId();
  /** 没有更新源（开源构建的默认状态）→ 不联网、不报错，直接说"没有更新" */
  if (!UPDATE_ORIGIN || !SHARE_CODE) {
    return { available: false, version: '', buildId: '', localBuildId: local, manifest: null };
  }
  const manifest = await httpGetJson(MANIFEST_URL);

  if (!manifest || !manifest.desktop || !manifest.buildId) {
    log('更新清单无效');
    return { available: false, version: '', buildId: '', localBuildId: local, manifest: null };
  }

  const banned = fs.existsSync(paths().badMark)
    ? fs.readFileSync(paths().badMark, 'utf-8').trim()
    : '';
  const sameBuild = manifest.buildId === local;
  const isBanned = Boolean(banned) && banned === manifest.buildId;

  if (sameBuild) log('已是最新（' + local + '）');
  if (isBanned) log('该构建此前启动失败已被拉黑，跳过: ' + banned);

  return {
    available: !sameBuild && !isBanned,
    version: manifest.version || '',
    buildId: manifest.buildId,
    localBuildId: local,
    manifest,
  };
}

/**
 * 把清单里的文件下载到 staging（不换入，等下次启动）。
 * @param onProgress 可选，报告 (已完成, 总数)，用于界面进度
 */
async function download(manifest, log = () => {}, onProgress = () => {}) {
  const p = paths();
  if (!manifest || !manifest.desktop) throw new Error('清单无效');

  // 清掉上一次没成功的残留
  if (fs.existsSync(p.staging)) fs.rmSync(p.staging, { recursive: true, force: true });

  // base 从 origin 拼，不要拿 MANIFEST_URL 拼 —— 它现在带 ?sharecode=，拼出来的地址是坏的
  const base = new URL(manifest.desktop.base || 'app/', UPDATE_ORIGIN + '/update/').toString();
  const files = manifest.desktop.files || [];
  let downloaded = 0;
  let reused = 0;

  for (let i = 0; i < files.length; i += 1) {
    const item = files[i];
    const dest = path.join(p.staging, item.path);
    // 增量：本地（当前生效包 / 出厂包）已有同哈希文件就不重复下载
    const candidates = [
      path.join(p.active, item.path),
      path.join(app.getAppPath(), '..', 'web', item.path),
    ];
    let hit = false;
    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && (await sha256File(candidate)) === item.sha256) {
        assertInsideUserDataWeb(dest);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(candidate, dest);
        reused += 1;
        hit = true;
        break;
      }
    }
    if (hit) {
      onProgress(i + 1, files.length);
      continue;
    }

    await downloadTo(withShareCode(base + item.path), dest);
    const got = await sha256File(dest);
    if (got !== item.sha256) throw new Error('校验失败: ' + item.path);
    downloaded += 1;
    onProgress(i + 1, files.length);
  }

  if (!hasIndex(p.staging)) throw new Error('下载完成后仍没有可用的 index.html');

  fs.writeFileSync(
    assertInsideUserDataWeb(p.stagingMark),
    JSON.stringify({ version: manifest.version, buildId: manifest.buildId, at: Date.now() }),
    'utf-8',
  );
  log(`新版本已下载到 staging（下载 ${downloaded} 个 / 复用 ${reused} 个），下次启动生效`);
  return { version: manifest.version, buildId: manifest.buildId, downloaded, reused };
}

/** 后台自动流程：查 + 下（换入留到下次启动） */
async function downloadUpdate(log) {
  const result = await checkRemote(log);
  if (!result.available) return null;
  return download(result.manifest, log);
}

/** 是否已经有下好待换入的包 */
function hasStaged() {
  const p = paths();
  if (!hasIndex(p.staging)) return false;
  const meta = readJson(p.stagingMark);
  return Boolean(meta && meta.buildId);
}

/** 当前生效的前端目录（供 main.cjs 的 resolveWebDir 使用） */
function activeWebDir() {
  const p = paths();
  return hasIndex(p.active) ? p.active : null;
}

module.exports = {
  UPDATE_ORIGIN,
  MANIFEST_URL,
  paths,
  settleAtBoot,
  checkRemote,
  download,
  downloadUpdate,
  hasStaged,
  markBootOk,
  cleanupAfterSuccess,
  activeWebDir,
  localBuildId,
  assertInsideUserDataWeb,
};
