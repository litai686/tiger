# 工作边界、文档同步与调试日志

> 范围：改动范围约定（桌面端 / TUI）、Agent 目录只读、工作目录功能归属、**代码 ↔ 文档同步更新映射表**，以及统一调试日志的写入方式与类型标记。

---

- Agent api文档在 `doc/server-api.md`
- Agent 源码在 `Agent` 目录下，有不清楚的地方可以直接搜索源码确定后再决定怎么改，Agent源码目录只能读，不能有任何修改和写入动作，如果真的发现是Agent的问题，先列出问题和需要改动的地方给我审核
- **改动必须区分桌面端和 TUI**：每次改动前必须先告知用户改动目标是桌面端（`src/` + `src-tauri/`）还是 TUI 端（`Agent/`），未经明确指示不混改两端。
- **工作目录切换功能仅桌面端**：TUI 只显示当前工作目录（PrettyPath），不做切换/下拉/添加/删除。所有工作目录切换 UI 在桌面端实现。

## 文档同步更新（强制）

**代码改动与对应文档必须在同一次改动里一起更新**，不留 TODO、不留到「下次」。`AGENTS.md` 只是索引，正文全在 `doc/`；文档与代码冲突时以代码为准，但责任在改动方——发现描述过期要顺手修正。

映射表（按改动落点找文档，一次改动可能同时命中多行）：

| 改动落点 | 必须同步更新 |
| --- | --- |
| 外壳 / 视图模块 / 路由 / IPC 调用方式（`src/index.html`、`src/views/*.js`、`jsconfig.json`、`src/types.d.ts`） | [frontend-architecture.md](frontend-architecture.md) |
| Agent 视图交互与状态（`src/views/agent/` 的 store / render / ui / sse / autocontinue / workspace 等） | [frontend-agent-conventions.md](frontend-agent-conventions.md) |
| 剪贴板粘贴、PDF 附件（`attach.js`、`pdf.js`、`pdf_batch.js`、`src/vendor/pdfjs`、Rust 侧 `read_clipboard_files` / `clipboard_*`） | [attachments.md](attachments.md) |
| `src-tauri/src/**`（除构建链路：自升级、下载、平台差异） | [rust-backend.md](rust-backend.md) |
| Agent 设置项与开关写入链路（`settings.rs` / `agent.rs` 的 `sync_*`、`settings_dialog.js`、`memory.js`、`models.js`（云端模型管理 TAB）、模型下拉） | [agent-settings.md](agent-settings.md) |
| Agent 服务端行为与前后端契约（loop / 压缩 / 事实块 / 归档编号 / 决策模式 / 代理 / 配置词表 / 新增 part 类型） | [agent-server.md](agent-server.md) |
| CI、打包、服务端分发（默认不打包）与更新链路（根目录 `.github/workflows/build.yml`、`prepare-agent-binary.mjs`、`tauri.conf.json` 打包项） | [build-and-release.md](build-and-release.md) |
| 调试日志标记、工作边界与流程约定 | 本文件 |
| HTTP API 端点 / 字段（`Agent/internal/server`、`internal/proto`） | [server-api.md](server-api.md) |
| agent 行为 eval（`Agent/internal/eval`、`internal/cmd/eval.go`、`Agent/scripts/eval.*`、fixture / 任务 JSON / 基线） | [agent-eval-harness-plan.md](agent-eval-harness-plan.md) |
| 新增 / 删除 / 改名文档，或模块归属变化 | `AGENTS.md` 的「文档索引」「项目结构」 |

规则：

- **新增约定写进对应主题文档**，不要堆回 `AGENTS.md`；索引里最多加一行。
- **写清「为什么」**（踩坑原因、被否掉的做法），不要只写「已实现 X」，否则下次会把同一个坑再踩一遍。
- 引用代码优先写符号名 / 文件路径，**尽量不写行号**（会过期）；确有必要写行号时，改到该处就同步更新。
- 契约字符串（开关名、配置键、事件名、错误 token，如 `thinking_mode_unsupported`、`options.bash_allow_all`）必须与代码逐字一致，改契约就改文档。
- 方案 / 实施记录（`doc/*-plan.md`、`doc/*patch-*.md`）是历史记录，**不随实现演进改写**；行为变化写进主题文档，必要时在记录开头补一行「后续变更见 …」。
- 收尾自检：本次每个改动落点都能在上表命中，且对应文档已更新。

## 调试日志（`tigerAgent_debug.log`）

- **调试日志统一写入 `tigerAgent_debug.log`**：复杂问题排查需要日志时，Rust 端用 `api_debug_log!`，前端 JS 用 `invoke("agent_debug_log", { line: "..." })`，统一写入 `~/Library/Application Support/com.tiger.agent/tigerAgent_debug.log`（macOS）或 `程序目录\tigerAgent_debug.log`（Windows；`get_data_dir` 在 Windows 返回 exe 同目录，即安装目录下）。日志必须带类型标记便于过滤：
  - `UI:` 前缀 — 前端 JS 日志（SSE 事件过滤、状态变更、消息处理等）
  - `HTTP >` / `HTTP <` — HTTP 请求/响应
  - `SSE =` / `SSE !` — SSE 连接/断开
  - `< message created` / `< run_complete` / `< agent_event` — SSE 事件转发
  - `UpdateModels:` / `readyWg:` — Agent 服务端诊断日志
  日志格式：`{epoch_ms} {HH:MM:SS.mmm 本地时间} {类型标记} {内容}`，由 Rust 端统一格式化。调试模式开关：设置→调试模式（`config.json` 的 `debug_logging` 字段）。
- **Agent 崩溃日志单独落盘**：服务端自身的 slog 写 `%LOCALAPPDATA%\tigerAgent\cache\tigerAgent.log`（每次启动截断），panic 栈写同目录的 `tigerAgent-panic.log`（只追加，超 8MB 轮转为 `.prev`；每进程启动写一行 `process start pid=`）：回合 goroutine 的 recover 走 `log.WritePanic("agent.run", …)`，recover 不到的 fatal（并发 map 写、栈溢出等）由 `debug.SetCrashOutput` 兜底。排查“对话突然中断/服务异常退出”先看这个文件，再看 `tigerAgent_debug.log` 的 `SSE !` 时间线。
- **服务端日志无需登录服务端主机也能看**：服务端暴露 `GET /v1/logs`（列表）、`GET /v1/logs/{name}?tail=N`（文本）、`?download=1`（整文件下载，见 `docs/server-api.md` §1.11），桌面端入口在 设置 → 服务端日志（`src/views/agent/server_logs.js` + Rust `pages/logs.rs`）。远程部署时客户端本机没有 `tigerAgent.log`，**不要**再假设“打开日志目录”能拿到服务端日志；那条按钮（`open_debug_log_dir`）只对客户端自己的 `tigerAgent_debug.log` 有效。
