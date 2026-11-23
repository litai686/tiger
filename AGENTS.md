# Tiger 桌面端 — Agent 指南

仓库级范围划分、Go 端（服务端 / CLI）命令与通用硬规则见 [`../AGENTS.md`](../AGENTS.md)。
服务端代码在**仓库根** `main.go` + `internal/`，不在本目录；只改 `desktop/` 时按本文件执行。

本文件只做**索引**：命令速查 + 代码/文档地图 + 桌面端硬规则。约定、踩坑记录与设计决策都在 `doc/` 下，
动手前按下面的索引打开对应文档，不要凭记忆猜。

## 目录结构

| 路径 | 内容 |
| --- | --- |
| `src/` | 前端 SPA（vanilla JS，无框架，用 `vite`/直接加载，见 `doc/frontend-architecture.md`） |
| `src-tauri/` | Rust 后端与 Tauri 配置（命令、自升级、下载链路），见 `doc/rust-backend.md` |
| `doc/` | 桌面端 + 服务端对接文档（下文索引） |
| `scripts/` | 构建、签名、`push-agent-binaries.mjs` 等 |
| `install-server.sh` | 服务端一键部署脚本（仓库根执行 `bash desktop/install-server.sh`）：按 OS / 架构下载 Releases 里的 `*_server` 产物，校验后装到 `~/.local/bin` 并用 nohup 启动（默认监听 `tcp://:6464`）；已装同版本跳过下载；再次执行会先停止运行中的旧实例（SIGTERM → 超时 SIGKILL）再覆盖二进制并重启；不落安装记录 / PID / nohup 日志等额外文件 |
| `install-server-systemd.sh` | 服务端 systemd 部署脚本（仅 Linux，仓库根执行 `bash desktop/install-server-systemd.sh`，`sudo` 执行装系统级单元）：复用 `install-server.sh` 的下载 / 校验 / 安装，生成 unit（普通用户 → 用户级 `~/.config/systemd/user` + `loginctl enable-linger`；root → 系统级 `/etc/systemd/system`，默认以 sudo 调用者身份运行）并 `enable --now`（校验 `systemctl is-enabled`，用户级单元强制 linger，失败报错）；重跑即升级（覆盖二进制 → 重写 unit → daemon-reload → 停旧单元含遗留用户级单元与 nohup 进程 → 重启）；系统级数据目录默认 `/var/lib/tigerAgent`（自动沿用服务用户旧目录配置），启动后校验 `systemctl is-active`、健康检查与连接串回显读 `journalctl`；`TIGER_NO_START=1` 只装不启用 |
| `website/` | 营销网站 |

## 开发命令（始终使用 `pnpm`，不要用 `npm`/`yarn`）

- `pnpm tauri:dev` / `pnpm tauri dev` — 热重载开发模式
- `pnpm tauri:build` — 生产构建（另有 `pnpm tauri:build:windows` / `:macos` / `:linux` 跨平台构建）
- `pnpm tauri clean` — 清理构建产物
- `pnpm typecheck` — 前端类型检查（`tsc -p jsconfig.json`，只检查不产出，改完前端必跑）
- `pnpm agent:push` — 推送服务端二进制（可选打包流程，需手动恢复 `bundle.externalBin`）
- `pnpm sign:windows` / `pnpm sign:macos` — 签名

Go 服务端（仓库根执行）：`go build ./...`、`go test ./internal/... -count=1`、`build.ps1` 等，见 [`../AGENTS.md`](../AGENTS.md#go-端命令速查仓库根执行)。

## 硬规则（违反会返工）

1. **先确认改动目标**：桌面端 = `src/` + `src-tauri/`；Go 服务端 / CLI = 仓库根 `main.go` + `internal/`。未经明确指示不混改两端。
2. **改完 Go 代码需重新编译服务端并单独安装/分发**（桌面端不打包、不启动服务端）：桌面端只通过 TCP + TLS 1.3 连接用户自行启动的 `tigerAgent --host tcp://…`，设置页粘贴服务端打印的连接串（地址 + SPKI 指纹 + token）；可选打包流程仍需 `pnpm agent:push` + 手动恢复 `bundle.externalBin`。细节见 [`doc/build-and-release.md`](doc/build-and-release.md)。
3. 前端改动跑 `pnpm typecheck`；本仓库没有 linter / formatter / 前端测试框架，不要新增。
4. **代码改动必须同步更新对应文档**：同一次改动里改完，映射表见 [`doc/conventions.md`](doc/conventions.md#文档同步更新强制)；行为/契约变了而文档没跟，视为改动未完成。
5. 服务端接口/行为变化时，同步更新 [`doc/server-api.md`](doc/server-api.md)（与仓库根 `docs/server-api.md` 保持一致）。
6. 复杂问题排查需要日志时，按 `doc/conventions.md` 的类型标记写 `tigerAgent_debug.log`。
7. **本目录是独立 git 仓库（`desktop/.git`），提交必须两边都做**：桌面端改动在本仓库 `git commit` 一笔，同时在仓库根镜像提交同一批文件；主项目 tigerAgent 与 desktop 有对应改动时，不允许只提交其中一个仓库。提交说明只描述本区域内容，跨端改动互相点出对方对应的文件。

## 文档索引

| 文档 | 内容（什么时候读） |
| --- | --- |
| [`doc/frontend-architecture.md`](doc/frontend-architecture.md) | SPA 视图模块结构、样式/类型约定、Tauri IPC、多 workspace 并发与 Agent server 模式 |
| [`doc/frontend-agent-conventions.md`](doc/frontend-agent-conventions.md) | Agent 视图错误处理、自动续跑、假完成检测、拖拽保护、每轮撤销入口、轮级对话记录大纲、同目录多会话并行（前台状态模型） |
| [`doc/attachments.md`](doc/attachments.md) | 剪贴板粘贴（三平台差异）与 PDF 分批转图 |
| [`doc/rust-backend.md`](doc/rust-backend.md) | Rust 命令地图、应用自升级、下载链路、VC++ / Vulkan 运行库预检、平台差异 |
| [`doc/agent-server.md`](doc/agent-server.md) | 服务端 loop 抖动恢复、压缩与事实块、系统提示词预算与提示词缓存、归档编号、决策模式、工具与权限边界（撤销清理的会话 ID 校验、bash 只读白名单、工作区包含性判断、符号链接）、代理链路、配置词表 |
| [`doc/agent-context-compaction-flow.md`](doc/agent-context-compaction-flow.md) | 压缩机制全流程：触发路径、参数派生、Summarize 13 步、取回通路、熔断与日志、审核风险点 |
| [`doc/agent-settings.md`](doc/agent-settings.md) | Agent 设置项、推理强度与思考开关、云端模型 `can_reason`、开关写入链路 |
| [`doc/build-and-release.md`](doc/build-and-release.md) | CI、构建与发布、服务端分发（默认不打包）、Linux 打包/更新链路 |
| [`doc/conventions.md`](doc/conventions.md) | 工作边界、工作目录功能归属、代码↔文档同步映射表（改动收尾必查）、调试日志格式与标记 |
| [`doc/server-api.md`](doc/server-api.md) | 服务端 HTTP API（与仓库根 `docs/server-api.md` 同步） |
| [`doc/agent-eval-harness-plan.md`](doc/agent-eval-harness-plan.md) | agent 行为 eval：`tigerAgent eval` + 仓库根 `scripts/eval.{ps1,sh}`、任务/判分器定义、基线判定 |

方案与实施记录（改动相关模块前先读，避免重复踩坑）：

- [`doc/agent-fact-block-and-recall-refs-plan.md`](doc/agent-fact-block-and-recall-refs-plan.md) — 确定性事实块 + 归档编号 `#N` + `recall` 区间/展开取回
- [`doc/agent-parallel-sessions-file-guards.md`](doc/agent-parallel-sessions-file-guards.md) — 同目录多会话并行的服务端写保护
- [`doc/agent-undo-anchor-plan.md`](doc/agent-undo-anchor-plan.md) — 每轮/跨轮撤销的服务端方案（anchor 参数、快照保留窗口、非 git 目录），**待审核，未落地**
- [`doc/agent-prefix-budget-plan.md`](doc/agent-prefix-budget-plan.md) — 固定前缀（系统提示词 + 工具 schema）瘦身与预算守卫：bash 描述里的 git 剧本已搬进 skill、前缀预算单测与日志落地（8.9k），按窗口分档/MCP 延迟未做
- [`doc/agent-patch-bash-allow-all.md`](doc/agent-patch-bash-allow-all.md) — `options.bash_allow_all`
- [`doc/agent-patch-project-memory-sync.md`](doc/agent-patch-project-memory-sync.md) — `options.project_memory_sync`
- [`doc/agent-decision-mode-server-plan.md`](doc/agent-decision-mode-server-plan.md) / [`doc/agent-decision-output-plan.md`](doc/agent-decision-output-plan.md) — 决策输出模式（服务端方案 / 前端 MVP 记录）
- [`../docs/project-management-plan.md`](../docs/project-management-plan.md) — 桌面端「项目管理」标签页（项目列表 / 文件树 / 预览 / Git 状态与差异）+ 服务端文件/Git 接口，**已落地（S1–S5）**；接口契约见 [`doc/server-api.md`](doc/server-api.md) §12，刷新策略见 [`doc/frontend-architecture.md`](doc/frontend-architecture.md#项目管理视图projects)

服务端协议类文档在仓库根 [`docs/`](../docs/)：`server-api.md`、`subagent-model.md`、`tcp-tls-ecdsa.md`、`hooks/`。
