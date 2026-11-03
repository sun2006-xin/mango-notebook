# 芒果本本（Mango Notebook）

![芒果本本 GitHub 主视觉海报](assets/mango-notebook-github-banner.jpg)

**离线优先的个人学习规划应用。** 把每日任务、周计划、专注计时、学习笔记与日记放在一起，按自己的节奏推进。

**Mango Notebook** is an offline-first personal learning planner for daily tasks, weekly planning, focus sessions, study notes, and journaling.

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

## 功能

- **今日任务**：规划待办、查看完成进度，并按日期和分类组织任务。
- **周计划与日历**：安排一周的学习计划，并从日历中回看任务。
- **专注计时**：使用番茄钟、秒表和提醒记录专注过程。
- **学习笔记与间隔复习**：整理错题和学习笔记，根据复习评价安排下一次回顾。
- **日记与周报**：用 Markdown 记录学习过程，回顾阶段进展。
- **习惯与作息**：记录习惯打卡和作息安排。
- **数据备份**：导入、导出 JSON / Markdown；桌面版支持自动备份。

## 平台与数据

| 版本 | 登录与数据方式 |
| --- | --- |
| 网页版 | 已部署版本保留项目方登录与同步。 |
| Windows | 默认开源版本不提供项目方账号登录，数据保存在本机。 |
| Android | 默认开源版本不提供项目方账号登录，数据保存在本机。 |

Windows 和 Android 可通过导入 / 导出备份迁移数据。源码保留自有服务器接入路径：使用者配置自己的服务并自行构建客户端。当前自有服务配置在构建时完成；已安装客户端没有修改服务器地址的设置页。详见 [`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md)。

## 开始使用

需要 Node.js 和 npm。克隆仓库后，在项目根目录运行：

```bash
npm ci
npm run dev
```

常用检查和构建命令：

```bash
npm test
npm run typecheck
npm run build
npm run web:build
```

桌面端和 Android 开发构建命令：

```bash
npm run desktop:dev
npm run desktop:exe
npm run desktop:build
npm run android:sync
```

自有服务器客户端的构建步骤、环境变量说明和安全边界见 [`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md)。本仓库不包含项目方部署配置、登录凭据或 Android 签名密钥；自建服务请只使用你自己的配置和密钥。

## 技术栈

React、TypeScript、Vite、Electron 与 Capacitor。Web、Windows 和 Android 共用 `src/` 中的应用逻辑，平台层分别由 Electron 和 Capacitor 提供。

## 许可证

本项目以 Apache License 2.0 开源，详见 [`LICENSE`](LICENSE)。
