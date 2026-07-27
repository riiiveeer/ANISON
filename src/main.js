/**
 * 文件功能：应用总入口。
 * 结构说明：
 * 1. 仅负责调用 bootstrap 启动应用；
 * 2. 不直接承载页面逻辑、数据库逻辑或业务事件；
 * 3. 作为后续 Android WebView / Capacitor 容器接入时的统一前端入口。
 */

import { bootstrapApp } from './app/bootstrap.js';

bootstrapApp();
