# Rust 后端（桌面端，`src-tauri/src/`）

> 范围：Rust 侧命令地图、应用自升级、下载链路与平台差异。构建/发布流程见 `doc/build-and-release.md`。

---

## 模块与关键命令

| 模块 | 关键命令 |
|--------|-------------|
| `index.rs` | `get_system_info`（底部硬件栏）, `check_update`, `download_app_update`, `install_app_update`（应用自升级，见下） |
| `settings.rs` | `save_settings`（直接写 `config.json` 后 `sync_all`；不用 `.tmp` + `rename`，避免 macOS 上 rename 因文件系统属性/沙盒失败）, `load_settings`, `get_app_version`, `get_tauri_version`, `get/set_server_connection`（解析并保存连接串，保存后立即 `server_mode::apply`）, `test_server_connection`（TLS 握手 + pin 校验 + `/v1/health` + 带 token 的 `/v1/workspaces`）, `ensure_server_target`（只把保存的连接串解析进全局 active target，不发网络请求；非 Agent 页面〔如模型管理〕在建链前需要它） |
| `agent.rs` | `start_agent_server`（连接用户自行启动的 TCP + TLS 服务端并建 workspace 会话，不拉起进程；建 workspace 前先读服务端 `settings.work_directories` 默认项，无配置/读取失败用 `.`，只有目标目录在服务端不存在/不是目录（`POST /v1/fs/validate` 判定）时才回退 `.`，超时 / 5xx 原样上报；本机 `agent_workdir` 只作离线 UI 缓存）, `stop_agent_server`（断开会话/SSE）, `get_agent_server_status`（本进程是否已建好会话）, `get_server_version`（`GET /v1/version`，版本页显示服务端版本）, `agent_http_request`, `agent_subscribe_events`, `agent_unsubscribe_events`, `add/list/update/delete_cloud_provider`（`list` 过滤自动管理的 `local` 与服务端内置 `tigerAgent`，内置模型只从 `/providers` 快照进入下拉）, `probe_models_endpoint`（请求云端模型的 OpenAI 兼容 `{base}/models`，10s 超时，返回模型 ID 列表；走 Rust 是为了绕开 WebView 的 CORS，同 `fetch_skill_store`）, `download_workspace_file(workspace_id, path)`（`GET /v1/workspaces/{id}/files/raw` 流式取原始字节〔二进制安全、无大小上限〕，先弹系统保存对话框再传输，读取期间按整百分比〔无 Content-Length 时每 256KB〕发 `workspace-download-progress` 事件 `{workspace_id, path, received, total}` 供按钮显示进度，落盘后返回本地路径；项目管理「下载」按钮与文件树右键「下载到本地」，query 路径经 `percent_encode` 编码） |
| `logs.rs` | `fetch_server_logs`（`GET /v1/logs`，服务端日志文件列表）, `fetch_server_log_text(name, tail)`（`GET /v1/logs/{name}?tail=N`，文本透传）, `download_server_log(name)`（`?download=1` 取整文件 + 系统保存对话框落盘，返回本地路径）——服务端可能不在本机，日志只能经 API 取回 |

## 关键注意事项（自升级 / 下载 / 检测）

- **软件自升级（桌面端，检测到新版本即弹窗 → 后台下载 → 提示升级）**：更新清单固定为 `https://tiger.kuda520.com/update.json`（`pages/index.rs` 的 `UPDATE_INFO_URL`，各平台 `appUrl` 安装包地址与 `content` 升级日志链接都由它下发；`content` 缺失不报错，只是不显示「查看升级日志」按钮）。启动 3 秒后的更新检查**一旦检测到新版本就弹出升级窗口**（含「查看升级日志」按钮，直接打开 `content` 链接），窗口内后台下载安装包到 `app_data_dir/updates`（文件名 `Tiger-<版本>-<URL 文件名>`；**必须带版本号**，否则下载地址不带版本号时同名文件会被断点续传逻辑当成"已下载完成"，用户升到的还是旧版本），下载完成后在窗口内提示是否立即升级（点过「后台下载，稍后再说」的会在就绪时补弹）。前端状态机在 `index.html`（`appUpdate{status: downloading|ready|error, changelogUrl}`；统一入口 `window.Agent.startAppUpdate(result,{manual})`，settings 页「检查新版本」复用同一入口并在 manual 时展示下载进度）：选「稍后再说」保留安装包，重启后同名文件存在即秒回已就绪并再次提示；选「跳过此版本」写 localStorage `tiger_skip_update_version`，静默检查不再打扰、手动检查仍提示。升级日志按钮由 `changelogButton(url)` 生成，链接存在模块变量里、`onclick` 只调用固定函数 `openChangelog()`（远端下发的地址不拼进 `onclick`，避免转义逃逸）。Rust 端两个命令（`pages/index.rs`，已在 `lib.rs` 注册）：`download_app_update(version,url)`（发 `app-update-progress` 事件、下载前清理其它版本残留包）、`install_app_update(path)`（只允许运行 updates 目录内的文件 → 拉起/执行安装 → `cleanup_processes` + `app.exit(0)`；安装包 Windows 用 `DETACHED_PROCESS|CREATE_NEW_PROCESS_GROUP` 并尝试脱离 Job，macOS 走 `open <dmg>`，Linux 按扩展名分流——**deb 必须走包管理器，直接 exec 会 ENOEXEC**：`pkexec --disable-internal-agent env DEBIAN_FRONTEND=noninteractive apt-get install -y --allow-downgrades --no-install-recommends <deb>`，输出重定向到 `<包名>.install.log` 且必须等退出码（失败/授权取消时保持应用运行，弹窗展示 `sudo apt install` 指引与 apt 输出尾段；`--disable-internal-agent` 防止 pkexec 内部文本代理从 null stdin 读密码把弹窗挂到超时），AppImage 则在 `$APPIMAGE` 存在时用临时文件 + rename 覆盖当前 AppImage 后再启动，否则只补可执行位拉起）。该命令...
- **撤销能力探测已迁到服务端**：工作目录在服务端主机，桌面端跑 `git rev-parse` 只会误报「不是仓库」。现在由 `GET /v1/workspaces/{id}/git-info` 返回 `{path, exists, git_installed, is_repo}`（见 `doc/agent-server.md` 与 `doc/server-api.md`），前端 `undo.js` 按 workspace 缓存；`exists=false` 表示服务端看不到该目录。旧的 Rust 命令 `check_git_repo` / `save_attachment_file` / `read_project_memory` / `update_project_memory` 已删除（分别由 git-info、base64 附件、project-memory 端点取代）。`pick_workdir_folder`（本机原生目录选择框）同样已删除——「添加工作目录」改由前端经 `GET /v1/fs/list` 浏览服务端目录、`POST /v1/fs/validate` 校验（见 `frontend-agent-conventions.md`），不要再加回本机选择框。
- **硬件信息只来自服务端**：`get_system_info` 读 `GET /v1/system/info`（CPU 使用率、内存已用/总量、数据卷可用/总量），桌面端不再采集本机硬件——`sysinfo` 依赖、`common/utils/platform.rs` 的本机 GPU 枚举与 `AppState.sys` 均已删除，hwinfo 插件依赖（Rust + 前端）与对应 capability 也已移除，前端不再读其数据。该接口不含显卡字段（服务端已删除 `nvidia-smi` 探测）；前端底部状态栏在页面首次打开时与首屏并行拉取一次（异步、不阻塞初始化），之后每 5s 轮询一次，保存服务端连接成功后会立即刷新一次。全局 active target 尚未初始化时（首屏早于 Agent 会话建链），命令内部会按当前连接串调用 `server_mode::apply` 自行解析并落地目标，因此首次打开页面即可拿到服务端硬件，不必等 Agent 页连上后靠下一轮轮询恢复。
- **`agent_http_request` 的成功判定是 2xx**：`200` / `201`（如 `POST /v1/workspaces/{id}/terminals` 新建终端）/ `202` 解析响应体 JSON 返回（202 带 body 的是 `/v1/lsp/fix|install|uninstall` 等异步 job 接口，前端靠 `job_id` 轮询进度；`/agent` 发消息的 202 无 body，空 body / 解析失败回落 `{}`）；`204 No Content` 返回 `{}`。只有非 2xx 才把响应体包成 `HTTP <code> <METHOD> <path>: <body>` 抛给前端。以前只把 200/202/204 当成功，201 会被当成错误，终端视图把「新建终端」的成功 JSON 原样显示在红色提示条里；202 曾一律丢 body 返回 `{}`，LSP 安装永远报 "missing job_id"。新增 2xx 端点时不要再改回逐个枚举。
- **终端 PTY 事件复用已有 SSE 转发**：服务端新增的 `terminal_event`（`output` / `state`）走同一个 workspace `/events` 流，`forward_sse_events` 逐条 emit `agent-sse-event`，`src-tauri/` 不需要新增 PTY/SSH 客户端或事件通道；终端视图只按 `evt.workspace_id` 与 `evt.data.type === "terminal_event"` 过滤。**`views/agent/sse.js` 必须在写日志/分发之前直接忽略 `terminal_event`**：终端输出频率极高（每次按键回显、每 16ms 一块），debug 模式开启时逐条 `console.log` + `agent_debug_log` IPC + 文件写入会把回显拖到几百毫秒；终端有独立监听器负责渲染。SSE 分帧用 `buffer.drain(..pos + 2)` 原地前移残留数据，不要写成 `buffer = buffer[pos + 2..].to_string()`：后者每处理一个事件就把剩余缓冲区整段复制一次（一个 chunk 里 N 个事件即 O(n²)），大块输出时会拖慢回显事件转发。
- **高频命令复用共享 HTTP 客户端**：`agent_http::shared_client` 按 target（host/port/pin/token）缓存进程级 `AgentHttpClient`，复用 hyper 的 keep-alive 连接池；`agent_http_request` 与 `agent_local_client` 都必须用它，禁止每次请求 `build_client`（否则每个按键/轮询都重新做 TCP + TLS 1.3 握手）。target 变化或 `teardown_agent_sessions` 时 `reset_shared_client()` 丢弃旧池，避免复用已断开的连接。终端 `input`/`resize`/`attach` 这类按键级控制请求不写 `tigerAgent_debug.log`，避免高频文件 IO。

## 平台差异

- **Windows**：`main.rs` 中的 `#![windows_subsystem = "windows"]` + `build.rs` 中的 `/SUBSYSTEM:WINDOWS` 隐藏控制台。
- **Linux**：数据目录（config.json / agent 数据）与 macOS 一致走用户数据目录（`config.rs` 的 `get_data_dir` → `~/.local/share/com.tiger.agent`）——deb 装在 `/usr/bin`、AppImage 是只读挂载点，写 exe 同目录必然失败；桌面端**不打包也不启动服务端**，只通过 TCP + TLS 1.3 连接用户自行启动的 `tigerAgent --host tcp://…`（设置页粘贴服务端打印的连接串，解析见 `common/server_mode.rs`）。

## 进程清理

- **窗口关闭**：`on_window_event` 走 `cleanup_processes`——只清理 Agent server 子进程（本进程拉起的才杀），不再有本地推理进程需要回收。
