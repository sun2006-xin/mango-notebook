/**
 * 真实浏览器工具层（无头 Chromium + CDP）—— 供布局审计与端到端冒烟共用。
 *
 * 为什么不用 Playwright：这里只需要"开页面、执行 JS、量尺寸"。
 * 项目里 `ws` 已经是传递依赖，用 CDP 直连零新依赖、零版本冲突；
 * 而 Playwright 会带一整套浏览器下载与 selector 引擎，
 * 对一个离线优先的小应用来说是纯负担。
 *
 * ⚠️ 踩过的坑（别再踩）：
 * `/json/version` 是**浏览器级**端点，在它上面 `Page.enable` 会返回 -32601；
 * 必须从 `/json/list` 里挑一个 `type === 'page'` 的 target。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import WebSocket from 'ws';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
};

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

/** 起一个只读静态服务器（随机端口，只绑 127.0.0.1） */
export function startServer(dir) {
  const server = createServer(async (req, res) => {
    let url;
    try {
      url = decodeURIComponent((req.url ?? '/').split('?')[0]);
    } catch {
      // 畸形转义（如 `/%`）会让 decodeURIComponent 抛 URIError —— 直接给 400，
      // 不要让异常穿到 server 的 'error' 事件上变成进程级崩溃
      res.writeHead(400).end('bad request');
      return;
    }
    const rel = url === '/' ? '/index.html' : url;
    const file = path.join(dir, rel);
    if (!file.startsWith(dir)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  server.on('error', () => {});
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

export async function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('找不到 Chromium（Chrome / Edge），无法做真实浏览器验证');
}

export async function waitFor(fn, timeout = 15000, interval = 100) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, interval));
  }
}

async function getWsUrl(port) {
  return waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      return page?.webSocketDebuggerUrl ?? null;
    } catch {
      return null;
    }
  });
}

/** 极简 CDP 客户端：只用到 Page / Runtime / Emulation 三个域 */
class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.id = 0;
    this.pending = new Map();
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)));
      else entry.resolve(msg.result);
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.text +
          ' ' +
          (result.exceptionDetails.exception?.description ?? ''),
      );
    }
    return result.result.value;
  }
}

/**
 * 开一个无头浏览器并连上首个页面 target。
 * 返回 { cdp, close } —— 调用方负责 close()，否则 Chrome 会一直挂着。
 */
export async function launch({ debugPort = 9333, tag = 'browser' } = {}) {
  const chrome = await findChrome();
  const userDataDir = path.join(os.tmpdir(), `dt-${tag}-${Date.now()}-${process.pid}`);

  const child = spawn(
    chrome,
    [
      '--headless=new',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-gpu',
      '--hide-scrollbars=false',
      '--allow-file-access-from-files',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const wsUrl = await getWsUrl(debugPort);
  const socket = new WebSocket(wsUrl, { perMessageDeflate: false });
  await new Promise((resolve, reject) => {
    socket.on('open', resolve);
    socket.on('error', reject);
  });
  const cdp = new Cdp(socket);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const close = () => {
    try {
      socket.close();
    } catch {
      /* 已断开 */
    }
    try {
      child.kill();
    } catch {
      /* 已退出 */
    }
  };

  return { cdp, close, userDataDir };
}

/** 等 React 挂载出内容（#root 里有子节点） */
export async function waitForApp(cdp) {
  return waitFor(async () =>
    cdp.evaluate(
      `!!(document.querySelector('#root') && document.querySelector('#root').children.length)`,
    ),
  );
}
