# Tiger 桌面端

> Tiger Agent 的桌面客户端：Tauri 2 + 原生 HTML/CSS/JS。只做操作台，Agent 运行时跑在独立的 Go 服务端上。

Tiger 把「Agent 运行时」和「操作界面」拆成两个独立程序：Go 服务端 `tigerAgent` 负责回合循环、工具执行、权限、上下文压缩、每轮撤销与会话持久化；本仓库只包含桌面端，提供 Agent、模型管理、项目管理、源码管理、终端、技能管理与设置 **7 个视图**。两端独立构建、独立升级，桌面端通过一条 TCP + TLS 连接串接入服务端——**安装包不包含、也不会启动服务端进程**。

- 官网：<https://tiger.kuda520.com/>
- 服务端 / CLI：<https://github.com/litai686/TigerAgent>

## 功能

- **Agent 对话**：工具调用、文件改动、任务清单与每轮撤销入口都在对话里；运行中可切换页面并保持状态，底部常驻服务端硬件与连接状态。
- **模型管理**：provider 增删改即时生效，云端模型改完无需重启服务端；内置模型从服务端快照进入下拉。
- **项目管理**：懒加载文件树浏览服务端工作区，右侧「预览 / 差异」双 TAB；有 Git 变更的文件直接看差异并暂存，双击跳转。
- **源码管理**：VSCode 风格 Git 工作流——分支、提交信息、更改 / 已暂存与提交图一屏完成；支持 split / unified 差异、子目录仓库与 SSE 自动刷新。
- **终端**：内嵌 xterm.js，连接服务端本机 PTY 或 `terminal-targets.json` 中的 SSH 目标，支持接管控制与只读模式，同一页可查看并终止 Agent 后台作业。
- **技能管理**：查看、安装、卸载服务端技能。
- **设置**：外观主题、网络代理、服务端连接、系统版本号与关于，支持配置导入导出；所有配置都落在服务端，桌面端保持纯 UI。
- **更新与本地化**：启动后检查更新，新版本弹窗 → 后台下载 → 提示安装，可跳过指定版本；中英双语界面；剪贴板粘贴（三平台差异处理）与 PDF 分批转图。

## 连接方式

```
Tiger 桌面端（Tauri）
        │  TCP + TLS 1.3 · ECDSA P-256 指纹钉扎 · Bearer token
        ▼
tigerAgent 服务端（用户自行启动）
        │  HTTP + SSE
        ▼
模型（云端 OpenAI 兼容 API 或本机推理服务）
```

- 服务端启动 `tigerAgent --host tcp://0.0.0.0:18471` 时会打印一条客户端连接串：

  ```
  tigerAgent://192.168.1.20:18471?fp=sha256:…&token=…
  ```

- 在「设置 → 服务端连接」整条粘贴并保存：客户端用 SPKI 指纹校验服务端身份，之后每个请求携带 Bearer token。
- 服务端可用 `--print-connection` 重新打印连接串；浏览器打开 `https://<服务端地址>/admin/` 可用指纹 + token 登录，生成 / 删除 token、查看活跃连接。
- 细节见 [doc/tcp-tls-ecdsa.md](doc/tcp-tls-ecdsa.md) 与 [doc/server-api.md](doc/server-api.md)。

## 快速开始

1. **安装桌面端**：从 [Releases](https://github.com/litai686/tiger/releases) 下载对应平台安装包。
   - Windows 10 / 11 · x64（NSIS 安装包）
   - macOS · Apple Silicon（DMG）
   - Linux · x64（deb / AppImage，需 GTK3 桌面环境）
2. **启动服务端**：在服务器侧解压并运行 `tigerAgent --host tcp://0.0.0.0:18471`，记录启动日志中的连接串。
3. **粘贴连接串**：打开桌面端，在「设置 → 服务端连接」粘贴并保存，连通后底部状态栏会显示服务端硬件信息。
4. **配置模型**：在「模型管理」中添加 OpenAI 兼容 provider（云端 API 或本机 llama.cpp / Ollama / vLLM），选好模型即可开始对话。

## 从源码构建

前置条件：

- Node.js 18+ 与 pnpm 9（`package.json` 固定 `pnpm@9.15.9`，**不要用 npm / yarn**）
- Rust 稳定版工具链
- Tauri 2 系统依赖
  - Windows：WebView2、MSVC Build Tools、NSIS
  - macOS：Xcode Command Line Tools
  - Linux：`libwebkit2gtk-4.1-dev`、`libgtk-3-dev`、`libayatana-appindicator3-dev` 等

```bash
pnpm install
pnpm tauri:dev              # 热重载开发
pnpm typecheck              # 前端类型检查（tsc -p jsconfig.json）

pnpm tauri:build:windows    # NSIS
pnpm tauri:build:macos      # DMG
pnpm tauri:build:linux      # deb / AppImage
```

签名：`pnpm sign:windows` / `pnpm sign:macos`。构建与发布细节见 [doc/build-and-release.md](doc/build-and-release.md)。

## 目录结构

| 路径 | 内容 |
| --- | --- |
| `src/` | 前端 SPA：原生 HTML / CSS / JS，无框架、无打包工具，hash 路由 + 7 个视图模块 |
| `src-tauri/` | Tauri Rust 后端：IPC 命令、服务端连接（TLS + 指纹钉扎）、自升级与下载链路 |
| `doc/` | 桌面端开发文档（索引见下） |
| `website/` | 产品官网（静态 HTML） |
| `scripts/` | 构建、签名、图标与官网封面生成脚本 |

## 文档

| 文档 | 内容 |
| --- | --- |
| [doc/frontend-architecture.md](doc/frontend-architecture.md) | SPA 视图模块结构、样式 / 类型约定、Tauri IPC、多 workspace 并发 |
| [doc/frontend-agent-conventions.md](doc/frontend-agent-conventions.md) | Agent 视图错误处理、自动续跑、假完成检测、拖拽保护、每轮撤销、同目录多会话并行 |
| [doc/rust-backend.md](doc/rust-backend.md) | Rust 命令地图、应用自升级、下载链路、平台差异 |
| [doc/agent-server.md](doc/agent-server.md) | 服务端回合循环、压缩与事实块、提示词预算、决策模式、工具与权限边界 |
| [doc/server-api.md](doc/server-api.md) | 服务端 HTTP API 契约 |
| [doc/tcp-tls-ecdsa.md](doc/tcp-tls-ecdsa.md) | TCP + TLS（ECDSA P-256）传输、连接串与 token 管理 |
| [doc/attachments.md](doc/attachments.md) | 剪贴板粘贴（三平台差异）与 PDF 分批转图 |
| [doc/build-and-release.md](doc/build-and-release.md) | 各平台打包、签名与发布链路 |
| [doc/conventions.md](doc/conventions.md) | 工作边界、代码 ↔ 文档同步映射表、调试日志格式 |

## 开发约定

- 一律使用 `pnpm`；前端改动必须跑 `pnpm typecheck`。
- 本仓库没有 linter / formatter / 前端测试框架，不要新增。
- 行为或接口契约变化时，同步更新 `doc/` 下对应文档；服务端接口变化同步 `doc/server-api.md`。

## 许可证

[FSL-1.1-MIT](LICENSE.md)（Functional Source License 1.1，每个版本在发布两年后自动转为 MIT）。
