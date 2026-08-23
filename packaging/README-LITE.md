# DSH Desktop Launcher Lite 1.4.0（Windows x64）

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

1.2.1 起，启动 DSH 时使用 `--no-open`，因此只显示内嵌桌面窗口，不再额外打开系统默认浏览器。
1.4.0 保留 DSH“设置 → 通用设置 → 软件更新”中的原“检查更新”入口；它调用启动器原生更新器。
旧版顶部“帮助”菜单已移除，更新入口统一放在通用设置中。

程序必须和随包的 `node_modules` 保持在同一目录。不要把 EXE 单独移动到桌面；如需桌面入口，请为
EXE 创建快捷方式。

## 数据位置

- 启动器 WebView2 数据和日志：`%LOCALAPPDATA%\DSH Desktop Launcher\`
- DSH 用户配置和会话：`%USERPROFILE%\.dsh\`

1.4.0 可通过原“检查更新”入口只更新 DSH runtime、只更新启动器 EXE，或将相互依赖的两者成对更新。
两个候选都会先进入独立 staging目录并分别校验大小和 SHA-256；runtime还要验证压缩包结构、元数据和
固定入口，EXE还要验证 PE32+ AMD64结构与版本信息。

替换 EXE时，旧启动器会停止自己管理的 DSH进程并启动隐藏的原生更新助手。助手备份旧 runtime状态、
原子替换同目录 EXE，并等待新版 DSH页面和可信 WebView消息桥完成健康确认。超时、新版提前退出或
runtime失败时会恢复旧 EXE和旧 runtime状态；其他 Node.js程序不会按名称被结束。

如果替换后更新助手被任务管理器强制结束或电脑意外中断，下次普通启动会先校验未完成事务和全部回滚
材料，再提交已经健康的事务，或恢复旧 EXE/runtime并重开旧版；材料不完整时会停止并报错，不会猜测性
覆盖文件。

“软件更新”集成从 1.4.0 起作为 Windows资源嵌入 EXE，启动时按版本释放到 LocalAppData，再通过
受限预加载桥映射；它不会复制或写入随包或已下载的 DSH runtime。仓库中的维护者专用
“官方更新检查”插件只检查 DeepSeek官方 npm版本，不安装或发布更新，并且不会进入本 Lite包。

1.3.0 及更早版本升级到首个 1.4.0 时，都需要手动下载并完整解压本包一次。此后 1.4.0及兼容后续版
才具备完整的启动器自更新能力。发布 ZIP不包含制作者的缓存、日志、账号信息或 `.dsh`配置。

## 版本与限制

- 启动器：`1.4.0.0`
- 设置集成：`@themis4226/dsh-launcher-update-ui@1.0.0`
- 初始 DSH：固定为 `@deepseek-ai/dsh@0.1.1-rc.2`
- 仅绑定动态分配的 `127.0.0.1` 本机端口。
- DSH 仍处于 developer preview，升级前需要重新验证兼容性。

如果显示“找不到兼容的 Node.js”，请安装 Node.js 24 LTS x64，或让 `NODE_EXE` 指向兼容的
`node.exe`。如果显示 WebView2 错误，请从微软官方渠道安装 Evergreen WebView2 Runtime。

许可证及第三方组件信息见 `THIRD_PARTY_NOTICES.md` 和 `licenses\`。
