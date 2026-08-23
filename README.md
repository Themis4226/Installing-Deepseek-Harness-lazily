# DSH Desktop Launcher 1.4.0（Windows x64）

这是一个面向 Windows 的**非官方社区启动器**，用于在本机窗口中运行 DeepSeek Harness（`dsh`）。
它不隶属于 DeepSeek，也不代表 DeepSeek 对本项目的认可、审核或背书。

> 下载 1.4.0 完整包时，请从本仓库的
> [Releases](https://github.com/Themis4226/Installing-Deepseek-Harness-lazily/releases) 下载。GitHub 自动生成的
> “Source code (zip)” **不是可运行安装包**。

## 第一次安装或从旧版本升级

1. 在 Releases 中下载标为 **Full package / Windows x64** 的 1.4.0 完整 ZIP，并对照发布页公布的
   SHA-256；不要只下载或复制 EXE。
2. 完整解压到一个较短、可写的新目录，例如 `D:\Apps\DSH-Launcher`。不要覆盖仍在运行的旧目录。
3. 关闭旧版窗口后双击 `DeepSeek Harness.exe`。确认工作区、模型配置和基本对话都正常后，再保留或移除旧程序目录。

不需要先卸载旧版，也不要删除 `%USERPROFILE%\.dsh`。1.3.0 及更早版本没有完整的启动器自替换能力，
因此升级到首个 1.4.0 版本时都必须手动下载并完整解压一次。完成这次过渡后，1.4.0 及后续兼容版本
才可以在程序内更新启动器 EXE。完整包包含启动器和初始 DSH 运行时，但不包含 Node.js。不要把 EXE
单独移动到桌面；需要桌面入口时，请创建快捷方式。

## 1.4.0 的程序内成对更新

1.4.0 保留 DSH **设置 → 通用设置 → 软件更新 → 检查更新** 的原入口。该设置行使用 DSH 提供的
通用设置扩展位，外观、主题和交互与同页设置保持一致。启动器也会在正常启动后进行一次静默检查；
发现更新时仍由用户确认。

从 1.4.0 起，原生更新器分别读取保持向后兼容的 `update.json` 运行时清单和独立的
`launcher-update.json` 启动器清单。它可以只更新 DSH 运行时、只更新启动器，或将相互依赖的新版 EXE
与 runtime 作为一组更新。旧 `update.json` 不会加入启动器字段，因此 1.3.0 的严格清单解析不会被破坏。

所有候选资源都会先下载到独立 staging 目录并分别校验。runtime ZIP需要通过大小、SHA-256、目录结构
和固定 DSH入口检查；EXE需要通过大小、SHA-256、PE32+ AMD64结构和版本信息检查。runtime更新不是
二进制差分（delta）：依赖有变化时，下载量仍可能接近完整的 `node_modules`。

需要替换 EXE时，旧启动器会先停止自己管理的 DSH进程，再从自身复制出一个隐藏的原生更新助手并
退出。助手备份运行时状态，原子替换同目录下的启动器，然后启动新版并激活已准备好的 runtime。只有
新版 DSH页面健康加载且可信 WebView消息桥完成握手后，整组更新才会提交。超时、新版提前退出或
runtime启动失败时，助手会恢复旧 EXE和旧 runtime状态并重新打开旧版。它只管理本次启动器记录的
明确进程，不按名称结束其他 Node.js程序。

如果 EXE替换后更新助手被任务管理器强制结束或电脑意外中断，下次普通启动会先严格校验未完成事务、
候选文件、旧 EXE/助手和 runtime备份：已留下完整健康标记的事务会安全提交，否则会回滚并重开旧版；
材料不完整时会停止恢复并报错，不会猜测性覆盖文件。

1.4.0 将“软件更新”设置集成作为 Windows资源嵌入 EXE，并在启动时按启动器版本释放到
`%LOCALAPPDATA%\DSH Desktop Launcher\data\launcher-integration\1.4.0\`。它通过精确模块映射加载，
不会写入或修改官方 DSH runtime；更新 EXE时也会随新版启动器一起更换，不再依赖旁置文件同步。

仓库还包含一个维护者专用的 **官方更新检查** 插件。它只查询 DeepSeek官方 npm上的
`@deepseek-ai/dsh` 最新版本，不安装、不切换、不发布更新，也不保存 npm或 GitHub凭据。该插件不会
进入 Lite包，普通用户仍只使用原有“检查更新”入口和本项目发布的兼容版本。

设置页只能向原生启动器请求更新操作；在系统浏览器中单独打开 DSH页面时，网页不能调用 EXE替换、
runtime切换或回滚能力。正常启动继续使用 `--no-open`，不会额外打开默认浏览器。

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
- 启动器候选、事务日志和回滚材料：`%LOCALAPPDATA%\DSH Desktop Launcher\updates\`
- EXE内嵌设置集成的版本化释放目录：`%LOCALAPPDATA%\DSH Desktop Launcher\data\launcher-integration\`

安装完整包、程序内更新和自动回退都不会主动删除 `%USERPROFILE%\.dsh\`。发布文件不应包含制作者的
缓存、日志、Cookies、账号信息、API 密钥或 `.dsh` 配置。重要工作仍建议自行备份；卸载或手动清理
上述目录属于另一项操作。

## 版本与官方边界

- 启动器：1.4.0（本社区项目维护）
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
