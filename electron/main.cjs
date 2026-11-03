/* 每日待办 · Electron 主进程
 *
 * 核心决策：**不走 file://，改走本地 HTTP 服务加载页面。**
 *
 * 实测证据：从 app.asar 里 loadFile 时，带 --no-sandbox 等参数能加载，
 * 用户直接双击（无参数）则 did-fail-load code=-2 ERR_FAILED——
 * file:// + asar 这条路径在不同环境下行为不一致，是白屏的直接原因。
 * 改为主进程内起一个 127.0.0.1 的静态服务再 loadURL：
 *   - 与浏览器访问行为完全一致，没有 file:// 的各种特例
 *   - localhost 属于安全上下文，localStorage / Service Worker 行为正常
 *
 * 端口必须固定：localStorage 的隔离粒度是「协议+域名+端口」，
 * 端口一变数据就"丢了"。所以优先绑 47613，被占用时在一个小范围内顺延。
 */
const { app, BrowserWindow, session, shell, dialog, ipcMain, globalShortcut } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');

const isDev = !!process.env.VITE_DEV_SERVER_URL;

/**
 * 把数据目录**钉死**在 `%APPDATA%\daily-todo`。
 *
 * 这行是改名工程的保险丝：Electron 打包后 `app.getName()` 优先取 productName，
 * 而 userData 默认就是 `%APPDATA%\<getName()>`。我们把 productName 改成了
 * 「芒果本本」，如果不在 ready 之前钉死，数据目录会跟着变成 `%APPDATA%\芒果本本`
 * —— 用户打开应用发现任务全没了（数据还在旧目录，但读不到了）。
 * 显式 setPath 之后，以后再怎么改名都不影响数据。
 */
app.setPath('userData', path.join(app.getPath('appData'), 'daily-todo'));

/* 沙箱/受限环境下 Chromium 渲染进程可能崩溃或无法加载本地文件。
   在 ready 之前追加，等效于命令行传参，用户双击也能生效。 */
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'boot.log'), line);
  } catch (e) {
    /* 忽略 */
  }
  try {
    fs.appendFileSync(path.join(os.tmpdir(), 'daily-todo-boot.log'), line);
  } catch (e) {
    /* 忽略 */
  }
}

/**
 * 未捕获异常。
 *
 * ⚠️ 启动阶段的致命错误**必须让用户看见**。
 * 曾经这里只写一行日志：asar 里少了一个被 require 的模块时，主进程反复抛错、
 * 但因为有这个监听者所以不会退出 —— 窗口永远不出现，任务管理器里却躺着一串进程。
 * 用户看到的是"双击了、没反应、还占着"，唯一的线索是 %TEMP% 里一个日志文件。
 *
 * 判定标准很简单：**还没有任何窗口** = 启动失败 = 弹窗告知并退出；
 * 已经有窗口的运行时异常只记日志，不打断正在使用的用户。
 */
process.on('uncaughtException', (error) => {
  log(`uncaughtException: ${error && error.stack ? error.stack : error}`);
  if (BrowserWindow.getAllWindows().length > 0) return;
  try {
    dialog.showErrorBox(
      '芒果本本启动失败',
      `${(error && error.message) || error}\n\n详细日志：${path.join(os.tmpdir(), 'daily-todo-boot.log')}`,
    );
  } catch (e) {
    /* 连弹窗都失败就只能退出，至少不留下僵尸进程 */
  }
  app.exit(1);
});

/* ---------- 云同步来源改写（已移除） ---------- */

/**
 * 这里曾经把发往云端的 Origin/Referer 改写成发布域名，让桌面端也能登录同步。
 *
 * 默认客户端构建会清空云配置，不会发云请求；自建云桌面构建改用使用者自己的
 * endpoint 和 `?cloud=1`，不需要改写 Origin / Referer，也不读取项目方部署域名。
 *
 * 前端 `isCloudRuntimeAvailable()` 的 `?cloud=1` 开关仍然保留，
 * 供本地回归登录面板 UI 用（不影响发布产物）。
 */

/* ---------- 本地静态服务 ---------- */

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain',
};

/**
 * 页面资源目录。
 *
 * 优先级：**在线更新下来的包 > 出厂包**
 * 1. `userData/web` —— 热更新换入的那套（只有通过完整性校验才会存在）
 * 2. `resources/web` —— 安装包自带的出厂版，永远不动，是最后的安全垫
 * 3. `dist-single` —— 开发期目录
 *
 * 换包不会改变端口，所以 localStorage 的 origin 不变，数据不受影响。
 */
function resolveWebDir() {
  const hot = updater.activeWebDir();
  const candidates = [
    hot,
    path.join(process.resourcesPath || '', 'web'),
    path.join(__dirname, '..', 'dist-single'),
  ];
  for (const dir of candidates) {
    if (dir && fs.existsSync(path.join(dir, 'index.html'))) {
      if (hot && dir === hot) log('使用热更新包: ' + dir);
      return dir;
    }
  }
  return null;
}

const { isLoopbackHost, decodeRequestPath, resolveInside, isSameOrigin } = require('./serve-guard.cjs');
const updater = require('./updater.cjs');
const backupStore = require('./backup-store.cjs');

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // 纯本地应用：只允许同源（没有云端请求，留白名单反而是多余的攻击面）
  "connect-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

function startStaticServer(webDir, callback) {
  const root = path.resolve(webDir);

  const server = http.createServer((req, res) => {
    const method = req.method || 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end();
      return;
    }

    // ① Host 必须是回环地址（防 DNS rebinding）
    if (!isLoopbackHost(req.headers.host)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('forbidden host');
      return;
    }

    // ② 路径解码：非法百分号编码 / NUL 字节直接 400
    const decoded = decodeRequestPath(req.url);
    if (!decoded.ok) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('bad request');
      return;
    }

    // ③ 目录穿越：解析后必须真的落在 root 里
    const filePath = resolveInside(root, decoded.path);
    if (!filePath) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('forbidden');
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const type = MIME[ext] || 'application/octet-stream';
      const headers = {
        'Content-Type': `${type}; charset=utf-8`,
        'X-Content-Type-Options': 'nosniff',
        // 本地资源随版本替换，不能让 WebView 长期吃旧缓存
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      };
      if (ext === '.html') headers['Content-Security-Policy'] = CSP;
      res.writeHead(200, headers);
      res.end(method === 'HEAD' ? undefined : data);
    });
  });

  /**
   * 端口策略：**首选端口必须尽量绑上**。
   *
   * 为什么这件事关系到"数据安全"而不只是"启动快慢"：
   * localStorage 的隔离粒度是 【协议 + 域名 + **端口**】。端口一变，
   * 浏览器就认为这是另一个站点 —— 上一版的**登录凭据和全部业务数据都读不到**，
   * 用户看到的是"数据没了 + 要我重新登录"，而文件其实一个字节都没少。
   *
   * 所以顺序是：先在首选端口**重试几次**（绝大多数情况是上一次进程还没退干净，
   * 几十到几百毫秒就释放了），确认绑不上才退到备用端口，并把 `degraded`
   * 标志交给调用方去提醒用户。
   */
  const PRIMARY_PORT = 47613;
  const FALLBACK_PORTS = [47614, 47615, 47616];
  /** 首选端口重试节奏：约 2 秒内共试 4 次，覆盖"上一个实例正在退出" */
  const RETRY_DELAYS = [0, 250, 600, 1200];

  const listenOnce = (port) =>
    new Promise((resolve) => {
      const onError = () => {
        server.removeListener('listening', onListening);
        resolve(false);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(true);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });

  const bind = async () => {
    for (const delay of RETRY_DELAYS) {
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      // eslint-disable-next-line no-await-in-loop
      if (await listenOnce(PRIMARY_PORT)) return { port: PRIMARY_PORT, degraded: false };
      log(`首选端口 ${PRIMARY_PORT} 暂不可用，等待重试（可能上一个实例还在退出）`);
    }

    for (const port of FALLBACK_PORTS) {
      // eslint-disable-next-line no-await-in-loop
      if (await listenOnce(port)) {
        log(
          `⚠️ 已退到备用端口 ${port}：本次运行的 localStorage 与上一版不是同一个域，` +
            '旧数据与登录态可能读不到（数据没删，只是读不到）',
        );
        return { port, degraded: true };
      }
    }
    return null;
  };

  bind()
    .then((bound) => {
      if (!bound) {
        callback(null);
        return;
      }
      /**
       * 绑成功后**必须留一个常驻 error 监听**。
       * 之前这里是 removeAllListeners('error')：之后的任何 error 事件
       * （EMFILE、连接被重置……）都会变成 uncaughtException，直接打崩主进程。
       * EventEmitter 对没有监听者的 'error' 事件的处理方式就是抛出。
       */
      server.on('error', (error) => log(`本地服务错误: ${error && error.message}`));
      storageDegraded = bound.degraded;
      callback(bound.port, bound.degraded);
    })
    .catch((error) => {
      log('本地服务绑定异常: ' + (error && error.message));
      callback(null);
    });
}

/**
 * 本次运行是否"换了端口"（= localStorage 换了域）。
 * 渲染层启动时问一次，用来提醒用户「旧数据可能读不到，可以用导入备份找回」。
 */
let storageDegraded = false;

/* ---------- 窗口 ---------- */

function createWindow(webDir) {
  log('createWindow 开始');
  /**
   * 窗口/任务栏图标。
   * exe 文件本身的图标是 electron-builder 打包时烘进去的，改它必须重打 exe；
   * 但运行时的窗口与任务栏图标可以由这里指定 —— 所以先覆盖这一层。
   * 文件不存在时传 undefined，交给 Electron 用默认图标，不至于启动失败。
   */
  /**
   * dev 模式下 webDir 是 null（页面来自 vite dev server），
   * 原来直接 path.join(null, ...) 会抛 TypeError 把窗口创建整个打断。
   * 所以先判空再取路径。
   */
  const iconPath = webDir ? path.join(webDir, 'icons', 'icon-256.png') : null;
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 360,
    minHeight: 560,
    title: '芒果本本',
    /**
     * 无边框 + **自绘**窗口按钮。
     *
     * 之前用 titleBarOverlay（系统画的三个按钮叠在页面之上）：位置与命中区
     * 都不受页面控制，最大化后按钮压在页面内容上、点页面右上角容易误触
     * 最小化/关闭 —— 用户报的"变小变大退出键和页面冲突"。
     *
     * 现在 `hidden` 只负责去掉系统标题栏，右上角的三个按钮由渲染层
     * （WindowChrome）自己画、自己定尺寸，命中区就是它自己那一块，
     * 与页面内容不再有任何重叠。
     */
    titleBarStyle: 'hidden',
    ...(iconPath && fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    backgroundColor: '#FAFAFA',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: false,
      devTools: true,
      /**
       * 预加载脚本：给页面一个**很窄**的更新接口（查/下/重启）。
       * 页面本身没有 Node 权限，下载文件与重启只能由主进程代劳。
       */
      ...(webDir ? { preload: path.join(__dirname, 'preload.cjs') } : {}),
    },
  });
  log('BrowserWindow 已创建');

  const reveal = () => {
    if (!win.isVisible()) {
      win.show();
      log('窗口已显示');
    }
  };
  win.once('ready-to-show', reveal);
  win.webContents.once('did-finish-load', () => {
    reveal();
    // 渲染自检：白屏最常见形态是"窗口在但 React 没挂载"，
    // 必须真的去问 DOM，只看 did-finish-load 区分不出来。
    win.webContents
      .executeJavaScript(
        'JSON.stringify({ title: document.title, root: (document.getElementById("root")||{}).children ? document.getElementById("root").children.length : -1 })',
      )
      .then((result) => {
        log(`渲染自检: ${result}`);
        /**
         * 只有真的渲染出内容，才给当前这套前端发"通行证"（web.ok）。
         * 下次启动时若发现包在、标记不在，就判定上一次换包失败并自动回滚 ——
         * 这是防止"更新坏了、应用再也打不开"的那道保险。
         */
        try {
          const parsed = JSON.parse(result);
          if (parsed && parsed.root > 0) updater.markBootOk();
          else log('renderer 未挂载任何内容，不发通行证');
        } catch {
          /* 解析失败就不发通行证，宁可下次回滚也不要留下坏包 */
        }
      })
      .catch((error) => log(`渲染自检失败: ${error && error.message}`));
  });
  setTimeout(reveal, 1500);

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log(`did-fail-load: code=${code} desc=${desc} url=${url}`);
  });
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    log(`console[${level}] ${message} @ ${sourceId}:${line}`);
  });

  /**
   * 最大化 / 还原状态推给渲染层。
   * 自绘按钮要跟着变图标（最大化 ↔ 还原），光靠渲染层自己点的时候切换是不够的：
   * 双击拖拽区、系统快捷键（Win+↑/↓）、从任务栏还原都会改变最大化状态，
   * 那些路径渲染层根本不知道，图标就会停在旧状态。
   */
  const pushWindowState = () => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send('window:state', { maximized: win.isMaximized() });
  };
  win.on('maximize', pushWindowState);
  win.on('unmaximize', pushWindowState);

  win.webContents.on('render-process-gone', (_e, details) => {
    log(`render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`);
    if (details.reason === 'crashed' && !process.argv.includes('--gpu-crash-retried')) {
      log('渲染进程崩溃 → 重启一次');
      app.relaunch({
        args: [...process.argv.slice(1), '--gpu-crash-retried'],
      });
      app.exit(0);
    }
  });

  if (isDev) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    startStaticServer(webDir, (port) => {
      if (!port) {
        log('本地服务启动失败（端口被占尽）');
        return;
      }
      // `?cloud=1`：前端 `isCloudRuntimeAvailable()` 的显式开关，让桌面端也显示
      // 登录入口（否则它会因为 origin 不是发布域名而把入口藏起来）。
      // 加上它不会改变 localStorage 的域（仍是 127.0.0.1:<port>），**本机数据不受影响**。
      /** 桌面端是纯本地应用：不追加 `?cloud=1`（那个开关只用于本地回归登录 UI） */
      const url = `http://127.0.0.1:${port}/`;
      log(`本地服务已启动: ${url}，开始加载`);
      win.loadURL(url).catch((error) => log(`loadURL 失败: ${error && error.message}`));
    });
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  /**
   * 拦住**当前窗口**的跳转。
   * setWindowOpenHandler 只管新窗口；`location.href = 'https://elsewhere'`
   * 或者 target="_self" 的链接会把应用整个导航走 ——
   * 那样这个窗口就在跑远端页面了，而它带着我们改写过的 Origin 头。
   * 只允许停在本机服务上，其余一律丢给系统浏览器。
   */
  win.webContents.on('will-navigate', (event, url) => {
    // 当前页面自身的 origin 就是唯一合法目的地（dev 下是 vite，生产下是本地服务）
    let allowed = null;
    try {
      allowed = new URL(win.webContents.getURL()).origin;
    } catch {
      allowed = null;
    }
    /*
      ⚠️ 必须是** origin 相等**，不能是 `url.startsWith(allowed)`。

      前缀匹配能被 userinfo 绕过：
        allowed = 'http://127.0.0.1:47613'
        url     = 'http://127.0.0.1:47613@evil.com/'
      这个 URL 的 host 是 `evil.com`，`127.0.0.1:47613` 只是用户名/密码段，
      但它确实以 allowed 开头 → 前缀判定放行 → 应用窗口被导航到远端页面，
      而窗口带着我们改写过的 Origin 头（云同步要用）。
      判定抽到 serve-guard.isSameOrigin，好让它能被单测钉住。
    */
    if (isSameOrigin(allowed, url)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    log(`已拦截窗口内跳转: ${url}`);
  });
}

/* ---------- 更新：状态与 IPC ---------- */

/**
 * 主进程缓存的"上一次检查结果"，页面随时可读（不触发联网）。
 *
 * 后台每 6 小时只**检查**、不下载 —— 用户没点"立即更新"就不该消耗他的流量。
 * 这也是"用户可以选择不更新"的实现基础。
 */
/** 用户是否允许后台自动检查（页面启动时会把它的偏好同步过来） */
let autoCheckEnabled = true;

const updateStatus = {
  available: false,
  version: '',
  buildId: '',
  localBuildId: '',
  checkedAt: 0,
  error: null,
};

function pushStatus(patch) {
  Object.assign(updateStatus, patch);
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('update:status', { ...updateStatus });
  }
  return { ...updateStatus };
}

async function runUpdateCheck(log = () => {}) {
  try {
    const result = await updater.checkRemote(log);
    /**
     * 把结论写进日志。GUI 里的横幅我没法自动化点击，
     * 有了这行就能从 boot.log 确认"应用到底有没有发现新版本"。
     */
    log(
      result.available
        ? `发现新版本 ${result.version}（${result.buildId}），本机 ${result.localBuildId}`
        : `更新检查完成：本机已是最新（${result.localBuildId}）`,
    );
    return pushStatus({
      available: result.available,
      version: result.version,
      buildId: result.buildId,
      localBuildId: result.localBuildId,
      checkedAt: Date.now(),
      error: null,
    });
  } catch (e) {
    log('检查更新失败: ' + (e && e.message));
    return pushStatus({ checkedAt: Date.now(), error: (e && e.message) || 'network' });
  }
}

function registerUpdateIpc() {
  ipcMain.handle('update:status', () => ({
    ...updateStatus,
    staged: updater.hasStaged(),
  }));

  ipcMain.handle('update:check', async () => {
    const status = await runUpdateCheck(log);
    return { ...status, staged: updater.hasStaged() };
  });

  ipcMain.handle('update:download', async (event) => {
    try {
      const checked = await updater.checkRemote(log);
      if (!checked.available) {
        return { ok: false, reason: 'already-latest', ...pushStatus({ available: false }) };
      }
      const sender = event.sender;
      await updater.download(checked.manifest, log, (done, total) => {
        if (!sender.isDestroyed()) sender.send('update:progress', { done, total });
      });
      return { ok: true, version: checked.version, buildId: checked.buildId };
    } catch (e) {
      log('下载更新失败: ' + (e && e.message));
      return { ok: false, reason: (e && e.message) || 'download-failed' };
    }
  });

  ipcMain.handle('update:setAutoCheck', (_event, enabled) => {
    autoCheckEnabled = Boolean(enabled);
    log('自动检查更新：' + (autoCheckEnabled ? '开' : '关'));
    return autoCheckEnabled;
  });

  /**
   * @deprecated 自绘按钮后不再需要（旧的 titleBarOverlay 换色）。
   * 保留是因为**旧版渲染层**（已装到用户机器上的 asar）仍会调它：
   * 换成"未注册"会让那次 invoke 变成 rejection，虽然无害但会污染日志。
   */
  ipcMain.handle('window:setOverlayColors', (_event, payload) => {
    const color = typeof payload?.color === 'string' ? payload.color : '#FAFAFA';
    const symbolColor = typeof payload?.symbolColor === 'string' ? payload.symbolColor : '#18181B';
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        win.setTitleBarOverlay({ color, symbolColor, height: 36 });
      } catch {
        /* 未启用 overlay（自绘按钮）时必然失败：忽略即可 */
      }
    }
    return true;
  });

  /* ---------- 自绘标题栏的窗口控制 ---------- */

  /**
   * 只暴露"当前这一个窗口"的四个动作 + 一个状态查询。
   * 不暴露 setBounds / setPosition 之类能任意摆布窗口的能力 —— 桥越窄越安全。
   */
  function windowOf(event) {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win && !win.isDestroyed() ? win : null;
  }

  ipcMain.handle('window:minimize', (event) => {
    const win = windowOf(event);
    if (!win) return false;
    win.minimize();
    return true;
  });

  ipcMain.handle('window:toggleMaximize', (event) => {
    const win = windowOf(event);
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return true;
  });

  ipcMain.handle('window:close', (event) => {
    const win = windowOf(event);
    if (!win) return false;
    win.close();
    return true;
  });

  ipcMain.handle('window:getState', (event) => {
    const win = windowOf(event);
    return {
      maximized: win ? win.isMaximized() : false,
      /** true = 本次运行换了端口，localStorage 的域跟着变了，旧数据/登录态可能读不到 */
      storageDegraded,
    };
  });

  ipcMain.handle('update:restart', () => {
    log('用户确认重启以应用新版本');
    app.relaunch();
    app.exit(0);
  });
}

/* ============================================================================
   自动备份（F4 · 桌面端）

   为什么放在主进程而不是页面里：页面没有 Node 权限（contextIsolation 是对的），
   写不了 `userData/backups`。而浏览器端的 localStorage 只有 5 MB，
   又会被"清除应用数据"一起清掉 —— 那正是最需要备份的场景。

   安全边界（全部在主进程这一侧）：
   - 文件名走白名单正则（见 backup-store.cjs），`../evil.json` 直接拒；
   - 只读写 `userData/backups` 目录内的文件，路径再过一次 path.relative 校验；
   - 写入 tmp → rename，避免留下半截 JSON 占住当天的文件名。
   ========================================================================= */

/** 备份目录：`%APPDATA%/daily-todo/backups`（设置页可一键打开） */
function backupDir() {
  return path.join(app.getPath('userData'), 'backups');
}

/** 'YYYY-MM-DD'（本地时区；绝不用 toISOString().slice，那会跨时区差一天） */
function todayFileKey() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function registerBackupIpc() {
  /** 写一份备份；name 省略 = 按当天日期命名（每天一份，同一天覆盖） */
  ipcMain.handle('backup:write', (_event, payload) => {
    const json = typeof payload?.json === 'string' ? payload.json : '';
    const name =
      typeof payload?.name === 'string' && payload.name ? payload.name : `${todayFileKey()}.json`;
    if (!backupStore.isSafeBackupName(name)) {
      log(`自动备份被拒：非法文件名 ${String(name)}`);
      return { ok: false, error: 'bad-name' };
    }
    const result = backupStore.writeBackup(backupDir(), name, json);
    if (!result.ok) {
      log('自动备份写入失败: ' + result.error);
      return result;
    }
    const removed = backupStore.pruneBackups(backupDir(), backupStore.KEEP_BACKUPS);
    if (removed.length) log(`自动备份：清理旧快照 ${removed.join(', ')}`);
    log(`自动备份已写入 backups/${name}（${result.size} 字节）`);
    return result;
  });

  ipcMain.handle('backup:list', () => ({
    ok: true,
    dir: backupDir(),
    entries: backupStore.listBackups(backupDir()),
  }));

  ipcMain.handle('backup:read', (_event, name) => {
    const result = backupStore.readBackup(backupDir(), name);
    if (!result.ok) log(`读取备份失败：${String(name)}（${result.error}）`);
    return result;
  });

  ipcMain.handle('backup:openDir', async () => {
    const dir = backupStore.ensureBackupDir(backupDir());
    if (!dir) return { ok: false, error: 'mkdir-failed' };
    const error = await shell.openPath(dir);
    return error ? { ok: false, error } : { ok: true, dir };
  });
}

/**
 * 全局快捷键（F12）：从任何地方把芒果本本唤回来。
 *
 * 用 globalShortcut 而不是菜单/托盘：用户是"正在写代码/看视频，突然想起来
 * 有件事要记"，此时按一下就能回到今日页，比找托盘图标快得多。
 *
 * 注册失败（被别的软件占用）**静默跳过**：这不是错误，也不该弹窗打扰。
 */
const QUICK_ADD_ACCELERATOR = 'CommandOrControl+Shift+Space';

function registerGlobalShortcut(log) {
  try {
    const ok = globalShortcut.register(QUICK_ADD_ACCELERATOR, () => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      // 让渲染层切到今日页（输入框聚焦由它自己决定，主进程不越界）
      win.webContents.send('shortcut:quickadd');
    });
    log(ok ? `全局快捷键已注册: ${QUICK_ADD_ACCELERATOR}` : '全局快捷键被占用，已跳过');
  } catch (e) {
    log('全局快捷键注册异常: ' + (e && e.message));
  }
}

function boot() {  app.whenReady().then(() => {
    log('app ready');
    registerUpdateIpc();
    registerBackupIpc();
    registerGlobalShortcut(log);

    if (isDev) {
      createWindow(null);
      return;
    }

    /**
     * 先"结账"再开窗：此刻还没有任何窗口在读文件，是唯一安全的换包时机。
     * 顺序不能反 —— resolveWebDir 要看到换入后的结果。
     */
    try {
      const applied = updater.settleAtBoot(log);
      if (applied && applied.applied) log('本次启动使用新下载的前端');
    } catch (e) {
      log('更新结账异常（继续用出厂包）: ' + (e && e.message));
    }

    const webDir = resolveWebDir();
    log(`页面资源目录: ${webDir}（存在=${webDir ? fs.existsSync(path.join(webDir, 'index.html')) : false}）`);
    if (!webDir) {
      log('找不到页面资源，无法启动');
      dialog.showErrorBox('芒果本本启动失败', '找不到页面资源目录（resources/web）。请重新解压安装包。');
      app.quit();
      return;
    }
    createWindow(webDir);

    /**
     * 后台静默检查更新：启动后等一会儿（别和首屏抢资源），之后每 6 小时一次。
     * 只下载到 staging，**换包留到下次启动** —— 正在写日记的人不会被突然刷新。
     * 任何异常都只记日志：更新失败绝不能影响正常使用。
     */
    /**
     * 后台只检查、不下载。
     * 结果推给页面，由用户决定要不要更新 —— 没点就不消耗他的流量。
     */
    const checkUpdates = async () => {
      // 用户关掉了自动检查就彻底安静 —— 连一次网络请求都不发
      if (!autoCheckEnabled) return;
      const status = await runUpdateCheck(log);
      /**
       * 诊断开关：`DT_AUTO_DOWNLOAD=1` 时跳过"等用户点按钮"，直接把包下好。
       * 用途是发版后验证下载链路（GUI 的按钮没法自动化点击）。
       * 普通用户不会设这个变量，所以不影响"用户可以选择不更新"的默认行为。
       */
      if (process.env.DT_AUTO_DOWNLOAD === '1' && status.available && !updater.hasStaged()) {
        try {
          log('DT_AUTO_DOWNLOAD 生效，开始下载');
          await updater.download(
            (await updater.checkRemote(log)).manifest,
            log,
            (done, total) => log(`下载进度 ${done}/${total}`),
          );
          log('下载完成，下次启动生效');
        } catch (e) {
          log('诊断下载失败: ' + (e && e.message));
        }
      }
    };
    setTimeout(checkUpdates, 20_000);
    setInterval(checkUpdates, 6 * 60 * 60 * 1000);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(webDir);
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

/**
 * 单实例锁。
 *
 * 没有它的话，双击几次快捷方式就会堆出几套主进程 + 渲染进程，
 * 而用户只看到"点了没反应、后台一堆进程"。有锁之后：
 * 第二个实例直接退出，把机会让给已经存在的那个 —— 顺便把它叫到前台。
 * 这也是主流桌面应用的通行做法（浏览器、编辑器、IM 都是这个行为）。
 */
if (!app.requestSingleInstanceLock()) {
  log('已有实例在运行，本实例退出');
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
    log('第二个实例被唤回已有窗口');
  });
  boot();
}
