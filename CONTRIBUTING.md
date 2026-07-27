# 参与 ANISON

感谢你愿意测试或改进 ANISON。当前项目仍处于朋友测试阶段，优先接受可复现的问题、移动端体验反馈和小范围修复。

## 提交问题

提交 Bug 前请先确认：

1. 使用的是最新 `main` 分支。
2. 已执行 `npm ci`。
3. 问题在刷新页面后仍可复现。
4. Issue 和截图中没有 DeepSeek Key、私人歌词、完整分享文本或其他敏感信息。

请使用仓库提供的 Bug 或功能建议模板。安全问题不要创建公开 Issue，应按照 [SECURITY.md](SECURITY.md) 私下报告。

## 本地开发

```bash
npm ci
npm run dev
```

提交前运行：

```bash
npm run check
```

## Pull Request

- 一个 Pull Request 尽量只解决一个问题。
- 新增或修改业务规则时同步补充测试。
- 不提交 `node_modules`、`dist`、真实 API Key、个人歌词文件或来自商业歌曲的完整歌词。
- 不直接拼接不可信 `innerHTML`；歌词、歌名、错误和 AI 内容必须使用安全文本节点或现有受限渲染函数。
- 涉及 IndexedDB 结构时说明迁移和回滚方式。
- 说明手机端验证尺寸，核心流程优先使用 `390 × 844`。

提交到本项目的贡献默认按照 [Apache License 2.0](LICENSE) 提供。较大的外部贡献请先通过 Issue 讨论范围和设计。
