import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { isLoopbackHost, decodeRequestPath, resolveInside, isSameOrigin } = require('../serve-guard.cjs');

/* ============================================================================
   本地静态服务的三个安全判定

   这些用例守的是一类很具体的失效：**校验写得像对的，但边界漏了**。
   最典型的是 `path.join(root, '/../x').startsWith(root)` —— 看着像在做目录隔离，
   实际对 `<parent>/web-evil` 也会放行。所以这里直接钉住"越界必须为 null"。
   ========================================================================= */

const ROOT = path.resolve('D:/app/resources/web');

describe('resolveInside：目录穿越', () => {
  it('正常文件解析到 root 内', () => {
    expect(resolveInside(ROOT, '/index.html')).toBe(path.join(ROOT, 'index.html'));
    expect(resolveInside(ROOT, '/icons/icon-192.png')).toBe(
      path.join(ROOT, 'icons', 'icon-192.png'),
    );
  });

  it('根路径 → index.html', () => {
    expect(resolveInside(ROOT, '/')).toBe(path.join(ROOT, 'index.html'));
  });

  it('经典 ../ 穿越被挡', () => {
    expect(resolveInside(ROOT, '/../../../Windows/win.ini')).toBeNull();
    expect(resolveInside(ROOT, '/./../../secret.txt')).toBeNull();
  });

  /**
   * 这一条是本次修的核心回归：
   * 旧实现 path.join(ROOT, '/../web-evil/x') 得到 `<parent>/web-evil/x`，
   * 而字符串前缀判断 `startsWith(ROOT)` 会误判为"在 root 内" —— 直接放行。
   */
  it('同级同前缀目录（web → web-evil）必须被挡', () => {
    expect(resolveInside(ROOT, '/../web-evil/payload.js')).toBeNull();
  });

  it('空 / undefined 路径不崩，落到 index.html', () => {
    expect(resolveInside(ROOT, '')).toBe(path.join(ROOT, 'index.html'));
    expect(resolveInside(ROOT, undefined)).toBe(path.join(ROOT, 'index.html'));
  });

  it('反斜杠形式（Windows）同样被归一化后挡住', () => {
    expect(resolveInside(ROOT, '/..\\..\\boot.ini')).toBeNull();
  });
});

describe('isLoopbackHost：防 DNS rebinding', () => {
  it('回环地址放行（带端口）', () => {
    expect(isLoopbackHost('127.0.0.1:47613')).toBe(true);
    expect(isLoopbackHost('localhost:47613')).toBe(true);
    expect(isLoopbackHost('[::1]:47613')).toBe(true);
  });

  it('外部域名一律拒绝 —— 这正是 rebinding 攻击的入口', () => {
    expect(isLoopbackHost('evil.com')).toBe(false);
    expect(isLoopbackHost('evil.com:47613')).toBe(false);
    expect(isLoopbackHost('127.0.0.1.evil.com')).toBe(false);
    expect(isLoopbackHost('192.168.1.10:47613')).toBe(false);
  });

  it('空 Host 拒绝', () => {
    expect(isLoopbackHost('')).toBe(false);
    expect(isLoopbackHost(undefined)).toBe(false);
  });
});

describe('decodeRequestPath：畸形 URL', () => {
  it('正常路径解码', () => {
    expect(decodeRequestPath('/icons/a%20b.png')).toEqual({ ok: true, path: '/icons/a b.png' });
  });

  it('查询串被丢掉', () => {
    expect(decodeRequestPath('/index.html?x=1')).toEqual({ ok: true, path: '/index.html' });
  });

  /**
   * '%' 单独出现时 decodeURIComponent 抛 URIError。
   * 旧实现没有 try/catch —— 一个手打 URL 就能让整台本地服务抛异常。
   */
  it('非法百分号编码返回 bad-encoding，不抛异常', () => {
    expect(decodeRequestPath('/%')).toEqual({ ok: false, reason: 'bad-encoding' });
    expect(decodeRequestPath('/%zz')).toEqual({ ok: false, reason: 'bad-encoding' });
  });

  it('NUL 字节被拒', () => {
    expect(decodeRequestPath('/a%00b')).toEqual({ ok: false, reason: 'nul-byte' });
  });

  it('编码过的穿越也会先解码，再交给 resolveInside 挡', () => {
    const decoded = decodeRequestPath('/%2e%2e/%2e%2e/etc/passwd');
    expect(decoded.ok).toBe(true);
    expect(resolveInside(ROOT, decoded.path)).toBeNull();
  });
});

/* ============================================================================
   窗口内跳转的 origin 判定（审查发现的安全缺口）

   曾经写成 `url.startsWith(allowed)` —— 看着在做同源校验，实际能被
   userinfo 段绕过：`http://127.0.0.1:47613@evil.com/` 的 host 是 evil.com，
   但字符串确实以 `http://127.0.0.1:47613` 开头 → 放行 → 应用窗口被导航到
   远端页面，而它带着改写过的 Origin 头。
   ========================================================================= */
describe('isSameOrigin：窗口内跳转只准停在本机服务', () => {
  const ALLOWED = 'http://127.0.0.1:47613';

  it('完全同源 → 放行', () => {
    expect(isSameOrigin(ALLOWED, 'http://127.0.0.1:47613/index.html')).toBe(true);
    expect(isSameOrigin(ALLOWED, 'http://127.0.0.1:47613/')).toBe(true);
  });

  it('userinfo 绕过（前缀匹配的经典失效）→ 拦截', () => {
    // 这个 URL 的 host 是 evil.com，`127.0.0.1:47613` 只是 用户名:密码 段
    expect(isSameOrigin(ALLOWED, 'http://127.0.0.1:47613@evil.com/')).toBe(false);
  });

  it('端口前缀 / 路径后缀都不算同源', () => {
    expect(isSameOrigin(ALLOWED, 'http://127.0.0.1:476130/')).toBe(false);
    expect(isSameOrigin(ALLOWED, 'http://127.0.0.1/')).toBe(false);
    expect(isSameOrigin(ALLOWED, 'https://127.0.0.1:47613/')).toBe(false);
  });

  it('外站一律拦截', () => {
    expect(isSameOrigin(ALLOWED, 'https://evil.com/')).toBe(false);
    expect(isSameOrigin(ALLOWED, 'javascript:alert(1)')).toBe(false);
  });

  it('非法输入不抛（allowed 为空 / url 不是 URL）', () => {
    expect(isSameOrigin(null, 'http://x/')).toBe(false);
    expect(isSameOrigin(ALLOWED, '')).toBe(false);
    expect(isSameOrigin(ALLOWED, undefined)).toBe(false);
    expect(isSameOrigin(ALLOWED, 'not a url')).toBe(false);
  });
});
