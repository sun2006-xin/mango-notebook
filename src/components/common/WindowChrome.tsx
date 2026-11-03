import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { desktopBridge } from '../../lib/update';

/* ============================================================================
   窗口外壳（仅桌面端渲染）—— **自绘**标题栏
   ----------------------------------------------------------------------------
   历史沿革（也是这次改动的原因）：
   ① 最早用系统默认标题栏：一条灰底加"每日待办"三个字，和新配色完全不搭；
   ② 改成 `titleBarStyle: 'hidden'` + `titleBarOverlay`：系统画的三个按钮叠在
      页面之上，位置与命中区都不受页面控制 —— 最大化后按钮压在内容上、
      点页面右上角容易误触最小化/关闭（用户报的"变小变大退出键和页面冲突"）；
   ③ 现在：**按钮自己画**。命中区就是按钮自己那 44×36 的一块，与页面内容
      零重叠；页面顶部其余部分是可拖拽区（拖窗口 / 双击最大化）。

   按钮状态（最大化 ↔ 还原）由主进程推送：双击标题栏、Win+↑/↓、任务栏还原
   都会改变最大化状态，渲染层自己点的时候切换是不够的。
   ========================================================================= */

export const TITLE_BAR_HEIGHT = 36;

const dragStyle = { WebkitAppRegion: 'drag' } as CSSProperties;
const noDragStyle = { WebkitAppRegion: 'no-drag' } as CSSProperties;

/** 三个按钮的公共外观：44px 宽是 Windows 的命中区惯例（比看着大，好点） */
const BUTTON_CLASS =
  'grid h-9 w-11 shrink-0 place-items-center text-ink-2 transition-colors duration-short ' +
  'ease-standard hover:bg-surface hover:text-ink focus-visible:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-0';

function MinimizeIcon(): ReactNode {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none">
      <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

function MaximizeIcon(): ReactNode {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none">
      <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

/** 还原（两个错开的方框）—— 只在已最大化时出现 */
function RestoreIcon(): ReactNode {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none">
      {/*
        后面那个方框先画（位置靠左上），前面那个用**页面底色填充**盖掉它的
        右上角一段 —— 这样重叠处不会透出后面的线，才是 Windows 的还原图标。
      */}
      <rect x="0.5" y="2.5" width="7" height="7" stroke="currentColor" strokeWidth="1" />
      <rect
        x="2.5"
        y="0.5"
        width="7"
        height="7"
        stroke="currentColor"
        strokeWidth="1"
        fill="rgb(var(--rgb-paper))"
      />
    </svg>
  );
}

function CloseIcon(): ReactNode {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none">
      <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

export function WindowChrome() {
  const [maximized, setMaximized] = useState(false);
  /**
   * 主进程是不是"自绘按钮"那一版。
   *
   * 桌面端热更新只换前端（update/app/...），主进程与 preload 留在原处 ——
   * 老 exe 的 `titleBarOverlay` 还在画系统按钮。此时我们要是也画一套，
   * 右上角就是两排按钮。所以按能力探测：新桥有 `getState`，老桥没有。
   */
  const [selfDrawn, setSelfDrawn] = useState(false);

  useEffect(() => {
    if (!desktopBridge()) return undefined; // 网页 / 安卓没有窗口外壳这回事

    const api = window.desktopWindow;
    if (!api || typeof api.getState !== 'function') return undefined; // 老主进程：系统按钮还在
    setSelfDrawn(true);

    // 首帧先问一次：应用可能启动时就是最大化的（记住了上次窗口状态）
    api
      .getState()
      .then((state) => setMaximized(Boolean(state?.maximized)))
      .catch(() => {
        /* 问不到就按"未最大化"画，不影响窗口本身 */
      });

    // 之后的每次变化由主进程推过来（双击标题栏 / 系统快捷键 / 任务栏还原）
    const unsubscribe = api.onStateChange((state) => {
      setMaximized(Boolean(state?.maximized));
    });
    return () => unsubscribe();
  }, []);

  const act = (action: 'minimize' | 'toggleMaximize' | 'close'): void => {
    const api = window.desktopWindow;
    if (!api) return;
    void api[action]().catch(() => {
      /* 窗口动作失败（窗口已销毁等）不需要打扰用户 */
    });
  };

  return (
    <div
      style={dragStyle}
      className="fixed inset-x-0 top-0 z-50 flex h-9 items-center justify-between bg-paper
        pl-3 text-label text-ink-3 select-none"
    >
      <span className="pointer-events-none tracking-[0.08em]">芒果本本</span>

      {/* 老主进程（还在用系统叠层）时不画按钮，免得右上角变成两排 */}
      {!selfDrawn ? null : (
      <div className="flex items-stretch">
        <button
          type="button"
          style={noDragStyle}
          onClick={() => act('minimize')}
          aria-label="最小化"
          title="最小化"
          className={BUTTON_CLASS}
        >
          <MinimizeIcon />
        </button>
        <button
          type="button"
          style={noDragStyle}
          onClick={() => act('toggleMaximize')}
          aria-label={maximized ? '向下还原' : '最大化'}
          title={maximized ? '向下还原' : '最大化'}
          className={BUTTON_CLASS}
        >
          {maximized ? <RestoreIcon /> : <MaximizeIcon />}
        </button>
        {/*
          关闭按钮沿用 Windows 的红底：这是**唯一**一个不需要二次确认、
          点错代价又最大的按钮，颜色上必须与另外两个明确区分开。
        */}
        <button
          type="button"
          style={noDragStyle}
          onClick={() => act('close')}
          aria-label="关闭"
          title="关闭"
          className={`${BUTTON_CLASS} hover:bg-danger hover:text-white`}
        >
          <CloseIcon />
        </button>
      </div>
      )}
    </div>
  );
}
