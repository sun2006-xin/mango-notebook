import type { Config } from 'tailwindcss';

/**
 * Design Token → 原子类映射（ARCHITECTURE §7.3）。
 *
 * 关键点：颜色一律映射成 `rgb(var(--rgb-*) / <alpha-value>)`。
 * 只有这样才能让 `bg-accent/10`、`text-ink/60` 这类透明度修饰符真实生效
 * —— 若把变量直接存 `#16161D`，Tailwind v3 的 alpha 修饰符会失效。
 */
const c = (name: string): string => `rgb(var(--rgb-${name}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  // 深浅色只通过 [data-theme="dark"] 覆盖变量；dark: 变体仅为极少数例外保留
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      /**
       * 窄屏断点：Tailwind 默认最小是 sm(640)，而设计里有 420 / 360 两个降级点。
       * 放在这里是**唯一定义处**（组件里因此可以写 max-xs: / max-xxs:，不必出现 px 字面量）。
       */
      screens: { xs: '420px', xxs: '360px' },
      colors: {
        paper: c('paper'),
        surface: { DEFAULT: c('surface'), sunk: c('surface-sunk') },
        line: c('line'),
        ink: { DEFAULT: c('ink'), 2: c('ink-2'), 3: c('ink-3') },
        accent: {
          DEFAULT: c('accent'),
          hover: c('accent-hover'),
          press: c('accent-press'),
          soft: c('accent-soft'),
          on: c('on-accent'),
        },
        done: c('done'),
        /** 芒果金：只做点缀（专注环、连续打卡），不承担大面积背景 */
        highlight: c('highlight'),
        warn: c('warn'),
        danger: c('danger'),
        focus: c('focus'),
      },
      fontFamily: {
        sans: 'var(--font-sans)',
        num: 'var(--font-num)',
      },
      fontSize: {
        date: ['var(--type-date)', { lineHeight: 'var(--lh-date)', letterSpacing: 'var(--ls-date)' }],
        h1: ['var(--type-h1)', { lineHeight: 'var(--lh-h1)', letterSpacing: 'var(--ls-h1)' }],
        h2: ['var(--type-h2)', { lineHeight: 'var(--lh-h2)', fontWeight: '700' }],
        body: ['var(--type-body)', { lineHeight: 'var(--lh-body)' }],
        'body-sm': ['var(--type-body-sm)', { lineHeight: 'var(--lh-body-sm)' }],
        label: [
          'var(--type-label)',
          { lineHeight: 'var(--lh-label)', letterSpacing: 'var(--ls-label)', fontWeight: '600' },
        ],
        'num-lg': ['var(--type-num-lg)', { lineHeight: 'var(--lh-num)', fontWeight: '700' }],
      },
      spacing: {
        1: 'var(--space-1)',
        2: 'var(--space-2)',
        3: 'var(--space-3)',
        4: 'var(--space-4)',
        5: 'var(--space-5)',
        6: 'var(--space-6)',
        7: 'var(--space-7)',
        8: 'var(--space-8)',
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
        full: 'var(--radius-full)',
      },
      boxShadow: { 1: 'var(--shadow-1)', 2: 'var(--shadow-2)' },
      transitionTimingFunction: {
        spring: 'var(--ease-spring)',
        standard: 'var(--ease-standard)',
        decelerate: 'var(--ease-decelerate)',
        accelerate: 'var(--ease-accelerate)',
      },
      transitionDuration: {
        micro: 'var(--dur-micro)',
        short: 'var(--dur-short)',
        base: 'var(--dur-base)',
        long: 'var(--dur-long)',
      },
      maxWidth: { content: 'var(--content-max)', calendar: 'var(--content-max-calendar)' },
      minHeight: { 'week-col': 'var(--week-col-min-h)' },
      width: { drawer: 'var(--drawer-w)', sidebar: 'var(--sidebar-w)' },
      keyframes: {
        fadeUp: {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        drawerIn: {
          from: { opacity: '0', transform: 'translateX(100%)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        toastIn: {
          from: { opacity: '0', transform: 'translateY(12px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        shake: {
          '0%,100%': { transform: 'translateX(0)' },
          '25%': { transform: 'translateX(-4px)' },
          '75%': { transform: 'translateX(4px)' },
        },
      },
      animation: {
        fadeUp: 'fadeUp var(--dur-base) var(--ease-decelerate) both',
        drawerIn: 'drawerIn var(--dur-base) var(--ease-decelerate) both',
        toastIn: 'toastIn var(--dur-short) var(--ease-decelerate) both',
        shake: 'shake var(--dur-micro) var(--ease-standard) 2',
      },
    },
  },
  plugins: [],
} satisfies Config;
