# DSH Desktop Launcher 1.2.0（Windows x64）

这是一个面向 Windows 的**非官方社区启动器**，用于在本机窗口中运行 DeepSeek Harness（`dsh`）。
它不隶属于 DeepSeek，也不代表 DeepSeek 对本项目的认可、审核或背书。

> 发布状态：1.2.0 的完整包和在线更新清单发布后，请从本仓库的
> [Releases](https://github.com/Themis4226/Installing-Deepseek-Harness-lazily/releases) 下载。GitHub 自动生成的
> “Source code (zip)” **不是可运行安装包**。

## 第一次安装或从 1.1.0 升级

1. 在 Releases 中下载标为 **Full package / Windows x64** 的 1.2.0 完整 ZIP，并对照发布页公布的
   SHA-256；不要只下载或复制 EXE。
2. 完整解压到一个较短、可写的新目录，例如 `D:\Apps\DSH-Launcher`。不要覆盖仍在运行的旧目录。
3. 双击 `DeepSeek Harness.exe`。确认工作区、模型配置和基本对话都正常后，再保留或移除旧程序目录。

1.1.0 启动器本身没有更新器，因此升级到 1.2.0 时仍必须下载一次完整包。完整包包含启动器和初始
DSH 运行时，但不包含 Node.js。不要把 EXE 单独移动到桌面；需要桌面入口时，请创建快捷方式。

## 1.2.0 之后的程序内更新

启动器成功安装到 1.2.0 后，可以在窗口菜单中选择 **Help → 检查更新…**。启动器也会在正常启动后
进行一次静默检查；发现新版本时仍由用户确认下载和切换。

在线更新只下载一个经过大小、SHA-256 和目录结构校验的 **runtime-only ZIP**，将它放入版本化目录，
再切换 DSH 运行时。它不是二进制差分（delta）更新：用户不用重新下载或手动覆盖整个桌面应用，但
运行时依赖有变化时，下载量仍可能接近完整的 `node_modules`。

新运行时只有在 DSH 启动并且内嵌页面成功加载后才会标记为可用。健康检查失败时，启动器会尝试回退
到上一个已工作的运行时。不要在更新或首次验证期间手动删除 `runtimes` 目录。

更新格式、校验规则和发布顺序见 [docs/UPDATE-FORMAT.md](docs/UPDATE-FORMAT.md)。

## 系统要求

- Windows 10/11 x64；
- x64 Node.js 22.19.0–22.x，或 x64 Node.js 24.0.0 及以上版本；
- Microsoft Edge WebView2 Runtime。

启动器会从 `NODE_EXE`、系统 `PATH` 或 Node.js 标准安装目录寻找 `node.exe`，并在启动 DSH 前检查
版本及 x64 架构。它不会依赖 PowerShell、`npx.ps1` 或可见的命令行窗口。

如果显示“找不到兼容的 Node.js”，请安装 Node.js 24 LTS x64，或让 `NODE_EXE` 指向兼容的
`node.exe`。如果显示 WebView2 错误，请从微软官方渠道安装 Evergreen WebView2 Runtime。

## 数据、更新缓存与回退

- DSH 用户配置和会话：`%USERPROFILE%\.dsh\`
- 启动器 WebView2 数据、日志和版本化运行时：`%LOCALAPPDATA%\DSH Desktop Launcher\`
- 已下载运行时：`%LOCALAPPDATA%\DSH Desktop Launcher\runtimes\<DSH 版本>\`

安装完整包、程序内更新和自动回退都不会主动删除 `%USERPROFILE%\.dsh\`。发布文件不应包含制作者的
缓存、日志、Cookies、账号信息、API 密钥或 `.dsh` 配置。重要工作仍建议自行备份；卸载或手动清理
上述目录属于另一项操作。

## 版本与官方边界

- 启动器：1.2.0（本社区项目维护）
- 初始 DSH：固定为 `@deepseek-ai/dsh@0.1.1-rc.2`（上游 npm 包）
- 更新清单、打包脚本和桌面壳：由本仓库维护，不是 DeepSeek 官方更新渠道
- 服务：仅绑定动态分配的 `127.0.0.1` 本机端口

DSH 仍处于 developer preview。上游包、模型列表和服务端可用性可能独立变化；启动器出现一个模型名
不等于相应 API 权限已经开放，也不会改变模型本身的能力。

## 安全、签名和图标说明

发布前请阅读 [PUBLIC-RELEASE-NOTICE.md](PUBLIC-RELEASE-NOTICE.md)。当前启动器未进行 Authenticode
签名，Windows SmartScreen 可能提示“无法识别的应用”。SHA-256 可用于核对下载内容是否与发布记录
一致，但不能替代经过验证的发布者签名。

当前图标源自 DeepSeek 官方移动应用素材；版权和商标归权利人所有，列出来源并不等于获得许可。
在获得书面许可或换成独立、不会造成混淆的图标前，不应把本项目描述为官方客户端。

第三方许可证和再分发要求见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
