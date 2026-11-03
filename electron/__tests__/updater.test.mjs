import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* ============================================================================
   桌面端更新器

   这个模块会**真实地移动和删除目录**，写错的后果是应用再也打不开。
   所以这里测的不是"功能对不对"，而是三条底线：
   ① 绝不写到 userData/web* 以外的任何地方（用户数据在 Local Storage，碰不得）；
   ② 换包必须原子：要么完整换过去，要么原封不动；
   ③ 换了之后没能渲染，下次启动必须自动回滚。
   ========================================================================= */

const require = createRequire(import.meta.url);

let userData;
let updater;

/** 用假的 electron 模块加载更新器，把 userData 指到临时目录 */
function loadUpdater(dataDir) {
  const Module = require('node:module');
  const origLoad = Module._load;
  const fakeElectron = {
    app: { getPath: () => dataDir, getAppPath: () => dataDir },
    net: { request: () => { throw new Error('本测试不联网'); } },
  };
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return fakeElectron;
    return origLoad.apply(this, arguments);
  };
  try {
    delete require.cache[require.resolve('../updater.cjs')];
    return require('../updater.cjs');
  } finally {
    Module._load = origLoad;
  }
}

/** 造一个能通过 hasIndex 校验的前端目录 */
function makeWeb(dir, marker) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), `<html><body>${marker}</body></html>` + 'x'.repeat(1200));
  fs.writeFileSync(path.join(dir, 'sw.js'), '// ' + marker);
}

function readMarker(dir) {
  return fs.readFileSync(path.join(dir, 'index.html'), 'utf-8').match(/<body>(.*?)<\/body>/)[1];
}

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-updater-'));
});

afterEach(() => {
  try {
    fs.rmSync(userData, { recursive: true, force: true });
  } catch {
    /* 临时目录清不掉不影响结论 */
  }
});

describe('写入闸门：只许碰 userData 下的 web 相关路径', () => {
  it('允许 web / web.staging / web.prev 及其子路径', () => {
    updater = loadUpdater(userData);
    const p = updater.paths();
    expect(() => updater.assertInsideUserDataWeb(path.join(p.active, 'index.html'))).not.toThrow();
    expect(() => updater.assertInsideUserDataWeb(path.join(p.staging, 'icons', 'a.png'))).not.toThrow();
    expect(() => updater.assertInsideUserDataWeb(p.prev)).not.toThrow();
  });

  /** 这条是「不要损坏数据」的核心：Local Storage 是用户任务与日记的所在 */
  it('拒绝 Local Storage / Local State / Preferences', () => {
    updater = loadUpdater(userData);
    for (const name of ['Local Storage', 'Local State', 'Preferences', 'Session Storage']) {
      expect(() => updater.assertInsideUserDataWeb(path.join(userData, name))).toThrow();
      expect(() => updater.assertInsideUserDataWeb(path.join(userData, name, 'leveldb', 'x.ldb'))).toThrow();
    }
  });

  it('拒绝同级同前缀目录（web-evil 不是 web 的子路径）', () => {
    updater = loadUpdater(userData);
    expect(() => updater.assertInsideUserDataWeb(path.join(userData, 'web-evil', 'x'))).toThrow();
    expect(() => updater.assertInsideUserDataWeb(path.join(userData, 'web.staging.bak', 'x'))).toThrow();
  });

  it('拒绝越出 userData 的路径', () => {
    updater = loadUpdater(userData);
    expect(() => updater.assertInsideUserDataWeb(path.join(userData, '..', 'evil'))).toThrow();
  });
});

describe('settleAtBoot：换包与回滚', () => {
  it('有完整 staging → 换入 active，旧包留成 web.prev，并清掉通行证', () => {
    updater = loadUpdater(userData);
    const p = updater.paths();
    makeWeb(p.active, 'old');
    fs.writeFileSync(p.okMark, '1');
    makeWeb(p.staging, 'new');
    fs.writeFileSync(p.stagingMark, JSON.stringify({ version: '0.2.0', buildId: 'newbuild' }));

    updater.settleAtBoot(() => {});

    expect(readMarker(p.active)).toBe('new');
    expect(readMarker(p.prev)).toBe('old'); // 旧包没有丢，回滚全靠它
    expect(fs.existsSync(p.staging)).toBe(false);
    expect(fs.existsSync(p.okMark)).toBe(false); // 新包还没被验证过
  });

  it('staging 不完整（没有 index.html）→ 不换，原包不动', () => {
    updater = loadUpdater(userData);
    const p = updater.paths();
    makeWeb(p.active, 'old');
    fs.writeFileSync(p.okMark, '1');
    fs.mkdirSync(p.staging, { recursive: true }); // 空目录
    fs.writeFileSync(p.stagingMark, JSON.stringify({ buildId: 'broken' }));

    updater.settleAtBoot(() => {});

    expect(readMarker(p.active)).toBe('old');
  });

  it('换包后没渲染成功（有身份证、缺通行证）→ 回滚到旧包并拉黑**这个**包', () => {
    updater = loadUpdater(userData);
    const p = updater.paths();
    makeWeb(p.prev, 'old');
    makeWeb(p.active, 'bad');
    // 身份证 = 更新器换进来的；不写 okMark = 上次没渲染成功
    fs.writeFileSync(p.activeMark, JSON.stringify({ version: '0.2.0', buildId: 'badbuild' }));

    updater.settleAtBoot(() => {});

    expect(readMarker(p.active)).toBe('old'); // 退回旧包，应用仍然能用
    expect(fs.readFileSync(p.badMark, 'utf-8').trim()).toBe('badbuild');
  });

  /**
   * 这条守的是一个真实踩到的 bug：
   * 最初判断"启动失败"只看"缺通行证"，于是一次正常的首次热更
   * 会把**好包**当坏包删掉，还顺手拉黑了一个根本没错的构建 —— 更新被永久拦住。
   * 现在只有带身份证（web.active.json）的包才参与回滚判定。
   */
  it('没有身份证的目录（出厂包 / 手动放的包）不参与回滚判定', () => {
    updater = loadUpdater(userData);
    const p = updater.paths();
    makeWeb(p.active, 'legacy'); // 有包、无身份证、无通行证
    makeWeb(p.staging, 'new');
    fs.writeFileSync(p.stagingMark, JSON.stringify({ version: '0.2.0', buildId: 'newbuild' }));

    updater.settleAtBoot(() => {});

    // 好包必须活下来，而且新包要正常换入
    expect(readMarker(p.active)).toBe('new');
    expect(readMarker(p.prev)).toBe('legacy');
    expect(fs.existsSync(p.badMark)).toBe(false); // 绝不能拉黑任何东西
  });

  it('没有旧包可回滚时，丢弃坏包而不是留着一个打不开的', () => {
    updater = loadUpdater(userData);
    const p = updater.paths();
    makeWeb(p.active, 'bad');
    fs.writeFileSync(p.activeMark, JSON.stringify({ buildId: 'badbuild' }));

    updater.settleAtBoot(() => {});

    expect(fs.existsSync(p.active)).toBe(false); // 交给 resources/web 出厂包兜底
  });

  it('正常启动（有 web.ok）时什么都不做', () => {
    updater = loadUpdater(userData);
    const p = updater.paths();
    makeWeb(p.active, 'good');
    fs.writeFileSync(p.okMark, '1');

    updater.settleAtBoot(() => {});

    expect(readMarker(p.active)).toBe('good');
    expect(fs.existsSync(p.prev)).toBe(false);
  });
});

describe('activeWebDir：只认"可用的"包', () => {
  it('没有热更包 → 返回 null（让上层回落到出厂包）', () => {
    updater = loadUpdater(userData);
    expect(updater.activeWebDir()).toBeNull();
  });

  it('index.html 是空壳 → 判定不可用', () => {
    updater = loadUpdater(userData);
    const p = updater.paths();
    fs.mkdirSync(p.active, { recursive: true });
    fs.writeFileSync(path.join(p.active, 'index.html'), 'x'); // 太小
    expect(updater.activeWebDir()).toBeNull();
  });

  it('完整包 → 返回其路径', () => {
    updater = loadUpdater(userData);
    const p = updater.paths();
    makeWeb(p.active, 'ok');
    expect(updater.activeWebDir()).toBe(p.active);
  });
});

describe('markBootOk：渲染成功后清残留', () => {
  beforeEach(() => {
    updater = loadUpdater(userData); // 每个用例都要绑定到自己的临时 userData
  });

  /** 造一个"刚换完包"的现场 */
  function makeJustSwapped() {
    const p = updater.paths();
    makeWeb(p.active, 'new');
    fs.writeFileSync(p.activeMark, JSON.stringify({ buildId: 'newbuild' }));
    makeWeb(p.prev, 'old'); // 上一版备份
    // staging 是个**半成品**（没有可用的 index.html）—— 真实场景里这就是下载中断的残留
    fs.mkdirSync(p.staging, { recursive: true });
    fs.writeFileSync(path.join(p.staging, 'partial.bin'), 'x'.repeat(64));
    fs.writeFileSync(p.stagingMark, '{}');
    fs.writeFileSync(p.badMark, 'badbuild');
    return p;
  }

  it('清掉 prev / staging / stagingMark，**保留** active、通行证与拉黑记录', () => {
    const p = makeJustSwapped();
    updater.markBootOk();
    expect(fs.existsSync(p.prev)).toBe(false);
    expect(fs.existsSync(p.staging)).toBe(false);
    expect(fs.existsSync(p.stagingMark)).toBe(false);
    /**
     * `web.bad` 必须留下。
     *
     * 它的含义是"那个远端包在本机启动失败过"。清理发生在"启动成功"之后，
     * 而回滚后的启动一定成功（跑的是旧包）—— 一删，黑名单就没了，
     * 下次检查更新又把同一个坏包推下来，用户陷入
     * 「更新 → 失败 → 回滚 → 再更新」的死循环。
     */
    expect(fs.existsSync(p.badMark)).toBe(true);
    expect(fs.existsSync(p.staging)).toBe(false);   // 半成品也清掉
    expect(readMarker(p.active)).toBe('new');       // 生效包绝不能动
    expect(fs.existsSync(p.okMark)).toBe(true);      // 通行证要在
    expect(fs.existsSync(p.activeMark)).toBe(true);  // 身份证要在
  });

  /**
   * 完整的 staging 是"用户已经点过更新、等下次启动换入"的包，**不是垃圾** —— 必须保留。
   * 只有半成品（下载中断的残留）才清。这条防止"清理"误伤待生效的更新。
   */
  it('完整的 staging 会被保留（那是待生效的更新，不是垃圾）', () => {
    const p = makeJustSwapped();
    makeWeb(p.staging, 'pending');
    fs.writeFileSync(p.stagingMark, JSON.stringify({ buildId: 'pendingbuild' }));
    updater.markBootOk();
    expect(readMarker(p.staging)).toBe('pending'); // 待生效的包还在
    expect(readMarker(p.active)).toBe('new');      // 当前生效的也没被动
  });

  it('把历史版本可能留下的临时目录一起扫掉', () => {
    updater = loadUpdater(userData);
    const p = updater.paths();
    makeWeb(p.active, 'new');
    for (const name of ['web.old', 'web.bak', 'web.tmp', 'web.staging.bak']) {
      makeWeb(path.join(userData, name), 'junk');
    }
    updater.markBootOk();
    for (const name of ['web.old', 'web.bak', 'web.tmp', 'web.staging.bak']) {
      expect(fs.existsSync(path.join(userData, name))).toBe(false);
    }
  });

  /**
   * 这条就是「防止更新频繁占用用户空间」的守护：
   * 清完之后，磁盘上只剩「当前生效包 + 几个小标记文件」，
   * 无论更新多少次，足迹都收敛到这个水平。
   */
  it('清理后磁盘足迹收敛：只剩 web 目录、几个标记与拉黑记录', () => {
    const p = makeJustSwapped();
    updater.markBootOk();
    const entries = fs.readdirSync(userData).sort();
    // web.bad 留着（几字节）—— 它是"别再推这个坏包"的唯一凭据
    expect(entries).toEqual(['web', 'web.active.json', 'web.bad', 'web.ok']);
  });
});
