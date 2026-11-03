/**
 * PostCSS 链路：Tailwind 编译 + 前缀补全。
 * package.json 声明了 "type": "module"，因此这里用 ESM 默认导出
 * （写成 module.exports 会被当作 ESM 解析而报错）。
 */
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
