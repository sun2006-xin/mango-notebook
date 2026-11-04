<div align="center">
  <img src="assets/mango-notebook-github-banner.jpg" alt="芒果本本：离线优先的个人学习规划应用" width="100%" />

  <p><strong>把计划、专注、复习与复盘，连成每天可持续的学习节奏。</strong></p>
  <p>个人学习规划工具 · Web · Windows · Android</p>

  <p>
    <a href="#功能导览">功能导览</a> ·
    <a href="#平台与数据">平台与数据</a> ·
    <a href="#获取版本">获取版本</a> ·
    <a href="#开发与构建">开发与构建</a>
  </p>

  <p>
    <a href="https://github.com/sun2006-xin/mango-notebook/releases">查看 Releases</a> ·
    <a href="https://github.com/sun2006-xin/mango-notebook">浏览源码</a>
  </p>

  <p>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache--2.0-3d7a55?style=flat-square" alt="Apache-2.0 license" /></a>
    <img src="https://img.shields.io/badge/platform-Web%20%7C%20Windows%20%7C%20Android-456d59?style=flat-square" alt="Web, Windows, Android" />
    <img src="https://img.shields.io/badge/storage-offline--first-e8a928?style=flat-square" alt="Offline-first" />
  </p>
</div>

> **图片说明：** 主视觉和功能图均为生成式产品示意图，不是当前软件的实机截图或兼容性证明。示意图中的文字和界面细节仅用于展示产品方向，具体功能以源码和实际版本为准。

## 芒果本本是什么

芒果本本是一款离线优先的个人学习规划应用。它把每日待办、周计划、专注计时、学习笔记、间隔复习、Markdown 日记、习惯和作息记录放在一个连贯的工作流中。

| 从今天开始 | 持续推进 | 回看过程 |
| --- | --- | --- |
| 把任务拆到每天，记录预计用时与完成情况。 | 用专注计时留下投入，把笔记和错题加入复习。 | 通过日记、习惯与周回顾观察自己的节奏。 |

## 功能导览

<table>
  <tr>
    <td width="50%" valign="top">
      <strong>01 · 今日任务</strong><br />
      查看当天待办、已完成进度和到期复习；按日期与分类安排任务，并记录预计用时和实际专注。
      <br /><br />
      <img src="assets/features/today-tasks.png" alt="今日任务与完成进度示意图" width="100%" />
    </td>
    <td width="50%" valign="top">
      <strong>02 · 周计划</strong><br />
      先排出一周的学习骨架，再调整每天的安排；可按周模板复用计划。
      <br /><br />
      <img src="assets/features/weekly-plan.png" alt="周计划示意图" width="100%" />
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <strong>03 · 日历安排</strong><br />
      按月或按周浏览任务，选择日期查看当天安排，掌握近期进度。
      <br /><br />
      <img src="assets/features/calendar.png" alt="日历和当日任务示意图" width="100%" />
    </td>
    <td width="50%" valign="top">
      <strong>04 · 专注规划</strong><br />
      从任务进入专注，回看当天与本周的投入情况；目标和计时偏好可在设置中调整。
      <br /><br />
      <img src="assets/features/focus-planning.png" alt="任务规划与专注统计示意图" width="100%" />
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <strong>05 · 番茄钟与秒表</strong><br />
      选择番茄钟或秒表记录学习时段，让专注时间与任务进展对应起来。
      <br /><br />
      <img src="assets/features/focus-timer.png" alt="番茄钟和秒表示意图" width="100%" />
    </td>
    <td width="50%" valign="top">
      <strong>06 · 笔记与间隔复习</strong><br />
      用标签整理笔记、错题和待记内容；先尝试回忆，再按掌握程度安排后续复习。
      <br /><br />
      <img src="assets/features/notes-review.png" alt="学习笔记与间隔复习示意图" width="100%" />
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <strong>07 · 习惯与作息</strong><br />
      每日打卡并在日历中回看记录，也可登记起床和睡觉时间，观察作息变化。
      <br /><br />
      <img src="assets/features/habits-routine.png" alt="习惯打卡与作息示意图" width="100%" />
    </td>
    <td width="50%" valign="top">
      <strong>08 · Markdown 日记</strong><br />
      用 Markdown 记录学习过程；周回顾可汇总任务和专注情况，并写入对应日期的日记。
      <br /><br />
      <img src="assets/features/diary.png" alt="Markdown 日记与周回顾示意图" width="100%" />
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <strong>09 · 一套连贯的学习流程</strong><br />
      从每日任务开始，记录专注，复习学习内容，再留下日记与回顾。
      <br /><br />
      <img src="assets/features/task-workflow.png" alt="任务、专注、复习和复盘工作流示意图" width="100%" />
    </td>
    <td width="50%" valign="top">
      <strong>10 · 多端产品形态</strong><br />
      项目包含 Web、Windows 桌面和 Android 客户端，共用主要应用逻辑。
      <br /><br />
      <img src="assets/features/cross-platform.png" alt="Web、Windows 和 Android 多端示意图" width="100%" />
    </td>
  </tr>
</table>

## 平台与数据

| 版本 | 登录与存储 | 说明 |
| --- | --- | --- |
| Web | 已部署版本保留项目方登录与云端同步。 | 登录和云存储由项目方的私有服务提供。 |
| Windows | 默认开源客户端不提供项目方账号登录，数据保存在本机。 | 支持本地使用与数据备份。 |
| Android | 默认开源客户端不提供项目方账号登录，数据保存在本机。 | 可按自己的需要管理和迁移本地数据。 |

项目方托管的 Web 实例使用手机号验证码登录，数据保存在项目方自有云服务中。该实例的数据库策略、数据留存和账号删除规则不属于本仓库，也未由第三方独立核验；开源源码不包含该实例的凭据或运行配置。

源码保留自有服务接入路径：使用者可以在构建时配置自己的服务并自行构建客户端。**已安装的 Windows / Android 客户端没有运行时更换服务器地址的设置页。**自建服务还需要自行实现账号认证、用户数据隔离、备份与删除策略。配置说明见 [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md)。

数据导入、导出、桌面自动备份等说明见 [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md)。请勿把个人 <code>.env.local</code>、服务密钥、Android 签名文件或真实用户数据提交到公开仓库。

## 获取版本

- [打开 GitHub Releases](https://github.com/sun2006-xin/mango-notebook/releases)，查看每个版本实际提供的源码与安装包。
- 当前 <strong>v0.31.2</strong> Release 提供源码；Windows 与 Android 安装包尚未附加到该版本。请以 Releases 页面列出的文件为准。

## 开发与构建

需要 Node.js 与 npm。在项目根目录运行：

~~~bash
npm ci
npm run dev
~~~

常用开发命令：

~~~bash
npm test
npm run typecheck
npm run build
npm run web:build

# Windows 桌面端
npm run desktop:dev
npm run desktop:build
npm run desktop:exe

# Android
npm run android:sync
~~~

这些命令表示仓库提供相应脚本，不代表每种系统环境和构建产物都已在本次发布中逐一验收。自有服务器客户端的环境变量与构建步骤请先阅读 [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md)。

<details>
  <summary>技术栈与 English summary</summary>

  <p><strong>技术栈：</strong> React、TypeScript、Vite、Electron、Capacitor。Web、Windows 和 Android 共用主要应用逻辑，平台能力由 Electron 与 Capacitor 提供。</p>

  <p><strong>English:</strong> Mango Notebook is an offline-first personal learning planner for daily tasks, weekly plans, focus sessions, spaced-repetition notes, journaling, habits, and routines. The hosted Web version supports project login and sync. Default Windows and Android clients store data locally and do not include project login. Self-hosted clients require build-time configuration. The project is licensed under Apache-2.0.</p>
</details>

## 许可证

本项目采用 [Apache License 2.0](LICENSE)。
