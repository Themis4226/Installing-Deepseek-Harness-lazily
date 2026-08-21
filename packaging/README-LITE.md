# DSH Desktop Launcher Lite 1.2.1（Windows x64）

这是一个非官方的 DeepSeek Harness (`dsh`) Windows 图形启动器。它不隶属于 DeepSeek，亦不代表
DeepSeek 对本启动器的认可或背书。

## 系统要求

- Windows 10/11 x64；
- 已安装 **x64 Node.js 22.19.0–22.x，或 x64 Node.js 24.0.0 及以上版本**；
- Microsoft Edge WebView2 Runtime。

本 Lite 包不包含 Node.js。启动器会自动从 `NODE_EXE`、系统 `PATH` 或 Node.js 标准安装目录寻找
`node.exe`，并在启动 DSH 前检查版本及 x64 架构。它不会调用 PowerShell、`npx.ps1` 或可见的命令行窗口。

## 使用方法

1. 完整解压 ZIP，不要只取出 EXE；建议解压到较短的可写路径，例如 `D:\Apps\DSH-Lite`。
2. 双击 `DeepSeek Harness.exe`。
3. 第一次使用时，按 DSH 页面提示选择工作区并配置自己的模型或 API 信息。

1.2.1 启动 DSH 时使用 `--no-open`，因此只显示内嵌桌面窗口，不再额外打开系统默认浏览器。

程序必须和随包的 `node_modules` 保持在同一目录。不要把 EXE 单独移动到桌面；如需桌面入口，请为
EXE 创建快捷方式。

## 数据位置

- 启动器 WebView2 数据和日志：`%LOCALAPPDATA%\DSH Desktop Launcher\`
- DSH 用户配置和会话：`%USERPROFILE%\.dsh\`

从 1.2.0 开始，可在“帮助 → 检查更新…”中下载经过大小与 SHA-256 校验的版本化 DSH 运行时。
更新会先进入独立目录，启动器只在新版本通过进程、URL 与 HTTP 2xx 健康检查后确认切换；失败会自动
回到上一版。运行时更新不会替换 EXE，也不会删除上述用户数据。它不是差分补丁，仍需下载完整运行时。

因此，1.1.0（不含更新器）和 1.2.0（会额外打开默认浏览器）升级到 1.2.1 时，都需要下载并完整
解压本包。发布 ZIP 中不包含制作者的缓存、日志、账号信息或 `.dsh` 配置。

## 版本与限制

- 启动器：`1.2.1.0`
- 初始 DSH：固定为 `@deepseek-ai/dsh@0.1.1-rc.2`
- 仅绑定动态分配的 `127.0.0.1` 本机端口。
- DSH 仍处于 developer preview，升级前需要重新验证兼容性。

如果显示“找不到兼容的 Node.js”，请安装 Node.js 24 LTS x64，或让 `NODE_EXE` 指向兼容的
`node.exe`。如果显示 WebView2 错误，请从微软官方渠道安装 Evergreen WebView2 Runtime。

许可证及第三方组件信息见 `THIRD_PARTY_NOTICES.md` 和 `licenses\`。
