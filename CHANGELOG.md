# Changelog

本项目使用语义化版本号。尚未发布的变化记录在 `Unreleased` 中，创建 GitHub Release 时再移动到对应版本。

## Unreleased

### Added

- 可安装 manifest、192/512/maskable/Apple 图标和生产构建时生成的版本化 Service Worker。
- 离线 App Shell、本地学习降级、全局网络/更新提示和设置页“应用与更新”卡片。
- 关键操作更新锁，以及独立生产 PWA Chromium 离线与 waiting worker E2E。
- Express 5 生产服务底座，同一端口提供构建后的前端、`/healthz` 和明确的 API 404。
- 生产服务器集成测试，覆盖静态缓存策略、入口启动和优雅关闭。
- Vite/Express 共用的网易云与 DeepSeek 中间件、统一 API 错误结构、请求上下文和脱敏日志。
- Helmet、Compression、CSP Report-Only/Enforce 切换及可选 Beta Basic-to-Cookie 门禁。
- Render Singapore Free Blueprint、Blueprint 秘密约束测试和 CI 通过后自动部署契约。
- 固定 HTTPS 只读部署验证器，覆盖冷启动、Beta 401、静态缓存、PWA 元数据、安全头和 API JSON 边界。

### Changed

- 应用版本升级为 `1.0.0-beta.3`；Service Worker 更新改为用户确认后激活并只刷新一次。
- 网易云解析和 AI 请求在明确离线时直接返回可重试提示，不发起上游请求。
- Node.js 与 GitHub Actions 运行基线升级到 Node 24 LTS；`npm start` 改为正式生产入口。
- 网易云公网限制调整为每 IP 十分钟 20 次、15 秒总超时；DeepSeek 增加严格模型/消息校验、45 秒取消和每 IP 十分钟 60 次限制。

### Fixed

- 修复 IndexedDB v3 按字符串卡片 ID 读取网易云歌词，导致跨秒数位变化时歌词时间轴错乱的问题。
- 修复从曲库打开歌曲时总是跳回上次位置，而不是第一张未学日语歌词卡的问题。

## 1.0.0-beta.2 - 2026-07-31

### Added

- IndexedDB v3 无损、可续跑的阻塞式升级，按歌曲原子迁移歌词、卡片、学习单元和进度。
- schema v2 分批备份恢复，兼容 v1 导入，并在取消、失败或重启时自动回滚。
- Chromium 核心流程与 1,000 首/80,000 卡性能门禁。

### Changed

- 首页、曲库和复习页切换为轻量摘要与索引查询；曲库首批显示 50 首，复习会话最多缓冲 50 条。
- 网易云请求增加同歌曲合并、500 条 LRU、并发/排队保护和真实 socket IP 令牌桶限流。
- 大型写入、歌词替换、歌曲删除和学习打分改为跨存储原子事务。

### Fixed

- 避免启动、搜索、复习和设置页为统计信息加载完整歌词卡。
- 修复歌词替换时未变化卡片的学习状态可能丢失的问题。

## 1.0.0-beta.1 - 2026-07-27

### Added

- 网易云公开单曲歌词预览、三轨对齐与来源去重导入。
- 单卡学习与上下滚动连读两种模式。
- 曲库封面、搜索、编辑、删除和数据备份恢复。
- GitHub Actions 自动测试、构建和高危依赖审计。
- Apache License 2.0、NOTICE 和公开仓库协作说明。

### Changed

- 纯英文歌词保留在全文中，但不占日语学习进度且不进入复习。
- 相同日语歌词合并为一个学习单元，共享 AI 讲解、学习状态和复习计划。
- 首次学习后次日复习；忘记或模糊七日后再复习；掌握后结束复习。

### Fixed

- 修复网易云模型名称、歌词导入空元数据和复习筛选等问题。
- 优化移动端学习按钮、曲库封面与导入反馈。
