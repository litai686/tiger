# 前端架构与 IPC（桌面端）

> 范围：`src/` 的 SPA 结构（视图模块 / 样式隔离 / 类型检查）、Tauri IPC 约定，以及多 workspace 并发与 Agent server 模式的跨端分工。

---

## 架构

- **Tauri 2.11.5** + Rust 后端 + **原生 HTML/CSS/JS**（无框架、无打包工具）。
  所有前端源码在 `src/` 目录下，作为 `frontendDist` 原样提供。
- **单窗口 SPA（单页应用）** + hash 路由：
  - `index.html`（外壳）含 `#view-root` 容器、底部硬件栏与导航；底部 TAB 固定为 **Agent | 技能管理 | 设置**（默认路由 `#/agent`，未知/空 hash 回退到 Agent 页）。
  - 3 个视图（`agent` / `skills` / `settings`）各自为独立 **ES 模块**（`src/views/*.js`），默认导出 `{ template, mount(root, params), unmount() }`。
  - `agent` 视图已拆分：`src/views/agent.js` 为入口（init/bindEvents/生命周期），具体逻辑在 `src/views/agent/` 子模块（store/template/api/utils/ui/render/session/attach/send/sse/permission/tools/model/workspace/settings_dialog/server_logs/undo）；跨模块共享状态由 `store.js` 统一管理（`store` 为写入入口，`S` 为只读视图，workspace 字段禁止直接写 `S`）。
  - `index.html` 通过动态 `import()` 异步加载视图模块，把 `template`（含 `<style>` 的 HTML 字符串）注入 `#view-root`，调用 `mount`/`unmount` 管理生命周期。
- CSS/JS **内联**在每个视图模块的 `template` 字符串或模块函数内，保持零运行时依赖。
- **样式隔离约定**：全局 reset（`* {}`）与 `body` 样式只由 `index.html` 壳层提供，视图内不得重复定义；视图选择器带视图前缀（`agent-*` / `settings-*` 等）；视图内元素 id 不得与壳层 id（`app` / `view-root` 等）重复。
- **类型检查**：`jsconfig.json` 开启 `checkJs`，全局类型声明在 `src/types.d.ts`；历史视图暂以 `// @ts-nocheck` 豁免，新代码不得新增此标记（用 JSDoc 注解）。未配置 linter、formatter 或测试框架。

## IPC 注意事项（重要）

- SPA 运行在 Tauri 主窗口内，**直接**调用 `window.__TAURI__.core.invoke` / `.event.listen`，无需 `postMessage` 代理。
- `index.html` 初始化时把 `window.__agent_invoke` / `window.__agent_listen` 暴露给所有视图模块；视图模块通过这两个全局引用调用 IPC。
- **共享状态** `window.__agent_state`（当前只有 `agentBusy`：Agent 运行中禁止离开页面）跨视图共享，切换不丢。
- 视图 `mount` 时 `listen()` 保存 unlisten 句柄，`unmount` 时统一调用以防事件重复绑定（泄漏）。
- **Agent 页面**（`src/views/agent.js`）为独立 ESM 视图，由路由 `#/agent` 加载，不再使用 iframe / PTY 终端。
- 页面间导航：使用 `location.hash = "#/agent"` 等 hash 路由。

## 启动自检：服务端配置与健康

- 桌面端只有一种连接方式：**用户自行启动的 TCP + TLS 服务端**（本地 sidecar / unix socket /
  named pipe 已全部移除）。外壳 `index.html` 在 `renderRoute()` 之后并行跑一次
  `checkServerOnStartup()`（不阻塞首屏），顺序是 **① 连接参数是否完整 → ② 已配置则确认能否连上**，
  任一不满足就弹 `#server-alert-overlay`「服务端异常，请检查配置」，
  确认后 `navigateTo("/settings?panel=server")`。
- 判定口径（复用已有命令，不新增 Rust 侧检查）：
  - 参数完整性用 `get_server_connection`：连接串（地址 + 服务端指纹 + token）缺失或解析失败时
    `server_mode::parse_connection` 返回 `error`（`configured=false`），直接把缺什么告诉用户。
  - 可用性用 `test_server_connection`（`/v1/health` → 带 token 的 `/v1/workspaces`）。轮询 1.5s 间隔、15s 上限：服务端可能刚重启，
    短暂重试比一次判定更贴近真实情况；超时后顺手提示去设置页点「检测服务端」。
- 设置页读路由参数 `?panel=xxx`（`mount(root, params)`）直接切到目标面板；`?panel=server`
  时自动跑一次 `runServerCheck()`。该函数与启动自检用同一组命令，区别是不轮询，并在「连接检测」
  区域输出逐行结果（配置 → 指纹 → 健康检查 → 耗时）。
- 服务端连接面板只提供一步配置：复制服务端启动时打印的连接串（或 `tigerAgent --print-connection`），
  整条粘贴 → 「保存并应用」。保存成功后自动复用 `runServerCheck()` 检测连通性：连通提示「保存成功」
  并立即刷新底部服务端状态栏，失败提示「连接失败」（详细原因写在「连接检测」区域）；顶部「检测服务端」
  仍可手动复检。客户端不再生成设备身份，也没有 `pair --approve` 步骤；
  面板不再有「本地/远程」模式选择（`server.mode` 已删除，旧字段被忽略）。
- 底部服务端状态栏（`index.html` 的 `#hw-items`）每 5s 轮询 `get_system_info`（服务端 `GET /v1/system/info`），
  显示 CPU 使用率、内存已用/总量、数据卷可用/总量；显卡（显存）显示与探测已删除。服务端未连接时首次失败
  显示「未连接」，之后保留上次数值；保存连接成功后调用 `window.Agent.refreshSystemInfo()` 立即刷新。

## Agent server 与多 workspace 并发

- **服务端连接（TCP + TLS，无本地进程）**：桌面端**不启动、不探测、不终止**服务端进程，服务端由用户在服务器侧自行启动（`tigerAgent --host tcp://0.0.0.0:<端口>`）并把打印的连接串粘贴到设置页。`start_agent_server` 只做「解析连接串 → TLS 握手 + `/v1/health` 探活 → `POST /v1/workspaces` → 起 SSE 转发」，连不上直接报错并引导去设置页。HTTP API 通过 `agent_http_request` 代理（hyper + rustls 直连 TLS 流，每个请求带 `Authorization: Bearer`），SSE 事件通过 Tauri event `agent-sse-event` 转发给前端；连续建连失败达阈值（3s×5）时 emit `agent-connection-lost`，前端重连一次并提示检查服务端。
- **多 workspace 并发架构**：单 Agent server 进程支持多个 workspace 同时干活。每个 workspace 有独立的 `AgentCoordinator`/SQLite DB/SSE 转发任务。Rust 后端 `AppState.agent_sessions: HashMap<String, AgentServerSession>` 按 workspace_id 索引各会话，`agent_child` 全局共享子进程，`active_workspace_id` 跟踪当前 tab。前端 `S.workspaces[wsId]` 状态池存各 workspace 的会话/消息/运行状态，切换 tab 时保存当前+恢复目标，不中断旧 workspace 的 agent run。SSE 事件携带 `workspace_id`，前端只处理当前激活 tab 的事件。
