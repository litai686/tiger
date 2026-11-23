# Tiger 桌面端

> Tiger Agent 的桌面客户端：Tauri 2 + 原生 HTML/CSS/JS。只做操作台，Agent 运行时跑在独立的 Go 服务端上。

Tiger 把「Agent 运行时」和「操作界面」拆成两个独立程序：Go 服务端 `tigerAgent` 负责回合循环、工具执行、权限、上下文压缩、每轮撤销与会话持久化；本仓库只包含桌面端，提供 Agent、模型管理、项目管理、技能管理与设置 **5 个视图**。两端独立构建、独立升级，桌面端通过一条 TCP + TLS 连接串接入服务端——**安装包不包含、也不会启动服务端进程**。

- 官网：<https://tiger.kuda520.com/>
- 服务端 / CLI：<https://github.com/litai686/TigerAgent>

## 功能

- **Agent 对话**：工具调用、文件改动、任务清单与每轮撤销入口都在对话里；运行中可切换页面并保持状态，底部常驻服务端硬件与连接状态；Agent 设置里可查看 / 下载 / 一键清空服务端日志。
- **模型管理**：provider 增删改即时生效，云端模型改完无需重启服务端；内置模型从服务端快照进入下拉。
- **项目管理**：懒加载文件树浏览服务端工作区，支持新建 / 上传 / 重命名 / 内联编辑 / 下载到本机 / 删除（含项目根目录）；右侧「预览 / 差异」双 TAB，有 Git 变更的文件直接看差异并暂存，双击跳转；默认打开服务端当前工作目录，「添加工作目录」只填名称（由服务端在用户主目录下创建），移除只影响列表、不删磁盘文件。
- **技能管理**：技能商店浏览与在线安装（全局 / 当前项目）、本地上传 zip 包、查看与卸载已装技能。
- **设置**：外观主题、网络代理、服务端连接、系统版本号与关于；旧本机配置可一键导入服务端；所有配置都落在服务端，桌面端保持纯 UI。
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

- 服务端启动 `tigerAgent --host tcp://:18471` 时会打印一条客户端连接串：

  ```
  tigerAgent://192.168.1.20:18471?fp=sha256:…&token=…
  ```

- 在「设置 → 服务端连接」整条粘贴并保存：客户端用 SPKI 指纹校验服务端身份，之后每个请求携带 Bearer token。
- 连接串的 host 可以是 IP 或域名，端口可省略（默认 443，适配域名 / 反向代理 / 隧道预览）；反向代理终止 TLS 时客户端自动改用公共根证书校验代理证书（指纹只用于直连），并按连接串 host 发送真实 `Host` 头供代理按域名路由。
- 服务端可用 `--print-connection` 重新打印连接串；浏览器打开 `https://<服务端地址>/admin/` 可用指纹 + token 登录，生成 / 删除 token、查看活跃连接。
- 细节见 [doc/tcp-tls-ecdsa.md](doc/tcp-tls-ecdsa.md) 与 [doc/server-api.md](doc/server-api.md)。

## 快速开始

1. **安装桌面端**：从 [Releases](https://github.com/litai686/tiger/releases) 下载对应平台安装包。
   - Windows 10 / 11 · x64（NSIS 安装包）
   - macOS · Apple Silicon（DMG）
   - Linux · x64（deb / AppImage，需 GTK3 桌面环境）
2. **启动服务端**：在服务器侧解压并运行 `tigerAgent --host tcp://:18471`，记录启动日志中的连接串；也可以用下一节的一键脚本自动下载、安装并启动。
3. **粘贴连接串**：打开桌面端，在「设置 → 服务端连接」粘贴并保存，连通后底部状态栏会显示服务端硬件信息。
4. **配置模型**：在「模型管理」中添加 OpenAI 兼容 provider（云端 API 或本机 llama.cpp / Ollama / vLLM），选好模型即可开始对话。

## 服务端安装（一键脚本）

服务端 `tigerAgent` 与桌面端分开部署。Linux / macOS 服务器可直接用仓库内的 `./install-server.sh` 安装并启动（只支持 bash 环境；Windows 请手动解压 Release 里的 `*_server.zip`）：

```bash
# 在仓库根目录执行
bash install-server.sh
```

脚本会读取当前系统的 OS / 架构（Linux x86_64、macOS x86_64 / arm64），从 [Releases](https://github.com/litai686/tiger/releases) 取最近一次发布的 `*_server` 产物并：

- 用 `checksums.txt` 校验 sha256 后安装到 `~/.local/bin/tigerAgent`，数据目录为 `~/.local/share/tigerAgent/data`
- 已安装二进制的 `--version` 与 Release 版本一致时跳过下载，直接重启
- 用 `nohup` 后台启动（不生成安装记录 / PID / nohup 日志等额外文件），启动后在终端回显二进制自己打印的管理界面地址、指纹、token 与连接串，并做 `/v1/health` 健康检查
- 重复执行即升级：先停止运行中的旧实例（SIGTERM，20 秒未退出则 SIGKILL），再覆盖二进制并重新启动；版本未变也照样重启，`TIGER_NO_START=1` 只装不启动

可用环境变量覆盖默认行为：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TIGER_REPO` | `litai686/tiger` | GitHub 仓库（`owner/repo`） |
| `TIGER_VERSION` | `latest` | 指定版本，如 `0.0.1` / `v0.0.1` |
| `TIGER_HOST` | `tcp://:6464` | 服务端监听地址（host 留空 = IPv4 + IPv6 双栈） |
| `TIGER_INSTALL_DIR` | `~/.local/bin` | 二进制安装目录 |
| `TIGER_DATA_DIR` | `~/.local/share/tigerAgent/data` | 数据目录（配置、会话） |
| `TIGER_NO_START` | `0` | `1` 只安装不启动 |
| `TIGER_DEBUG` | `0` | `1` 以 `--debug` 启动 |
| `TIGER_FORCE` | `0` | `1` 忽略已安装版本、强制重新下载 |
| `GITHUB_TOKEN` | 未设置 | 可选；GitHub API 限流时提升额度 |

### systemd 部署（仅 Linux，推荐服务器长期运行）

需要开机自启、崩溃自动拉起时，用同目录的 `install-server-systemd.sh`（下载 / 校验逻辑与上面一致，额外生成 systemd unit 管理进程）：

```bash
# 普通用户：用户级单元 ~/.config/systemd/user/tigerAgent.service（systemctl --user，强制开启 linger，失败报错）
bash install-server-systemd.sh

# root / sudo：系统级单元 /etc/systemd/system/tigerAgent.service，默认以 sudo 调用者身份运行
sudo bash install-server-systemd.sh
```

- unit 带 `Restart=on-failure`、`KillSignal=SIGTERM`；`enable` 后会校验 `systemctl is-enabled`，用户级单元强制开启 linger（失败直接报错并给出 `sudo loginctl enable-linger <用户>`），保证系统重启 / 未登录时也自动拉起；系统级数据目录默认 `/var/lib/tigerAgent`（检测到服务用户旧 `~/.local/share/tigerAgent/data/tigerAgent.json` 时自动沿用，身份 / token 不变）
- 重跑即升级：先覆盖二进制、重写 unit 并 `daemon-reload`（任一步失败都不动正在运行的旧实例），最后才停旧单元（含迁移前遗留的用户级单元）与 `install-server.sh` 留下的 nohup 进程并重启；版本未变也重启
- 健康检查与连接串回显改读 `journalctl`（`journalctl -u tigerAgent -f`，用户级加 `--user`），启动后先校验 `systemctl is-active`，没有 curl 也能发现启动失败；`TIGER_SYSTEMD_SCOPE`（`user` / `system`）、`TIGER_SERVICE_NAME`、`TIGER_SERVICE_USER` 可覆盖作用域 / 服务名 / 运行用户，其余环境变量同上表；`TIGER_NO_START=1` 只安装并写入 unit、不启用

服务端自身日志在 `~/.cache/tigerAgent/tigerAgent.log`（systemd 系统级服务为运行用户 HOME 下的同一路径）；忘记连接串时可用
`~/.local/bin/tigerAgent --print-connection --data-dir ~/.local/share/tigerAgent/data` 重新打印。

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
| `src/` | 前端 SPA：原生 HTML / CSS / JS，无框架、无打包工具，hash 路由 + 5 个视图模块（Agent / 模型 / 项目 / 技能 / 设置） |
| `src-tauri/` | Tauri Rust 后端：IPC 命令、服务端连接（TLS + 指纹钉扎，反向代理终止 TLS 时回退公共根证书）、自升级与下载链路 |
| `doc/` | 桌面端开发文档（索引见下） |
| `website/` | 产品官网（静态 HTML） |
| `scripts/` | 构建、签名、图标与官网封面生成脚本，以及服务端二进制推送 |
| `install-server.sh` | 服务端一键部署脚本：按系统下载 Release 里的 `*_server` 产物、校验、安装并用 nohup 启动 |
| `install-server-systemd.sh` | 服务端 systemd 部署脚本（仅 Linux）：下载 / 校验同 `install-server.sh`，生成 systemd unit 并 `enable --now`（普通用户装用户级单元，`sudo` 装系统级单元），重跑即升级 |

## 文档

| 文档 | 内容 |
| --- | --- |
| [doc/frontend-architecture.md](doc/frontend-architecture.md) | SPA 视图模块结构、样式 / 类型约定、Tauri IPC、多 workspace 并发 |
| [doc/frontend-agent-conventions.md](doc/frontend-agent-conventions.md) | Agent 视图错误处理、自动续跑、假完成检测、拖拽保护、每轮撤销、同目录多会话并行 |
| [doc/rust-backend.md](doc/rust-backend.md) | Rust 命令地图、应用自升级、下载链路、平台差异 |
| [doc/agent-server.md](doc/agent-server.md) | 服务端回合循环、压缩与事实块、提示词预算、决策模式、工具与权限边界 |
| [doc/agent-settings.md](doc/agent-settings.md) | Agent 设置项、推理强度与思考开关、服务端日志入口 |
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
