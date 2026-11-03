import { useId } from 'react';

/* ============================================================================
   品牌标记：芒果（主标志版）

   几何与 `scripts/build_icons.mjs` 同源，取自设计交付 `docs/brand/`。
   与应用图标的唯一区别：
   - 应用图标是"深墨绿底 + 底色描边的勾"（不透明，任何桌面都成立）
   - 这里是"透明底 + **镂空**的勾"（露出容器底色，像果肉被切开）

   镂空靠 mask 实现，不是把勾画成背景色 —— 这样放在米白、深色、甚至彩色底上
   都是对的；画成固定颜色的话，换个背景就会露馅。

   渐变 / mask 的 id 必须每实例唯一：侧栏与底部 Tab 会同时挂载两份，
   写死 id 会让后一份覆盖前一份（表现为其中一处果实变黑）。
   useId() 返回带冒号的字符串（":r1:"），冒号不能出现在 url(#...) 里，故剥掉。
   ========================================================================= */

const FRUIT =
  'M77.25 16.53 C82.09 20.59 86.31 27.17 87.81 33.41 C89.3 39.65 88.69 47.42 ' +
  '86.2 53.98 C83.71 60.53 78.43 67.41 72.87 72.72 C67.3 78.03 59.48 82.78 ' +
  '52.81 85.83 C46.14 88.87 38.59 90.82 32.83 90.98 C27.08 91.14 21.82 89.76 ' +
  '18.29 86.8 C14.76 83.84 12.49 78.9 11.65 73.2 C10.81 67.51 11.42 59.74 ' +
  '13.26 52.64 C15.09 45.54 18.42 37.01 22.68 30.61 C26.94 24.21 32.8 17.81 ' +
  '38.82 14.22 C44.84 10.63 52.39 8.68 58.8 9.07 C65.2 9.45 72.42 12.48 77.25 16.53 Z';

const LEAF = 'M70 32 C78 19 88 11 96 14 C94 23 84 31 70 32 Z';
const CHECK = 'M45 52 L54 63 L69 41';

export interface MangoMarkProps {
  /** 边长（px） */
  size?: number;
  className?: string;
}

export function MangoMark({ size = 28, className }: MangoMarkProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <defs>
        <linearGradient id={`g${uid}`} x1="14" y1="10" x2="86" y2="90" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FFDA66" />
          <stop offset="0.45" stopColor="#FFB32E" />
          <stop offset="1" stopColor="#FF8A3D" />
        </linearGradient>
        <mask id={`m${uid}`} maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
          <rect width="100" height="100" fill="#FFFFFF" />
          <path
            d={CHECK}
            stroke="#000000"
            strokeWidth="8.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </mask>
      </defs>
      {/* 叶先画、果身后画：叶根埋进果身内部，露出的部分从果肩自然长出 */}
      <path d={LEAF} fill="#1F6B4B" />
      <path d={FRUIT} fill={`url(#g${uid})`} mask={`url(#m${uid})`} />
    </svg>
  );
}
