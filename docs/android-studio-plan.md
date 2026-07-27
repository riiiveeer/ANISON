<!--
文件功能：记录 ANISON 与 Android Studio 结合开发的建议路线。
结构说明：
1. 先以当前 Vite + PWA 方案稳定前端骨架；
2. 再通过 Android Studio + Capacitor 包装为 Android 应用；
3. 保持路由、IndexedDB、业务模块在 Web 与 Android 容器间共享。
-->

# ANISON 与 Android Studio 结合开发建议

## 当前阶段建议

- 继续以 `Vite` 作为前端开发服务器，优先完成移动端页面骨架、IndexedDB、本地学习闭环。
- 在 Android Studio 接入前，不急着拆成原生页面，先确保 Web 版本的信息架构稳定。

## 推荐接入方式

### 方案：Android Studio + Capacitor

推荐原因：

- 可以直接复用当前 `src/` 下的页面、路由、数据库与业务逻辑
- 后续如果需要文件选择、分享、通知、存储权限，可以逐步接 Capacitor 插件
- 便于保持一个前端代码库，同时输出 Web/PWA 与 Android 版本

## 建议步骤

1. 当前仓库先完成实施包 1 和 2
2. 新建 `android/` 容器工程时使用 Capacitor 挂载当前打包产物
3. 在 Android Studio 中重点补三类能力：
   - 文件系统与多文件导入
   - 通知与复习提醒
   - WebView / 容器调试与发布配置

## 工程边界建议

- 前端业务层继续保留在 `src/app`、`src/render`、`src/db`、`src/engine`
- Android 容器层只负责：启动壳、原生权限、插件桥接、发布配置
- 不建议过早把学习页、曲库页改写成原生 Activity / Fragment

## 下一步落地建议

- 等实施包 1 稳定后，再补 `Capacitor` 初始化
- 结合 Android Studio 时，把 `npm run build` 产物接入 Android 容器
- 真机调试重点验证：输入框体验、底部导航、文件导入、离线持久化