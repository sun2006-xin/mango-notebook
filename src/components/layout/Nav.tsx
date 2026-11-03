import { memo } from 'react';
import { TAB_VIEWS, VIEW_META, VIEW_ORDER } from '../../constants';
import { useOnline } from '../../hooks/useOnline';
import { Icon } from '../common/Icon';
import { MangoMark } from '../common/MangoMark';
import { ProgressFromDay } from '../common/ProgressBar';
import type { DayProgress, ViewId } from '../../types';

export interface NavProps {
  view: ViewId;
  onViewChange: (view: ViewId) => void;
  progress: DayProgress;
  /** 侧栏/顶部品牌行副标题用的日期文案 */
  dateLabel: string;
  /** 打开全局搜索 */
  onSearch: () => void;
  /**
   * 顶部被窗口外壳占掉的高度（桌面端 = 标题栏 36px，网页/安卓 = 0）。
   *
   * sticky 的 `top` 必须是这个偏移：写死 0 的话，桌面端一滚页面，
   * 侧栏就会从"标题栏下方"浮到"视口最顶"，钻到系统按钮底下 ——
   * 看起来就是"左边栏跟着页面一起动"。
   */
  topOffset?: number;
}

/**
 * 侧栏（≥1024 窄屏断点以上，220 固定栏）。
 * 四档：今日 / 周 / 日历 / 设置；选中态用 aria-current="page" 标记。
 */
/**
 * 用 memo 包住：侧栏只依赖 view / progress / dateLabel 三个值，
 * 与日记正文、专注记录毫无关系。不包的话，日记里每敲一个字它都要重渲一遍 ——
 * 一天写 500 字就是 500 次无意义的侧栏渲染 + 1000 次 ProgressBar 计算。
 * 前提是父级传下来的 props 引用要稳定（进度对象走 useMemo、回调走 useCallback）。
 */
export const Sidebar = memo(function Sidebar({
  view,
  onViewChange,
  progress,
  dateLabel,
  onSearch,
  topOffset = 0,
}: NavProps) {
  /**
   * 侧栏自己**不做滚动容器**（`overflow-hidden`），只有中间的导航列表能滚。
   *
   * 原来整条 aside 是 `overflow-y-auto`：指针停在侧栏上滚页面时，滚的是侧栏自己，
   * 品牌行和"今日进度"会跟着上下跑 —— 用户报的"上下滑动左边栏也跟着滑动"。
   * 现在 aside 内部只有 `nav` 可滚，且带 `overscroll-contain`：
   * 滚到底也不会把滚动接力给页面（反向同理），视觉上侧栏是钉死的。
   */
  return (
    <aside
      aria-label="侧边栏"
      style={{ top: topOffset, height: `calc(100vh - ${topOffset}px)` }}
      className="sidebar sticky hidden w-sidebar shrink-0 flex-col gap-6 overflow-hidden
        border-r border-line bg-paper px-4 pb-5 pt-6 lg:flex"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 pl-3">
        <div className="flex items-center gap-2">
          <MangoMark size={28} className="shrink-0" />
          <div className="flex flex-col">
            <span className="font-num text-label font-bold tracking-[0.18em] text-accent">NOTES</span>
            <span className="text-h2 font-bold tracking-[-0.01em]">芒果本本</span>
          </div>
        </div>
        <button
          type="button"
          data-testid="nav-search"
          onClick={onSearch}
          aria-label="搜索"
          title="搜索（Ctrl+K）"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-md text-ink-2 hover:bg-surface hover:text-ink"
        >
          <Icon name="search" size={16} />
        </button>
      </div>

      <nav
        aria-label="主导航"
        className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overscroll-contain"
      >
        {VIEW_ORDER.map((id) => {
          const meta = VIEW_META[id];
          const active = id === view;
          return (
            <button
              key={id}
              type="button"
              data-nav={id}
              onClick={() => onViewChange(id)}
              aria-current={active ? 'page' : undefined}
              className={`flex min-h-11 items-center gap-3 rounded-md px-3 text-left text-body font-medium
                transition-colors duration-short ease-standard ${
                  active
                    ? 'bg-accent-soft font-semibold text-accent'
                    : 'text-ink-2 hover:bg-surface hover:text-ink'
                }`}
            >
              <Icon name={meta.icon} />
              {meta.label}
            </button>
          );
        })}
      </nav>

      <div className="flex shrink-0 flex-col gap-2 border-t border-line px-3 pt-4">
        <span className="text-label font-semibold tracking-[0.06em] text-ink-2">今日进度</span>
        <div className="tnum flex items-baseline gap-1 font-num">
          <b data-testid="side-done" className="text-h1 font-bold leading-none tracking-[-0.02em]">
            {progress.done}
          </b>
          <span data-testid="side-total" className="text-body-sm text-ink-2">
            / {progress.total}
          </span>
        </div>
        <ProgressFromDay progress={progress} size="sm" />
        <span className="mt-2 text-label text-ink-2">{dateLabel}</span>
      </div>

      <div className="flex shrink-0 flex-col gap-2 px-3">
        <p className="text-label leading-relaxed text-ink-2">
          先存本机，再同步云端
          <br />
          没网也能正常用
        </p>
      </div>
    </aside>
  );
});

/** 底部 4 Tab（<1024 宽度），与侧栏同源同序 */
export const MobileTabBar = memo(function MobileTabBar({
  view,
  onViewChange,
  progress,
  dateLabel,
  onSearch,
  topOffset = 0,
}: NavProps) {
  const online = useOnline();
  return (
    <>
      <header
        style={{ top: topOffset }}
        className="sticky z-30 flex h-14 items-center justify-between gap-2 border-b border-line
          bg-paper px-4 lg:hidden"
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <MangoMark size={24} className="shrink-0" />
          <span className="truncate text-body font-bold">芒果本本</span>
          {/*
            离线标记：只在**确定离线**时出现。
            在线时**不显示**"已在线"—— `navigator.onLine` 为真不代表能连上
            （认证门户 / 公司代理都会误报），说"已在线"等于撒谎。
          */}
          {online ? null : (
            <span
              data-testid="offline-chip"
              title="当前离线：改动会在联网后自动同步"
              className="chip chip-warn shrink-0 px-2 py-0.5"
            >
              离线
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            data-testid="nav-search-mobile"
            onClick={onSearch}
            aria-label="搜索"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-md text-ink-2 hover:bg-surface hover:text-ink"
          >
            <Icon name="search" size={16} />
          </button>
          <span className="tnum truncate text-body-sm text-ink-2">
            {dateLabel} · {progress.done}/{progress.total}
          </span>
        </div>
      </header>

      <nav
        aria-label="底部导航"
        // 列数跟着 TAB_VIEWS 走（6 个）：手机上每格 65px，比 7 个时的 55px 松快得多
        style={{ gridTemplateColumns: `repeat(${TAB_VIEWS.length}, minmax(0, 1fr))` }}
        className="tabbar fixed inset-x-0 bottom-0 z-30 grid border-t border-line
          bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden"
      >
        {TAB_VIEWS.map((id) => {
          const meta = VIEW_META[id];
          const active = id === view;
          return (
            <button
              key={id}
              type="button"
              data-nav={id}
              onClick={() => onViewChange(id)}
              aria-current={active ? 'page' : undefined}
              className={`flex min-h-14 flex-col items-center justify-center gap-1 text-label font-semibold
                transition-colors duration-short ease-standard ${
                  active ? 'text-accent' : 'text-ink-2'
                }`}
            >
              <Icon name={meta.icon} />
              {meta.label}
            </button>
          );
        })}
      </nav>
    </>
  );
});
