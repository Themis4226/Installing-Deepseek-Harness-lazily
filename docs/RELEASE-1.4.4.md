# DSH Desktop Launcher 1.4.4 (Preview)

## 本版内容

- 初始运行时升级为 DeepSeek 官方 npm 包 `@deepseek-ai/dsh@0.1.7-rc.2`。
- 保留原有“软件更新”和维护者专用“官方更新检查”入口。
- 保留对 `REQUEST_EXTENSION` 错误的启动器配置，图标不变。

从 0.1.5 升级后，官方 Web 界面新增侧边栏终端、会话归档、插件管理、文件与 Office 预览；
0.1.7-rc.2 增加快捷键管理、定时提醒，并修复部分聊天、插件和设置问题。完整变更见
[0.1.7-rc.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.1) 和
[0.1.7-rc.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.2) 官方发布说明。

## 升级前须知

官方将会话日志升级为 V4，并把旧 `settings.yaml` 导入 Profile 配置。升级前请备份
`%USERPROFILE%\.dsh`；新版写入的会话和设置不保证可由旧版 DSH 读取。第三方插件可能需要适配。
本版仍是预发布版。

## 下载选择

- **Full package / Windows x64**：`DSH-Desktop-Lite-1.4.4-win-x64.zip`，用于首次安装或完整解压。
- **Launcher updater asset / Windows x64**：`DeepSeek-Harness-1.4.4-win-x64.exe`，供程序内更新器替换启动器。
- **Runtime updater asset / Windows x64**：`dsh-runtime-0.1.7-rc.2-win-x64.zip`，供程序内更新器升级 DSH。
- 各文件旁的 `.sha256` 可用于校验下载完整性。

## 发布文件校验

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `DSH-Desktop-Lite-1.4.4-win-x64.zip` | 163677393 | `aba861f1c8a064f50f6c18e4b9ab0cd8b2888315fc8d0b1cba249f00074e3827` |
| `DeepSeek-Harness-1.4.4-win-x64.exe` | 730624 | `357ec9f6fe67b398b5d75f204338529c443a9fb36e2881defa048b735f46dd9f` |
| `dsh-runtime-0.1.7-rc.2-win-x64.zip` | 160775277 | `566414bf1cd3508b651da4f53f8d7fee3e481adeb33446f997ea64db4de37b77` |

## 系统要求

- Windows 10/11 x64
- x64 Node.js `^22.19.0 || >=24.0.0`
- Microsoft Edge WebView2 Runtime

本项目是非官方社区启动器。完整包不包含 Node.js，也不包含制作者的用户数据、账号、密钥或会话。
