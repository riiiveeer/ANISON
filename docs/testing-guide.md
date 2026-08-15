# 朋友测试指南

## 1. 获取并启动

仓库为 Private 时，测试者需要先被添加为 Collaborator；仓库公开后可直接克隆。

```bash
git clone https://github.com/riiiveeer/ANISON.git
cd ANISON
npm ci
npm run dev:lan
```

电脑浏览器打开 `Local` 地址。同一 WiFi 的手机打开终端显示的 `Network` 地址。

## 2. 建议测试顺序

1. 空曲库打开首页，导入第一首歌。
2. 分别测试网易云公开单曲、LRC 文件和粘贴歌词。
3. 在单卡模式查看 AI 讲解并切换到下一张。
4. 刷新页面，确认歌曲、当前卡和学习进度仍在。
5. 切换连读模式，检查滚动、英文段落和重复歌词提示。
6. 第二天或调整测试数据后进入复习，验证“忘记 / 模糊 / 掌握”。
7. 搜索、编辑和删除歌曲。
8. 导出备份、清空数据，再导入恢复。
9. 在生产构建中安装 PWA，断网重开后验证曲库、学习、复习和导出仍可使用。
10. 发现新版本时分别验证“稍后”和“立即更新”，确认歌曲与进度仍然存在。

优先在约 `390 × 844` 的手机屏幕上完成一次完整流程。

### IndexedDB v4 自动化预验收

运行 `npm run test:perf` 后，应分别看到三类数据证据：全默认 80,000 逻辑单元对应 0 条 `learningStates`，10% 非默认状态对应 8,000 条且 `due/history` 索引各命中 8,000 条，v4 聚合备份恢复低于 10 秒。Linux CI 还要求两种完整迁移都低于 30 秒；Windows 默认只跳过这两项迁移时限，不跳过恢复和页面性能。

`npm run test:pwa` 的更新用例必须从旧 v3 数据开始，依次验证原子升级、迁移归档、备份 schema v3、“稍后”、恢复期间更新锁和“立即更新”后数据保留。

## 3. 固定 HTTPS 阶段 D 验收

只有维护者明确公布 canonical `onrender.com` Origin 后才执行本节。临时 Tunnel、localhost 和固定 Origin 的 IndexedDB 彼此独立；需要迁移测试数据时先从旧 Origin 导出，再在固定 Origin 恢复。

先记录版本证据：固定 Origin、浏览器版本、ANISON 版本、提交短 SHA、BUILD_ID、网络类型和测试时间。不要在记录或截图中包含 Beta 密码、DeepSeek Key、完整歌词或备份。

| 平台 | 必测项目 |
| --- | --- |
| Android Chrome | 安装提示、maskable 图标、standalone、WiFi/移动网络、飞行模式冷启动、后台恢复 |
| iPhone Safari | 分享→添加到主屏幕、Apple 图标、安全区、软键盘、离线重开、恢复在线 |
| Windows Chrome/Edge | 安装、独立窗口、缩放、检查更新、更新后单次刷新 |

每台设备按同一顺序验收：

1. 在线首次打开，导入一首不含私人内容的测试歌曲，完成学习、收藏和评分并导出备份。
2. 记录歌曲数、进度、收藏、评分、版本、提交和 BUILD_ID。
3. 断网后彻底关闭并重开 PWA，确认本地曲库、学习、复习和导出可用，联网入口显示降级提示。
4. 恢复网络并验证应用自动恢复，不要求清除站点数据或重新安装。
5. 部署第二个兼容 IndexedDB v4 的 BUILD_ID 后先选择“稍后”，再选择“立即更新”；确认只刷新一次且 IndexedDB 数据不变。不得把仅支持 v3 的部署作为回滚目标。
6. 在备份恢复期间确认“立即更新”被禁用，操作完成后恢复可用。
7. Android 分别通过 WiFi 和移动网络执行一次核心冒烟；记录 Free 冷启动等待和中国大陆网络差异。

若任一设备出现数据丢失、更新循环、API 返回 App Shell、CSP 阻断或无法离线重开，阶段 D 不得标记完成。

## 4. 反馈 Bug

创建 Issue 时请提供：

- 操作系统、浏览器和大致屏幕尺寸
- 使用的提交或版本号
- 最短复现步骤
- 预期结果和实际结果
- 可公开的截图或错误文字
- 问题发生在电脑本机、局域网手机还是构建预览

不要提交 DeepSeek Key、完整个人歌词库、网易云 Cookie 或包含敏感信息的数据备份。

## 5. 常见问题

### 手机打不开 Network 地址

- 确认手机与电脑连接同一 WiFi。
- Windows 防火墙允许 Node.js 访问专用网络。
- 不要使用手机访问 `localhost`，应使用电脑的局域网 IP。

### 网易云导入无法连接

- 必须通过 `npm run dev`、`npm run dev:lan` 或带 ANISON 中间件的预览服务启动。
- 直接打开 `dist/index.html` 或只部署 GitHub Pages 不会提供 Node 接口。

### 电脑和手机曲库不同

这是当前设计。IndexedDB 保存在各自浏览器中，需要分别导入，或通过完整数据导出和恢复手动迁移。

### 看不到安装按钮或离线功能

- PWA 只在 `npm run build && npm start` 的生产构建中注册，`npm run dev` 不注册。
- 桌面 `localhost` 可作为安全上下文；手机必须使用 HTTPS，普通局域网 HTTP 只用于页面联调。
- 首次必须在线打开并完成 Service Worker 激活，之后才能离线重开。
- iPhone Safari 使用“分享 → 添加到主屏幕”，不依赖网页安装弹窗。

阶段 C 自动化已经覆盖 Chromium 离线与更新流程。Android Chrome、iPhone Safari 的真实安装、安全区、软键盘和离线冷启动仍是阶段 D 固定 HTTPS 发布门禁，不能用桌面模拟替代。
