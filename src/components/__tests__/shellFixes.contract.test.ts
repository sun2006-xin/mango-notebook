import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/* ============================================================================
   外壳三处修复的源码级契约（本环境不渲染 DOM / 不起 Electron）

   ① 侧栏不该跟着页面滚（用户报"上下滑动左边栏也跟着滑动"）
   ② 桌面端窗口按钮自绘，不再用系统叠层（用户报"变小变大退出键和页面冲突"）
   ③ App 把顶部外壳高度传给所有 sticky 元素

   ⚠️ 扫源码前**必须先剥注释**：注释里出现同样的词会让断言形同虚设
   （这周已经被咬过两次）。
   ========================================================================= */

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '');
}

function read(rel: string): string {
  return stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'));
}

describe('侧栏：自己不做滚动容器，只有导航列表能滚', () => {
  const src = read('../layout/Nav.tsx');

  it('aside 不再是 overflow-y-auto（否则指针停在侧栏上滚的是侧栏自己）', () => {
    // 只看 aside 自己的开标签：整段 slice 会把里面可滚的 nav 一起算进来
    const start = src.indexOf('<aside');
    const aside = src.slice(start, src.indexOf('>', start));
    expect(aside).toContain('overflow-hidden');
    expect(aside).not.toContain('overflow-y-auto');
  });

  it('导航列表可滚且带 overscroll-contain（滚到底不把滚动接力给页面）', () => {
    const nav = src.slice(src.indexOf('<nav'), src.indexOf('</nav>'));
    expect(nav).toContain('overflow-y-auto');
    expect(nav).toContain('overscroll-contain');
    expect(nav).toContain('min-h-0');
  });

  it('sticky 的 top 用 topOffset，不是写死的 0', () => {
    const start = src.indexOf('<aside');
    const aside = src.slice(start, src.indexOf('>', start) + 400);
    expect(aside).toContain('top: topOffset');
    expect(aside).toContain('calc(100vh - ${topOffset}px)');
  });

  it('窄屏顶栏同样避让顶部外壳', () => {
    const start = src.indexOf('<header');
    const header = src.slice(start, src.indexOf('>', start) + 200);
    expect(header).toContain('top: topOffset');
  });
});

describe('App：把顶部外壳高度传给 sticky 元素', () => {
  const src = read('../../App.tsx');

  it('chromeHeight 由是否桌面端决定', () => {
    expect(src).toContain('const chromeHeight = isDesktop ? TITLE_BAR_HEIGHT : 0;');
  });

  it('Sidebar / MobileTabBar 都收到 topOffset', () => {
    expect(src).toContain('topOffset={chromeHeight}');
    expect(src.match(/topOffset=\{chromeHeight\}/g) ?? []).toHaveLength(2);
  });
});

describe('桌面端窗口按钮：自绘，不再用系统叠层', () => {
  const chrome = read('../common/WindowChrome.tsx');
  const main = read('../../../electron/main.cjs');
  const preload = read('../../../electron/preload.cjs');

  it('三个按钮都在，且命中区标了 no-drag（否则点击被拖拽区吃掉）', () => {
    expect(chrome).toContain('noDragStyle');
    expect(chrome.match(/style=\{noDragStyle\}/g) ?? []).toHaveLength(3);
    expect(chrome).toContain("act('minimize')");
    expect(chrome).toContain("act('toggleMaximize')");
    expect(chrome).toContain("act('close')");
  });

  it('老主进程（还在用系统叠层）时按能力探测，不画第二排按钮', () => {
    expect(chrome).toContain('selfDrawn');
    expect(chrome).toContain("typeof api.getState !== 'function'");
  });

  it('最大化状态由主进程推送（双击标题栏 / 系统快捷键也要跟着换图标）', () => {
    expect(chrome).toContain('onStateChange');
    expect(chrome).toContain('getState()');
  });

  it('主进程：不再启用 titleBarOverlay', () => {
    expect(main).not.toContain('titleBarOverlay');
    expect(main).toContain("titleBarStyle: 'hidden'");
  });

  it('主进程：四个窗口动作都有 IPC，且只操作发起请求的那个窗口', () => {
    expect(main).toContain("ipcMain.handle('window:minimize'");
    expect(main).toContain("ipcMain.handle('window:toggleMaximize'");
    expect(main).toContain("ipcMain.handle('window:close'");
    expect(main).toContain("ipcMain.handle('window:getState'");
    expect(main).toContain('BrowserWindow.fromWebContents(event.sender)');
  });

  it('主进程：最大化 / 还原状态变化推给渲染层', () => {
    expect(main).toContain("win.on('maximize', pushWindowState)");
    expect(main).toContain("win.on('unmaximize', pushWindowState)");
  });

  it('preload：桥上暴露四个动作 + 状态订阅', () => {
    expect(preload).toContain('window:minimize');
    expect(preload).toContain('window:toggleMaximize');
    expect(preload).toContain('window:close');
    expect(preload).toContain('window:getState');
    expect(preload).toContain("ipcRenderer.on('window:state'");
  });
});
