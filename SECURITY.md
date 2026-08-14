# 安全策略

## 支持范围

当前只有最新 `main` 分支和最新 GitHub Release 会接受安全修复。朋友测试阶段不承诺旧提交获得长期补丁。

## 私下报告漏洞

请不要通过公开 Issue 报告以下内容：

- 泄露的 API Key、Token 或个人数据
- 可执行脚本注入或绕过文本净化的问题
- 网易云代理的 SSRF、域名校验或跳转校验绕过
- 可导致他人学习数据被读取、覆盖或删除的问题
- 公网部署中的鉴权、限流或日志泄露

仓库公开并启用 GitHub Private Vulnerability Reporting 后，请使用仓库的 `Security → Report a vulnerability` 表单。启用前，可以先创建一个不包含漏洞细节的普通 Issue，请维护者提供私下联系方式。

报告中请包含受影响版本、复现条件、影响范围和建议修复方式，但不要包含真实用户密钥或完整私人歌词。

## 密钥处理

- 不要把 DeepSeek Key 写入源码、测试夹具、`.env`、Issue、截图或日志。
- 一旦密钥误提交，应立即在服务提供方撤销并重新生成；仅从 Git 历史删除并不足以恢复安全。
- 公网运营者不得把共享生产密钥打包进前端资源。
- ANISON 服务端不会读取 DeepSeek Key 环境变量；每次 AI 请求只转发当前用户的 Bearer Key，且不得保存、缓存或记录该请求头。

## 公网安全配置

- `BETA_AUTH_USERNAME` 与 `BETA_AUTH_PASSWORD` 必须同时配置；只配置一项时服务会拒绝启动。首次 Basic 验证成功后换取 12 小时的 HttpOnly、SameSite=Strict 会话 Cookie，服务重启后会话失效。
- `/healthz` 始终免鉴权；其余页面、静态资源和 API 在门禁启用时均受保护。
- 两条浏览器 POST API 同时校验精确同源 `Origin` 与 `X-ANISON-Request: 1`，不开放 CORS。
- 生产服务只信任一层反向代理。部署平台必须覆盖客户端提供的 `X-Forwarded-*` 头，避免 IP 限流被伪造。
- CSP 默认使用 Report-Only；确认生产报告没有正常流程违规后，设置 `CSP_MODE=enforce` 强制执行。
- Beta 限流、缓存和会话均在单进程内存中，服务重启会清空；它们不替代部署平台的 HTTPS、边缘限流和监控。
- Service Worker 只缓存构建清单内的同源 GET 静态资源；`/api/*`、Authorization、非 GET、第三方封面和未知路径不进入 Cache Storage。
- Worker 更新不自动 `skipWaiting`。用户确认前继续运行旧版本，导入、编辑和恢复期间禁止触发刷新；缓存清理只能删除 `anison-shell-` 和 `anison-runtime-` 前缀。
- `sw.js` 必须保持 `no-cache` 和根 scope。紧急恢复 worker 不得调用 `indexedDB.deleteDatabase`、`localStorage.clear()` 或业务清空接口。
