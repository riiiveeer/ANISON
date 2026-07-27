# 网易云公开单曲歌词导入

## 使用方法

1. 运行 `npm run dev:lan`。
2. 打开“曲库”，点击导入按钮，选择“网易云链接”。
3. 粘贴公开单曲链接、完整分享文本或纯数字歌曲 ID。
4. 查看原文、中文翻译和罗马音状态，确认后导入。

原文歌词是必需项；中文翻译和罗马音缺失时仍可导入。导入成功后会直接打开第一张有效歌词卡。同一网易云歌曲再次导入时会打开已有歌曲，不覆盖歌词和学习进度。

## 运行方式

- 开发：`npm run dev` 或 `npm run dev:lan`
- 构建：`npm run build`
- 构建后局域网预览：`npm run preview:lan`
- 在线接口烟雾测试：`npm run test:netease:smoke -- <歌曲链接或 ID>`

`dist` 是静态资源，不包含能够独立运行的网易云代理。必须使用带 ANISON 中间件的 Vite 开发/预览服务，或未来部署的等价 Node 服务。

## 实现和安全边界

- 浏览器只调用同源的 `POST /api/netease/preview`。
- 服务端仅允许网易云官方歌曲域名及 `163cn.tv` 短链接。
- 不支持登录、会员权限绕过、歌单、专辑、歌曲搜索或音频下载。
- 服务端不读取或保存用户账号 Cookie。
- 网易云接口并非公开稳定 API；上游结构变化时会返回可重试的中文错误，不影响本地曲库。
- PC 和手机的 IndexedDB 相互独立，本功能不提供设备间同步。

## 参考与许可

协议流程和歌词时间轴对齐思路参考：

- [jitwxs/163MusicLyrics](https://github.com/jitwxs/163MusicLyrics)
- [NetEaseMusicNativeApi.cs](https://github.com/jitwxs/163MusicLyrics/blob/master/cross-platform/MusicLyricApp/Core/Service/Music/NetEaseMusicNativeApi.cs)
- [LyricUtils.cs](https://github.com/jitwxs/163MusicLyrics/blob/master/cross-platform/MusicLyricApp/Core/Utils/LyricUtils.cs)

参考项目采用 [Apache License 2.0](https://github.com/jitwxs/163MusicLyrics/blob/master/LICENSE)。ANISON 使用独立 JavaScript 实现，没有复制其界面或完整业务代码。
