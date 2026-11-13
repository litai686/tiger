<div align="center">

# Tiger

**Tiger — 开箱即用的 Agent 桌面客户端**

基于 Tauri 2.x 构建，内置 **Agent 工作台** 与 Go 编写的 `admAgent` 服务端：填入云端模型（OpenAI 兼容接口）即可开始编码与自动化任务，无需本地部署推理环境。

![Tauri](https://img.shields.io/badge/Tauri-2.11.5-FFC131?style=flat-square&logo=tauri)
![Rust](https://img.shields.io/badge/Rust-2021_edition-000000?style=flat-square&logo=rust)
![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)
![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS-blue?style=flat-square)

</div>

---

## 联系方式

- **项目地址**：https://github.com/autoDeploymentModel/adm
- **问题反馈**：[GitHub Issues](https://github.com/autoDeploymentModel/adm/issues)
- **讨论交流**：欢迎扫码添加微信交流

<img src="https://raw.githubusercontent.com/autoDeploymentModel/.github/main/wx.png" alt="微信" width="240" />

---

## 项目介绍

Tiger 是一款基于 **Tauri 2.x** 的 Agent 桌面客户端，底部只有 **Agent | 技能管理 | 设置** 三个入口：

- **开箱即用** — `admAgent` 二进制随安装包内置，首次启动即可对话，无需另行安装运行时
- **云端模型接入** — 在 Agent 设置里添加 OpenAI 兼容 provider（Base URL / API Key / 模型 ID），支持多模型切换与推理强度设置
- **硬件信息栏** — 底部常驻显示内存、显存、CPU 信息，多卡时可逐卡查看
- **技能管理** — 浏览技能商店、安装 / 卸载 zip 技能包，Agent 运行时按需挂载
- **自动更新** — 启动后静默后台下载安装包，就绪后提示一键升级
- **多语言与主题** — 界面语言切换 + 多套 VS Code 风格主题

轻量高效：前端采用原生 HTML/CSS/JS，无重型框架、无打包工具。

### ⭐ 核心亮点：Agent 工作台

**Agent 工作台** 把云端大模型变成能跑工具、可自动纠错的智能体：

- **幻觉自修复** — 模型出现幻觉、空转、假完成时自动检测并纠正，输出更可信
- **多模型切换** — 顶部模型菜单可在已配置的云端模型之间即时切换，推理强度 / 思考开关随模型生效
- **多工作区并行** — 每个工作目录独立会话、独立数据库，切换 tab 不打断正在跑的 Agent
- **工具生态** — 内置文件 / Shell / LSP / MCP / 技能（Skills）体系，支持工具调用审批与权限模式
- **会话管理** — 会话重命名、上下文压缩、项目记忆（持久约束与决策）
- **附件管线** — 图片、PDF（自动分批转图）、文件路径粘贴全平台可用
- **决策模式** — 单轮结构化决策输出（选择 / 布尔 / 打分），结果以卡片呈现并回灌上下文
- **微信 Bot** — 绑定微信后可在手机端把消息投进当前工作区的 Agent
- **网络代理** — 可为 admAgent 配置 HTTP / SOCKS5 代理，本地地址自动绕过

> 填入模型 → 打开 Agent → 你的云端大模型立刻变成一个能跑工具、自动纠错的智能体生产力工具。

---

## 项目结构

| 目录 | 说明 |
| --- | --- |
| `src/` + `src-tauri/` | Tauri 桌面端（原生 JS 前端 + Rust 后端） |
| `admAgent/` | Go 编写共享后端服务与 TUI，两端共用同一 server |
| `doc/` | 服务端 API 文档、前端 / Rust 约定与方案文档 |
| `scripts/` | 构建、签名、图标等工具脚本 |
| `website/` | 营销网站 |

---

## 编译与部署

### 环境准备

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| [Rust](https://www.rust-lang.org/tools/install) | stable | Tauri 后端编译 |
| [Node.js](https://nodejs.org/) | 22+ | 前端工具链 |
| [pnpm](https://pnpm.io/) | 9+ | 包管理器（不要使用 npm / yarn） |

> Windows 还需安装 [Visual Studio C++ 生成工具](https://visualstudio.microsoft.com/visual-cpp-build-tools/)（MSVC）；macOS 需安装 Xcode Command Line Tools（`xcode-select --install`）。

### 开发调试

```bash
# 安装依赖
pnpm install

# 热重载开发模式
pnpm tauri dev

# 前端类型检查（tsc --noEmit）
pnpm typecheck
```

前端为原生 HTML/CSS/JS（无框架、无打包工具），源码位于 `src/`，修改后刷新即生效；Rust 后端源码位于 `src-tauri/src/`。

`admAgent` 为 Go 项目，在 `admAgent/` 目录下单独构建：

```bash
go build ./...                          # 编译检查
go test ./internal/... -count=1         # 单元测试
```

编译产物会写入 `adm-binaries/`，桌面端构建时由 `scripts/prepare-agent-binary.mjs` 自动选版并打进安装包。

### 生产构建

```bash
# 当前平台构建
pnpm tauri build

# 指定平台构建
pnpm tauri:build:windows   # Windows x64（NSIS 安装包）
pnpm tauri:build:macos     # macOS arm64（DMG）
pnpm tauri:build:linux     # Linux x64（deb / AppImage）
```

构建产物位于 `src-tauri/target/<target>/release/bundle/` 目录。

### 签名与发布

```bash
# 构建 + 自签名一条龙
pnpm release:windows   # = tauri:build:windows + sign:windows
pnpm release:macos     # = tauri:build:macos + sign:macos

# macOS 用户提示「已损坏」时的修复脚本
pnpm fix:macos

# 推送最新 admAgent 二进制到 adm-binaries 仓库
pnpm agent:push
```

### CI 自动发布

CI 配置见仓库根目录 `.github/workflows/build.yml`（服务端与桌面端统一 CI）。推送 `v*` 标签即并行编译服务端三平台 + 桌面端三平台，六个任务全部成功后自动发布 GitHub Release（服务端 `zip`/`tar.gz`、Windows `x64-setup.exe`、macOS `aarch64.dmg`、Linux `.deb`/`.AppImage`，桌面安装包含自签名）：

```bash
git tag v0.7.3
git push origin v0.7.3
```

### 运行要求

- **admAgent**：随安装包内置，Windows / macOS / Linux 均可运行。
- **模型**：仅在 Agent 设置中配置云端 provider（OpenAI 兼容接口），桌面端不再部署本地模型、不依赖 llama.cpp / Docker。

---

## 许可证

本项目基于 **MIT 许可证** 开源。

```
MIT License

Copyright (c) 2026 Tiger

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
