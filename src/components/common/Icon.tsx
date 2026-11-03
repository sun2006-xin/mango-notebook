import type { ReactNode } from 'react';

/* ============================================================================
   内联图标集（ARCHITECTURE §1.5 裁决 D4）
   - 全部手写 <path>，1.5 描边宽度（样式在 index.css 的 .icon）
   - stroke="currentColor"：颜色由父级文字色（token 语义类）决定，图标本身不含色值
   - 不引 lucide-react / react-icons / 图标字体
   ========================================================================= */

export type IconName =
  | 'list'
  | 'calendar-week'
  | 'calendar'
  | 'settings'
  | 'plus'
  | 'check'
  | 'chevron-left'
  | 'chevron-right'
  | 'chevron-down'
  | 'more'
  | 'close'
  | 'trash'
  | 'sun'
  | 'moon'
  | 'book'
  | 'note'
  | 'image'
  | 'search'
  | 'timer'
  | 'play'
  | 'pause'
  | 'bell'
  | 'flame'
  | 'sparkle';

const PATHS: Record<IconName, ReactNode> = {
  // 图片（F4 插错题图）：一个相框 + 山线
  image: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M4.5 16.6l4.3-4.1 3.2 3 2.6-2.2 4.2 4.3" />
    </>
  ),
  // 今日（列表）
  list: <path d="M4 7h16M4 12h16M4 17h10" />,
  // 周（三列看板）
  'calendar-week': (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
      <path d="M9.2 5v14M14.8 5v14" />
    </>
  ),
  // 日历
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
      <path d="M3.5 10h17M8 3.5v3M16 3.5v3" />
    </>
  ),
  // 设置（齿轮）
  settings: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 3.5v2.2M12 18.3v2.2M4.9 7.8l1.9 1.1M17.2 15.1l1.9 1.1M4.9 16.2l1.9-1.1M17.2 8.9l1.9-1.1" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="M4.5 12.5l5 5L20 6.5" />,
  'chevron-left': <path d="M15 5l-7 7 7 7" />,
  'chevron-right': <path d="M9 5l7 7-7 7" />,
  'chevron-down': <path d="M5 9l7 7 7-7" />,
  // 三点菜单：三颗实心点用加粗描边画出，保持零 fill
  more: <path d="M5.5 12h.01M12 12h.01M18.5 12h.01" strokeWidth="2.6" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  trash: (
    <path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9L17.5 7M10 11v5M14 11v5" />
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4" />
    </>
  ),
  moon: <path d="M20 14.4A8.6 8.6 0 019.6 4a8.6 8.6 0 1010.4 10.4z" />,
  // 日记（记事本）：封面 + 三行文字
  note: (
    <>
      <path
        d="M7 3.5h7.5L19 8v10.5a1.5 1.5 0 01-1.5 1.5h-10A1.5 1.5 0 016 18.5v-13A1.5 1.5 0 017.5 3.5z"
        strokeLinejoin="round"
      />
      <path d="M14 3.5V8h4.5" strokeLinejoin="round" />
      <path d="M9 12h6M9 15.5h4.5" strokeLinecap="round" />
    </>
  ),
  book: (
    <>
      <path d="M5.5 4.5h10a2.5 2.5 0 012.5 2.5v12a2 2 0 00-2-2h-10.5z" />
      <path d="M8.5 8.5h6M8.5 12h6M8.5 15.5h3.5" />
    </>
  ),
  // 搜索（放大镜）
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </>
  ),
  // 专注（番茄钟）：表圈 + 顶部提钮 + 指针
  timer: (
    <>
      <circle cx="12" cy="13.5" r="7.5" />
      <path d="M9.5 3.5h5M12 3.5v2.5M17.6 7.6l1.5-1.5M12 13.5v-3.2" />
    </>
  ),
  play: <path d="M8 5.5l11 6.5-11 6.5z" />,
  pause: <path d="M9 5.5v13M15 5.5v13" />,
  // 闹钟（笔记提醒）：铃身 + 顶钮 + 两侧铃脚
  bell: (
    <>
      <path
        d="M12 4a5.5 5.5 0 015.5 5.5v3.3l1.5 3.2H5l1.5-3.2V9.5A5.5 5.5 0 0112 4z"
        strokeLinejoin="round"
      />
      <path d="M10 19a2 2 0 004 0M6.2 7.4L4.4 5.6M17.8 7.4l1.8-1.8" strokeLinecap="round" />
    </>
  ),
  // 连续打卡（火苗）
  flame: (
    <path d="M12 3.5s4.8 3.6 4.8 8.2a4.8 4.8 0 01-9.6 0c0-1.9.9-3.4 1.9-4.5.2 1.4.9 2.2 1.7 2.5.3-2.3.9-4.4 1.2-6.2z" />
  ),
  // 拆解（四角星）：与「已经算好」的动作区分开，不用魔法棒那种夸张造型
  sparkle: (
    <path d="M12 4.2l1.6 4.6 4.6 1.6-4.6 1.6L12 16.6l-1.6-4.6L5.8 10.4l4.6-1.6zM18 16.4l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" />
  ),
};

export interface IconProps {
  name: IconName;
  /** 边长（px 等值，作为 SVG 属性而非样式） */
  size?: number;
  className?: string;
}

export function Icon({ name, size = 18, className }: IconProps) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
