# DSH Desktop Launcher 1.4.0 (Preview)

这是非官方社区启动器，不隶属于 DeepSeek，也不代表 DeepSeek 对本项目的认可、审核或背书。

## 下载

- `DSH-Desktop-Lite-1.4.0-win-x64.zip`：完整 Lite 包，首次安装或从 1.3.0 及更早版本升级时使用。
- `DeepSeek-Harness-1.4.0-win-x64.exe`：仅供已经运行 1.4.0 自更新协议的安装使用；首次安装不要单独下载此文件。
- 每个文件旁的 `.sha256`：用于校验下载内容。

GitHub 自动生成的 `Source code (zip)` 不是可运行安装包。Lite 包仍需要电脑已有兼容的 x64 Node.js
（`^22.19.0` 或 `>=24.0.0`）和 Microsoft Edge WebView2 Runtime。

## 本版变化

- 保留 DSH“设置 → 通用设置 → 软件更新”中的原“检查更新”入口。
- 新增启动器 EXE 自更新，并继续支持 DSH runtime 独立更新。
- 启动器和 runtime 可以作为一组先下载、逐项校验、再原子切换；新版健康检查失败时同时回滚。
- 更新 helper 只管理本次启动器记录的进程，不按名称结束其他 `node.exe` 程序。
- helper 被强制结束或电脑意外中断后，下次启动会校验事务与回滚材料，再安全提交或恢复旧版。
- “软件更新”UI 已嵌入 EXE，更新启动器时会同步更新，不再依赖安装目录中的旁置 UI 文件。
- 修复启动器更新源尚未发布时的检查失败：`launcher-update.json` 明确返回 HTTP 404 时，原“软件更新”
  仍会严格检查 DSH runtime；runtime 已是最新版时显示 `launcher-feed-unavailable` 状态。
- 上述过渡仅适用于启动器清单的精确 404；其他 HTTP、网络、格式、大小、SHA-256 或结构错误仍会失败
  关闭，`minimumLauncherVersion` 门槛继续生效，不会安装与当前启动器不兼容的 runtime。
- 初始官方 DSH runtime 仍固定为 `@deepseek-ai/dsh@0.1.1-rc.2`，本版没有重打相同 runtime 资源。

仓库中的“官方更新检查”是发布者本机使用的只读维护者插件，用于发现 DeepSeek 官方 npm 新版本并先做
兼容性验证。它不包含发布凭据，也不会进入公开 Lite 包；普通用户继续从本仓库的兼容版本清单更新。

## 从旧版升级

1.3.0 及更早启动器不能执行完整 EXE 自替换协议，因此需要手动下载并完整解压 1.4.0 一次。无需卸载
旧版，也不要删除 `%USERPROFILE%\.dsh`。确认新目录运行正常后，再自行保留或删除旧程序目录。

当前 EXE 未进行商业代码签名，Windows 可能显示未知发布者提示。请只从本 Release 下载，并对照随附的
SHA-256 文件校验内容。
