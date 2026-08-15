# ANISON

[![CI](https://github.com/riiiveeer/ANISON/actions/workflows/ci.yml/badge.svg)](https://github.com/riiiveeer/ANISON/actions/workflows/ci.yml)

ANISON 是一款面向日语歌曲歌词的本地优先学习工具。你可以导入 LRC 或网易云公开单曲歌词，在单卡和连读两种模式中熟悉歌词，并通过次日复习巩固真正需要学习的日语句子。

> 当前状态：`1.0.0-beta.1` 测试版。数据结构和交互仍可能调整，更新前建议先在设置页导出完整备份。

## 主要功能

- 网易云公开单曲链接、分享文本和歌曲 ID 导入
- 本地单个/批量 `.lrc` 文件与粘贴歌词导入
- 原文、中文翻译、罗马音时间轴对齐
- 单卡专注学习与上下滚动连读
- AI 歌词讲解、缓存、追问和重试
- 本地曲库、封面、搜索、编辑和删除
- 学习进度、收藏、次日复习和三档复习反馈
- 纯英文歌词不占日语进度；相同日语歌词只学习和复习一次
- IndexedDB 本地存储以及完整数据导出、清空和恢复
- 同一 WiFi 下的手机访问

## 三分钟开始

环境要求：Node.js 20 或更高版本、npm、支持 IndexedDB 的现代浏览器。

```bash
git clone https://github.com/riiiveeer/ANISON.git
cd ANISON
npm ci
npm run dev
```

打开终端显示的 `Local` 地址。Windows 用户安装依赖后也可以双击 `启动ANISON.cmd`。

### 同一 WiFi 手机访问

```bash
npm run dev:lan
```

手机和电脑连接同一 WiFi，在手机浏览器打开终端显示的 `Network` 地址，例如 `http://192.168.1.20:3000`。如果连接失败，请确认 Windows 防火墙已允许 Node.js 访问“专用网络”。

完整的朋友测试步骤与反馈模板见 [测试指南](docs/testing-guide.md)。

## 学习规则

- 第一次看完 AI 讲解并切换到下一张后，该日语学习单元记为已学，安排次日复习。
- 纯英文段落仍出现在完整歌词中，但不要求 AI 讲解，也不计入日语进度或复习。
- 规范化后相同且翻译相同的日语句子共用 AI 讲解、学习状态和复习计划。
- 次日复习选择“忘记”或“模糊”时，七天后再次复习；选择“掌握”后不再安排。

## 运行方式

| 命令 | 用途 | 可访问范围 |
| --- | --- | --- |
| `npm run dev` | 本机开发和测试 | 当前电脑 |
| `npm run dev:lan` | 手机联调 | 同一局域网 |
| `npm run build` | 生成生产静态资源 | 输出到 `dist` |
| `npm run preview:lan` | 在局域网预览构建结果 | 同一局域网 |
| `npm test` | 运行自动测试 | 本机/CI |
| `npm run check` | 测试、构建和高危依赖审计 | 本机/CI 前检查 |

## 架构与数据流

```mermaid
flowchart LR
    A["浏览器界面"] --> B["IndexedDB 曲库与进度"]
    A --> C["/api/netease/preview"]
    C --> D["本机或公网 Node 服务"]
    D --> E["网易云公开歌词接口"]
    A --> F["/api/deepseek"]
    F --> D
    D --> G["DeepSeek API"]
```

歌曲、歌词和学习进度默认只保存在访问者当前浏览器的 IndexedDB 中。电脑与手机即使访问同一个地址，数据也不会自动同步。

## GitHub Pages 与完整网页版

`dist` 只包含静态资源。GitHub Pages 可以展示前端，但不能运行本项目的 Node 中间件，因此网易云链接导入和 AI 讲解都不可用。

完整公网版本需要：

1. 能持续运行 Node.js 的服务；
2. HTTPS 和域名；
3. 网易云与 DeepSeek 接口限流、日志脱敏和故障监控；
4. 与 IndexedDB 数据版本兼容的更新策略。

部署差异和推荐发布流程见 [部署与更新方案](docs/deployment.md)。

## 隐私与安全

- DeepSeek Key 只应填写在应用设置页，不要写入源码、Issue、截图或日志。
- AI 讲解会把当前歌词、翻译、罗马音及必要上下文发送给 DeepSeek。
- 网易云导入仅处理公开单曲，不读取用户账号 Cookie，也不绕过会员权限。
- 导入歌词的获取、保存和使用应由测试者自行确认符合相关版权与平台规则。

详细信息见 [隐私说明](PRIVACY.md) 和 [安全策略](SECURITY.md)。

## 开发与验证

```bash
npm ci
npm run check
```

每次推送到 `main` 或创建 Pull Request 时，GitHub Actions 会自动安装依赖、运行测试、构建生产资源并执行高危依赖审计。

项目结构：

```text
src/app       路由和启动编排
src/db        IndexedDB 仓储
src/engine    LRC、导入、AI 和复习逻辑
src/render    各页面视图
src/store     业务状态与数据备份
server        网易云本地网关
tests         自动测试和原创测试夹具
```

贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。当前路线和历史改造记录见 [docs/roadmap.md](docs/roadmap.md)。

## 已知限制

- 网易云兼容接口不是公开稳定 API，可能因上游变化临时失效。
- 不支持网易云登录、会员权限绕过、歌单/专辑批量导入或音频下载。
- 电脑与手机之间暂不自动同步曲库。
- PWA 目前只有基础 manifest 和 Service Worker 挂载点，尚未完成完整离线缓存与更新提示。
- 当前没有正式公网服务，也没有上架 Android 或 iOS。

## 许可证

ANISON 使用 [Apache License 2.0](LICENSE)。你可以在遵守许可证和 [NOTICE](NOTICE) 归属要求的前提下使用、修改和分发本项目。

网易云歌词导入的协议流程和时间轴对齐思路参考了 [jitwxs/163MusicLyrics](https://github.com/jitwxs/163MusicLyrics)。详细归属说明见 [网易云导入文档](docs/netease-import.md)。
