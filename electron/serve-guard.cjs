/* eslint-disable */
/**
 * 本地静态服务的三个安全判定（纯函数，零依赖）
 *
 * 单独抽出来的理由：`main.cjs` 一 import 就会拉 Electron 运行时，
 * 里面的逻辑没法单测；而这三个判定恰恰是最需要被钉死的地方。
 * 抽成纯 CJS 模块后，node / vitest 都能直接 require。
 */

const path = require('node:path');

/** 只认回环地址。带端口或不带端口都接受。 */
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i;

/**
 * Host 头是否来自本机。
 *
 * 防的是 DNS rebinding：恶意页面把自己的域名解析到 127.0.0.1，
 * 浏览器于是认为它同源，就能**读到**本地服务返回的内容。
 * 本地服务的真实威胁模型不是"外网直连"，而是"本机浏览器里的另一个页面"。
 */
function isLoopbackHost(host) {
  return LOOPBACK.test(String(host || ''));
}

/**
 * 解析请求路径。返回 { ok: true, path } 或 { ok: false, reason }。
 *
 * 两处坑：
 * ① `decodeURIComponent('%')` 抛 URIError —— 不接住就是一次能打挂服务的 DoS；
 * ② NUL 字节会让底层文件 API 提前截断路径。
 */
function decodeRequestPath(rawUrl) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(rawUrl || '/').split('?')[0]);
  } catch {
    return { ok: false, reason: 'bad-encoding' };
  }
  if (decoded.includes('\0')) return { ok: false, reason: 'nul-byte' };
  return { ok: true, path: decoded };
}

/**
 * 把请求路径解析成 root 内的绝对路径；越界返回 null。
 *
 * ⚠️ 必须用 `path.resolve` 而不是 `path.join`：
 *   path.join('/a/web', '/../web-evil/x')  →  '/a/web-evil/x'
 *   而 '/a/web-evil/x'.startsWith('/a/web') 依然为 **true** —— 校验形同虚设。
 * resolve 会逐段归一，再用「root + 分隔符」卡边界，越界立刻暴露。
 */
function resolveInside(root, requestPath) {
  const base = path.resolve(root);
  const rel = String(requestPath || '/') === '/' ? 'index.html' : String(requestPath).replace(/^\/+/, '');
  const target = path.resolve(base, rel);
  if (target === base) return path.join(base, 'index.html');
  return target.startsWith(base + path.sep) ? target : null;
}

/**
 * 窗口内跳转是否合法：** origin 必须等于当前页面的 origin **。
 *
 * ⚠️ 绝不能写成 `url.startsWith(allowed)` —— 前缀匹配能被 userinfo 绕过：
 *   allowed = 'http://127.0.0.1:47613'
 *   url     = 'http://127.0.0.1:47613@evil.com/'
 * 这个 URL 的 host 是 `evil.com`，`127.0.0.1:47613` 只是「用户名:密码」段，
 * 但它确实以 allowed 开头 → 前缀判定放行 → 应用窗口被导航到远端页面，
 * 而窗口带着我们改写过的 Origin 头（云同步要用）。
 *
 * 同理，`http://127.0.0.1:47613xyz` 这类端口前缀、`/evil` 这类路径后缀
 * 都不是"同一个 origin"，只有 `new URL(url).origin === allowed` 才算。
 */
function isSameOrigin(allowedOrigin, url) {
  if (!allowedOrigin) return false;
  let origin;
  try {
    origin = new URL(String(url)).origin;
  } catch {
    return false;
  }
  return origin === allowedOrigin;
}

module.exports = { isLoopbackHost, decodeRequestPath, resolveInside, isSameOrigin };
