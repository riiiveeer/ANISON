# ANISON 部署与更新方案

公网 Node 网页版、手机 PWA、安全、测试、Render 上线和回滚的完整实施步骤见 [公网 Node 网页版与手机 PWA 施工方案](public-web-pwa-construction-plan.md)。

阶段 C 的可安装 PWA、离线 App Shell、更新生命周期和真实设备验收详见 [阶段 C 应用化施工方案](stage-c-pwa-appization-plan.md)。

## 三种运行方式

| 方式 | 服务运行位置 | 可访问范围 | 网易云导入 | 用户更新方式 |
| --- | --- | --- | --- | --- |
| 本机版 | 用户电脑 | 当前电脑 | 可用 | 拉取/下载新版后重新启动 |
| 局域网版 | 用户电脑 | 同一 WiFi | 可用 | 电脑更新后，手机刷新网页 |
| 公网 Node 网页版 | 云服务器 | 互联网 | 可用 | 服务部署后，用户刷新网页 |
| GitHub Pages 静态版 | GitHub 静态 CDN | 互联网 | 不可用 | 推送并部署后，用户刷新网页 |

## Node 网页版与局域网版的区别

两者运行的是同一套前端和网易云代理代码，主要区别是 Node 服务在哪里运行：

- 局域网版运行在用户电脑上，不需要云服务器；电脑必须开机并保持命令行服务运行。
- 公网 Node 网页版运行在长期在线的服务器上，用户不需要安装 Node，也不必与服务器处于同一 WiFi。
- 公网版本必须额外处理 HTTPS、域名、访问限流、日志脱敏、故障监控和上游接口压力。
- 两种方式的 IndexedDB 都保存在访问者自己的浏览器中。部署位置变化不会自动同步学习数据。

## 为什么 GitHub Pages 不能承载完整版本

GitHub Pages 负责提供构建后的 HTML、CSS、JavaScript 和图片，不会持续运行本项目的 Node 代码。因此浏览器请求 `/api/netease/preview` 或 `/api/deepseek` 时没有服务器处理，网易云链接导入和 AI 讲解都不可用。

可选择：

1. 暂时把 GitHub Pages 作为不含网易云导入的演示版。
2. 把完整项目部署到支持 Node.js 长期运行的云平台。
3. 前端部署到静态平台，网易云代理单独部署为服务端函数，并配置固定 API 地址。

当前最稳妥的公开测试路线是第二种，等接口稳定后再考虑前后端分离。

## 本地验证生产服务

项目使用 Node.js 24 LTS。安装依赖并构建后，可用正式生产入口验证前端与健康检查是否由同一端口提供：

```bash
npm ci
npm run build
npm start
```

默认监听 `0.0.0.0:3000`，也可通过 `PORT` 环境变量指定端口。打开 `http://localhost:3000` 访问应用，`http://localhost:3000/healthz` 返回版本和部署提交信息。

当前生产入口已经完成静态资源托管、缓存策略、健康检查、优雅退出，以及网易云和 DeepSeek 的正式生产路由。`npm run dev` 与 `npm start` 使用同一套 API 处理逻辑；阶段 C 还会在生产构建中生成版本化 `sw.js`，开发服务器不会注册 Service Worker。

生产资源缓存规则：

- 哈希 JS/CSS：`public, max-age=31536000, immutable`；
- `index.html`、manifest、图标和 `sw.js`：`no-cache`；
- API：`no-store`，且 Service Worker 明确使用 Network Only；
- 用户歌曲、歌词、进度和 Key 不进入 Cache Storage。

## 阶段 B 环境配置

复制 `.env.example` 仅用于查看变量说明；本项目不会自动读取 `.env`，本地可在当前 shell 设置，Render 则在服务的 Environment 页面配置。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 生产 Node 服务监听端口 |
| `BETA_AUTH_USERNAME` | 空 | 与密码同时存在时启用 Beta 门禁 |
| `BETA_AUTH_PASSWORD` | 空 | 只配置用户名或密码之一会导致启动失败 |
| `CSP_MODE` | `report-only` | 可设为 `report-only` 或 `enforce` |

不要配置服务端 DeepSeek Key。用户在浏览器填写自己的 Key，请求经 ANISON Node 服务转发，但不会被服务器保存、缓存或写入日志。

Beta 门禁首次使用浏览器 Basic Auth，验证成功后换取 12 小时的 HttpOnly、SameSite=Strict Cookie；生产 Cookie 带 `Secure`。服务重启、Cookie 到期或切换域名后需要重新验证。`/healthz` 始终免鉴权，DeepSeek 继续独占 `Authorization: Bearer`。

## 阶段 D：Render Blueprint 部署

根目录 `render.yaml` 是唯一部署契约：Singapore、Free、Node、`main`、`npm ci && npm run build`、`npm start`、`/healthz` 和 `checksPass` 均由版本库声明。Node 精确版本来自 `.node-version`，不要在 Render Dashboard 额外设置优先级更高的 `NODE_VERSION`。

首次创建前必须确认 GitHub `main` 已要求以下三个检查：

- `test-and-build`
- `browser-e2e-and-performance`
- `production-pwa`

在 Render Dashboard 选择 Blueprint 并连接 `riiiveeer/ANISON`，服务名优先使用 `anison-web`；若冲突则固定使用 `anison-web-riiiveeer`。创建页面必须现场填写 `BETA_AUTH_USERNAME` 和 `BETA_AUTH_PASSWORD`，两项均保存到运营者自己的密码管理器。不要添加 `PORT`、服务端 DeepSeek Key、网易云 Cookie、数据库、磁盘或定时探活。

首次环境固定为：

| 项目 | 值 |
| --- | --- |
| Region / Plan | Singapore / Free |
| Branch | `main` |
| Auto Deploy | After CI Checks Pass |
| `NODE_ENV` | `production` |
| `CSP_MODE` | `report-only` |
| Health Check | `/healthz` |

Blueprint 中 `sync: false` 的变量只会在首次创建时提示输入；为既有服务新增或轮换 Secret 时必须在 Dashboard 的 Environment 页面操作。

### 只读部署冒烟

固定 Origin 创建后，先在不设置凭据的 shell 验证公开边界：

```powershell
$env:ANISON_DEPLOYMENT_URL = 'https://<service>.onrender.com'
npm run verify:deployment
```

随后在临时 shell 中设置 Beta 凭据并执行完整验证。不要把真实值写入 `.env`、命令脚本、Issue 或截图；运行完成后清除环境变量。

```powershell
$env:BETA_AUTH_USERNAME = Read-Host 'Beta username'
$env:BETA_AUTH_PASSWORD = Read-Host 'Beta password'
$env:ANISON_EXPECTED_VERSION = '1.0.0-beta.4'
$env:ANISON_EXPECTED_COMMIT = '<full main commit SHA>'
$env:ANISON_EXPECTED_CSP = 'report-only'
npm run verify:deployment
Remove-Item Env:BETA_AUTH_USERNAME, Env:BETA_AUTH_PASSWORD, Env:ANISON_EXPECTED_VERSION, Env:ANISON_EXPECTED_COMMIT, Env:ANISON_EXPECTED_CSP -ErrorAction SilentlyContinue
```

验证器最多等待 90 秒唤醒 Free 实例；服务已唤醒后的健康请求预算为 5 秒。它不会请求真实网易云或 DeepSeek，也不会打印凭据、Cookie、Authorization、歌词或 Key。

### CSP 强制与部署记录

完成首页、导入、学习、复习、设置、安装、更新和第三方封面检查，且浏览器控制台与 Render 日志没有真实 CSP 违规后，才把 Dashboard 中的 `CSP_MODE` 改为 `enforce`。重新部署后设置 `ANISON_EXPECTED_CSP=enforce` 再跑完整冒烟。

公开记录只包含 canonical Origin、部署提交、BUILD_ID、部署时间、冷启动时间和验收结果。Render Service ID、Beta 凭据、用户内容和上游 Key 保存在公开仓库之外。

## 公网接口限制

| 接口 | 请求体 | IP 限制 | 上游超时 |
| --- | --- | --- | --- |
| `POST /api/netease/preview` | 8 KiB；输入 4096 字符 | 20 次 / 10 分钟 | 15 秒 |
| `POST /api/deepseek/chat/completions` | 64 KiB；最多 800 tokens | 60 次 / 10 分钟 | 45 秒 |

API 只接受精确同源浏览器请求，并要求前端自动发送 `X-ANISON-Request: 1`。响应不缓存，错误使用固定中文结构；内存限流、网易云缓存和 Beta 会话都会在进程重启后清空。

## 公网故障排查

- `401 BETA_AUTH_REQUIRED`：先访问首页完成 Basic 验证；若刚重启或已超过 12 小时，需要重新输入。
- `401 DEEPSEEK_UNAUTHORIZED`：用户自己的 DeepSeek Key 无效或已过期。
- `403 ORIGIN_REJECTED` / `CSRF_HEADER_REQUIRED`：检查是否经同一域名访问，反向代理是否保留 `Host` 与正确的 HTTPS 协议，以及前端是否为同一版本。
- `429 RATE_LIMITED`：按 `Retry-After` 等待；Beta 的限制按单进程客户端 IP 计算。
- `503 UPSTREAM_BUSY`：网易云队列已满或排队超时，稍后重试。
- `504 UPSTREAM_TIMEOUT`：上游未在预算内响应；本地 LRC、曲库和学习功能不受影响。
- CSP Report-Only 报告：先确认来源是否为本站、`data:` 或受信任网易云封面域名；不要为消除报告而加入通配来源。完成真实 HTTPS 冒烟前不要切换 `enforce`。
- 生产日志仅应出现 requestId、方法、路径、状态、耗时和错误码；若部署平台记录请求头或请求体，应在平台侧关闭或脱敏。

## 推荐发布流程

1. 功能分支开发并创建 Pull Request。
2. GitHub Actions 执行 `npm ci`、测试、构建和依赖审计。
3. 合并到 `main`。
4. 更新 `CHANGELOG.md`；只有应用行为变化时才更新 `package.json` 版本号，纯部署或文档提交保持当前业务版本。
5. 创建 `vX.Y.Z` 标签和 GitHub Release。
6. 自动部署到测试环境，完成网易云导入和移动端冒烟测试。
7. 部署正式环境。

## 用户及时收到更新

### GitHub 用户

- 在仓库中选择 `Watch → Custom → Releases`。
- 每次正式发布创建 GitHub Release，并提供清晰的更新说明。

### 网页/PWA 用户

- 服务端发布新版本后，用户继续访问同一个网址。
- Service Worker 发现新资源后显示应用内“发现新版本”提示，不强制打断学习。
- 用户点击“立即更新”后切换 worker 并只刷新一次；导入、歌曲保存和备份恢复期间按钮会暂时禁用。
- 用户选择“稍后”时，本次会话继续使用旧版本，下次启动仍可收到提示。

### 未来 Android/iOS 用户

- 优先通过 Google Play 或 App Store 分发，由应用商店处理自动更新。
- 正式版本先小比例发布，确认错误率正常后再扩大范围。

## 数据兼容原则

- 发布新版不得主动清空 IndexedDB。
- 数据结构升级必须提供向前迁移。
- 破坏性迁移前要求用户导出备份。
- 新版读取旧备份时应先校验 `schemaVersion` 并预览覆盖范围。

## PWA 故障与回滚

1. 在 Render Deploys 明确选择目标成功部署，不使用模糊的“上一版”判断。
2. 回滚时保持 `/sw.js` 和 manifest `id: "/"` 不变，让已安装客户端能够取得恢复 worker。
3. 回滚 worker 只能清理 `anison-shell-`、`anison-runtime-` 缓存，不得删除 IndexedDB 或 localStorage。
4. 若缓存逻辑本身故障，发布不拦截 fetch 的 pass-through worker，激活后通知客户端刷新。
5. 回滚后运行部署验证器，并手工验证离线 App Shell、两条真实 API 边界和 IndexedDB 数据；Beta 401 不得被离线 HTML 掩盖。
6. Render Dashboard Rollback 会暂停 Auto Deploy；确认故障被隔离后，人工部署最新已验证提交并恢复 `checksPass`。
7. 域名变化前先从旧 Origin 导出备份，再在新 Origin 恢复；安装 PWA 不会迁移 Origin 数据。
