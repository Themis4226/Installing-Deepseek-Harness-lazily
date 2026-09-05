# DSH Desktop Launcher 1.4.2 (Preview)

## 修复内容

- 修复部分 Windows 配置在调用 DeepSeek 时出现的
  `DeepSeek request extension preparation failed` / `REQUEST_EXTENSION`。
- 启动器的内置 Web 叠加层会停用 `plugin-package-inventory-deepseek` 诊断扩展，避免失效的插件链接让
  整个模型请求提前失败。
- 实际插件、模型、工具、会话和推理强度不受影响；只是不再向 DeepSeek 请求附加诊断用插件包清单。
- 图标保持不变。

## 下载选择

- **Full package / Windows x64**：`DSH-Desktop-Lite-1.4.2-win-x64.zip`，供首次安装使用；完整解压后
  运行 `DeepSeek Harness.exe`。
- **Launcher updater asset / Windows x64**：`DeepSeek-Harness-1.4.2-win-x64.exe`，供 1.4.0/1.4.1 的
  程序内更新器使用，不是完整安装包。
- 每个下载旁的 `.sha256` 文件用于校验下载完整性。

本版继续使用未经改动的官方 `@deepseek-ai/dsh@0.1.2-rc.1` runtime，不重新发布或重命名官方运行时
资源。普通用户首次安装只下载完整 ZIP；已有兼容版本只需通过“软件更新”更换启动器。

## 发布文件校验

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| DSH-Desktop-Lite-1.4.2-win-x64.zip | 67379704 | `08aa95c5dfbcfa7578f41e6ccb3fd8c0901bf65da8171e241965adaeadbdd828` |
| DeepSeek-Harness-1.4.2-win-x64.exe | 730624 | `968cd98f9d9d2e205ae3cc4c50995fc5601df810e588a3977c3f9abd0483b835` |

## 系统要求

- Windows 10/11 x64
- x64 Node.js `^22.19.0 || >=24.0.0`
- Microsoft Edge WebView2 Runtime

本项目是非官方社区启动器，仍处于 Preview 阶段。
