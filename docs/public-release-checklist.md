# 公开仓库检查清单

## 已完成

- [x] README 包含定位、启动、测试、架构、部署边界和已知限制。
- [x] 添加贡献指南、行为准则、隐私说明和安全策略。
- [x] 添加 Bug、功能建议和 Pull Request 模板。
- [x] GitHub Actions 自动运行测试、生产构建和高危依赖审计。
- [x] 生产 PWA 的 manifest、图标、离线 App Shell、用户确认更新和独立 Chromium E2E 已完成。
- [x] `.env`、个人 LRC、构建产物和本地测试文件已忽略。
- [x] 商业歌曲完整歌词测试夹具已替换为原创短夹具。
- [x] 文档说明网易云参考项目及其 Apache-2.0 许可。
- [x] 包元数据禁止误发布到 npm。
- [x] 启用 Secret Scanning、Push Protection 和 Dependabot 安全更新。

## 公开前确认

- [x] Git 历史提交身份使用 GitHub noreply 邮箱，不暴露私人邮箱。
- [x] 最后一次秘密信息、绝对路径和个人数据扫描无结果。
- [x] 选择 Apache License 2.0，并添加 LICENSE 与 NOTICE。
- [x] 删除或确认所有旧 GitHub Actions 日志可公开。
- [x] 将仓库可见性从 Private 改为 Public。
- [x] 公开后启用 Private Vulnerability Reporting。
- [x] 创建首个预发布版本和 Release Notes。

## 公网部署前另行完成

- [ ] 使用正式 Node 服务，而不是 Vite 开发服务器。
- [ ] 配置 HTTPS、域名、限流、安全响应头和日志脱敏。
- [ ] 分离生产环境配置，不在前端打包共享 API Key。
- [ ] 验证数据迁移、缓存更新和回滚流程。
- [ ] 在正式 HTTPS 地址完成 Android Chrome 与 iPhone Safari 安装、离线冷启动和恢复在线验收。
- [ ] 发布适用于实际运营者和地区的隐私说明。
