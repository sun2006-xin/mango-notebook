# 使用自有云服务

本指南描述当前源码中的配置方式：**自有服务通过构建时 `.env.local` 配置接入**，不提供在已安装应用里动态修改服务器地址的设置页面。

这样设计的原因：CSP 的 `connect-src` 是构建期注入的、Android WebView 的 origin 与 OAuth 回调钉在 `server.hostname` 上；而「装好的客户端可以填任意服务器地址」会形成一个新的数据外发面。因此官方 Windows / Android 默认版本始终是纯本地应用，接入自有服务需要自行构建。

## 版本边界

- 项目方已部署的 Web 版本保留现有登录与同步。本仓库不包含该部署使用的 `.env.local`。
- 默认 Windows / Android 客户端构建使用本地存储，不注入项目方云配置，也不显示项目方云登录入口。
- 使用者可以用自己的服务配置构建一个客户端版本。当前客户端 SDK 是 `@tencent-ai/workbuddy-cloud-sdk`；其他 API 需要在 `src/lib/cloud.ts` 替换或实现兼容适配层。

## 配置

从模板复制本地配置文件：

```powershell
Copy-Item .env.example .env.local
```

在 `.env.local` 中填写你自己的服务配置：

- `VITE_CLOUD_ENDPOINT`：HTTPS 服务 origin，不带路径、查询参数或凭据。
- `VITE_CLOUD_KEY`、`VITE_CLOUD_RESOURCE_ID`：由你自己的云服务提供。
- `VITE_CLOUD_OAUTH_RELAY`、`VITE_CLOUD_OAUTH_ORIGIN`：按你的认证服务配置。
- `VITE_ANDROID_CLOUD_MODE=1`：仅在为 Android 构建自有云客户端时开启。留空时 Android 壳使用 `localhost`，不会把本机 `.env.local` 中的 endpoint 写入默认客户端配置。

`.env.local`、Android 签名文件和用户数据不应提交或放入公开压缩包。

## Windows 自有云版本

从自己的 `.env.local` 构建并打包，一步到位：

```powershell
npm run desktop:exe:cloud
```

它等价于 `desktop:build:cloud` + `electron-builder`，但**不要**改用 `npm run desktop:exe`：
后者第一步会重跑 `--mode client`，把刚生成的云产物整块覆盖掉，装出来的包会静默变回纯本地且不报错。
只有云配置存在时，客户端才会显示登录入口；没有配置的默认发行版本仍是纯本地应用。

## Android 自有云版本

先在 `.env.local` 设置自有服务配置和 `VITE_ANDROID_CLOUD_MODE=1`，然后：

```powershell
npm run android:sync:cloud
```

它等价于 `desktop:build:cloud` + `npx cap sync android`，保证 WebView 拿到的是云构建产物、
且 origin 与该配置对应。正式签名需要使用者自己的密钥；仓库不提供也不应接收签名密钥。

## Web 自行部署

自行部署 Web 版本时，用自己的 `.env.local` 配置并构建：

```powershell
npm run web:build
```

本项目现有的 Web 部署继续由维护者管理；开源仓库不含其运行配置，克隆仓库也不会连到维护者的服务。

## 数据权限

客户端中的 endpoint、resource ID 或 publishable key 只用于定位服务，不能代替服务端授权。自建服务必须实现账号认证、用户数据隔离和备份策略；客户端来源检查与 CORS 不能当作数据权限边界。
