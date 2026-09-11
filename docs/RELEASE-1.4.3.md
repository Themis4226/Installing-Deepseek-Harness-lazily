# DSH Desktop Launcher 1.4.3 (Preview)

## 本版内容

- 初始运行时升级为 DeepSeek 官方 npm 包 `@deepseek-ai/dsh@0.1.5-rc.1`。
- 保留原有“软件更新”和维护者专用“官方更新检查”入口，并针对 0.1.5 的真实 Web 运行时重新验证。
- 保留 1.4.2 对 `DeepSeek request extension preparation failed` 的针对性修复。
- 启动器图标及其资源文件保持不变。

官方 0.1.5 新增 DeepSeek-V41-Flash、通用文件上传、子代理消息队列、右侧多标签文件预览、代理环境变量
支持，并改善长会话性能及 Windows 子进程清理。完整内容请参阅
[DeepSeek 官方发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.1)。

## 重要兼容提示

DSH 0.1.5 将会话格式升级为 V3。官方迁移会保留旧日志，但升级后产生的会话不能由旧版 DSH 读取。
安装前建议备份 `%USERPROFILE%\.dsh`；第三方插件也可能需要适配 0.1.5 的 API 变化。

## 下载选择

- **Full package / Windows x64**：`DSH-Desktop-Lite-1.4.3-win-x64.zip`，供首次安装或完整覆盖升级。
- **Launcher updater asset / Windows x64**：`DeepSeek-Harness-1.4.3-win-x64.exe`，仅供程序内更新器使用。
- **Runtime updater asset / Windows x64**：`dsh-runtime-0.1.5-rc.1-win-x64.zip`，仅供程序内更新器使用。
- 每个下载旁的 `.sha256` 文件用于校验下载完整性。

## 发布文件校验

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `DSH-Desktop-Lite-1.4.3-win-x64.zip` | 70788435 | `2ecf707c94bd4bf18ef85b8aa30e0d31cc5f3c208090f241a787742542fc785f` |
| `DeepSeek-Harness-1.4.3-win-x64.exe` | 730624 | `8106f585f9b05327970c6870df5e5b971240cc56d96fe1406842e3e3a959dd0f` |
| `dsh-runtime-0.1.5-rc.1-win-x64.zip` | 68191504 | `de773ccf8a46e2cf0135a7ab1b3e2dea2ff9ce7301c9302b35551f26e5344ecb` |

## 系统要求

- Windows 10/11 x64
- x64 Node.js `^22.19.0 || >=24.0.0`
- Microsoft Edge WebView2 Runtime

本项目是非官方社区启动器，仍处于 Preview 阶段。
