# 前端架构与 IPC（桌面端）

> 范围：`src/` 的 SPA 结构（视图模块 / 样式隔离 / 类型检查）、Tauri IPC 约定，以及多 workspace 并发与 Agent server 模式的跨端分工。

---

## 架构

- **Tauri 2.11.5** + Rust 后端 + **原生 HTML/CSS/JS**（无框架、无打包工具）。
  所有前端源码在 `src/` 目录下，作为 `frontendDist` 原样提供。
- **单窗口 SPA（单页应用）** + hash 路由：
  - `index.html`（外壳）含 `#view-root` + `#agent-layer` 两个互斥显示的视图宿主、底部硬件栏与导航；底部 TAB 固定为 **Agent | 模型管理 | 项目管理 | 源码管理 | 技能管理 | 设置**（默认路由 `#/agent`，未知/空 hash 回退到 Agent 页）。
  - 6 个视图（`agent` / `models` / `projects` / `scm` / `skills` / `settings`）各自为独立 **ES 模块**（`src/views/*.js`），默认导出 `{ template, mount(root, params), unmount(), show?, hide? }`。
  - `agent` 视图已拆分：`src/views/agent.js` 为入口（init/bindEvents/生命周期），具体逻辑在 `src/views/agent/` 子模块（store/template/api/utils/ui/render/session/attach/send/sse/permission/tools/model/workspace/settings_dialog/server_logs/undo）；跨模块共享状态由 `store.js` 统一管理（`store` 为写入入口，`S` 为只读视图，workspace 字段禁止直接写 `S`）。
  - `projects` 视图拆分：`src/views/projects.js` 为入口，子模块在 `src/views/projects/`（api/store/template/projects_list/tree/viewer/diff/git/ui）。文件与 Git 数据全部经 `agent_http_request` 访问**服务端**（桌面端可能连远程服务端，客户端本地 `fs` 不可信）；`src-tauri/` 零改动。diff 解析/渲染、路径归一化与剪贴板写入复用 `src/views/shared/`（`diff.js` / `paths.js` / `clipboard.js`），视图只传各自的 CSS 类名前缀。
  - `scm` 视图拆分：`src/views/scm.js` 为入口，子模块在 `src/views/scm/`（api/store/template/render/ui/diff）。数据同样全部走服务端 HTTP；api 直接复用 `projects/api.js`（HTTP 封装 / 单飞 GET / 错误归类 / 能力探测只有一份），diff 解析与渲染复用 `views/shared/diff.js`，`diff.js` 仅保留提交记录解析。
  - `index.html` 通过动态 `import()` 异步加载视图模块，把 `template`（含 `<style>` 的 HTML 字符串）注入当前视图宿主（`#view-root` 或常驻的 `#agent-layer`），调用 `mount`/`unmount` 管理生命周期。
- CSS/JS **内联**在每个视图模块的 `template` 字符串或模块函数内，保持零运行时依赖。
- **样式隔离约定**：全局 reset（`* {}`）与 `body` 样式只由 `index.html` 壳层提供，视图内不得重复定义；视图选择器带视图前缀（`agent-*` / `settings-*` 等）；视图内元素 id 不得与壳层 id（`app` / `view-root` 等）重复。
- **类型检查**：`jsconfig.json` 开启 `checkJs`，全局类型声明在 `src/types.d.ts`；历史视图暂以 `// @ts-nocheck` 豁免，新代码不得新增此标记（用 JSDoc 注解）。未配置 linter、formatter 或测试框架。

## 视图切换与状态保持

- **Agent 视图常驻**：首次进入 `#/agent` 时挂载到 `#agent-layer`，之后切到其它页面只把该层 `display:none` 并触发 `hide()`，**不调用 `unmount`**：SSE 订阅、流式渲染中的 DOM、滚动位置、`S` / `store` 状态全部保留；切回时只恢复显示 + `show()` 并淡入，不重跑 `init`、不重拉会话列表。Agent 运行中允许离开页面，运行态显示在后台继续更新。
- 其它视图仍是「进入挂载 / 离开卸载」：挂在 `#view-root`，`unmount` 解绑事件与定时器。两个宿主由 `showHost()` 互斥显示，过渡仍是 opacity fade-out / fade-in（160ms / 200ms，模块加载超过 180ms 才出加载态）。
- `show()` 负责隐藏期间无法测量的部分：重算轮容器 `--round-max-h`、刷新「回到底部」按钮，自动跟随模式（`S.manualScrollMode === false`）下补一次贴底；`hide()` 收起 body 级 / 全局浮层（工作目录下拉、对话大纲、右键复制粘贴菜单）。新增需要后台保活的视图按同一模式接入路由，并在 `hide()` 里显式收起自己的浮层。
- 底部导航的忙碌角标来自 `agent-busy-changed`；「后台跑完」只做未读提示，不强行切页、不改变用户当前所在页面。

## IPC 注意事项（重要）

- SPA 运行在 Tauri 主窗口内，**直接**调用 `window.__TAURI__.core.invoke` / `.event.listen`，无需 `postMessage` 代理。
- `index.html` 初始化时把 `window.__agent_invoke` / `window.__agent_listen` 暴露给所有视图模块；视图模块通过这两个全局引用调用 IPC。
- **共享状态** `window.__agent_state`（`agentBusy`：任一 workspace 有运行在飞）跨视图共享，切换不丢。它只用于底部导航的忙碌/完成角标（运行中脉冲点、后台完成时未读点 + 轻提示），**不拦截页面切换**；变化时 `store.syncAgentBusy()` 派发 `agent-busy-changed`，壳层监听更新 UI。
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
- 底部服务端状态栏（`index.html` 的 `#hw-items`）在页面首次打开时即与首屏渲染、服务端自检**同时并行**拉取一次
  `get_system_info`（服务端 `GET /v1/system/info`；异步 fire-and-forget，不阻塞 `init`），之后每 5s 轮询。
  `get_system_info` 在全局目标未初始化时会按当前连接串自行解析（见 `rust-backend.md`），首屏不依赖 Agent 会话建链。
  显示 CPU 使用率、内存已用/总量、数据卷可用/总量；显卡（显存）显示与探测已删除。服务端未连接时首次失败
  显示「未连接」，之后保留上次数值；保存连接成功后调用 `window.Agent.refreshSystemInfo()` 立即刷新。

## Agent server 与多 workspace 并发

- **服务端连接（TCP + TLS，无本地进程）**：桌面端**不启动、不探测、不终止**服务端进程，服务端由用户在服务器侧自行启动（`tigerAgent --host tcp://0.0.0.0:<端口>`）并把打印的连接串粘贴到设置页。`start_agent_server` 只做「解析连接串 → TLS 握手 + `/v1/health` 探活 → `POST /v1/workspaces` → 起 SSE 转发」，连不上直接报错并引导去设置页。HTTP API 通过 `agent_http_request` 代理（hyper + rustls 直连 TLS 流，每个请求带 `Authorization: Bearer`），SSE 事件通过 Tauri event `agent-sse-event` 转发给前端；连续建连失败达阈值（3s×5）时 emit `agent-connection-lost`，前端重连一次并提示检查服务端。
- **多 workspace 并发架构**：单 Agent server 进程支持多个 workspace 同时干活。每个 workspace 有独立的 `AgentCoordinator`/SQLite DB/SSE 转发任务。Rust 后端 `AppState.agent_sessions: HashMap<String, AgentServerSession>` 按 workspace_id 索引各会话，`agent_child` 全局共享子进程，`active_workspace_id` 跟踪当前 tab。前端 `S.workspaces[wsId]` 状态池存各 workspace 的会话/消息/运行状态，切换 tab 时保存当前+恢复目标，不中断旧 workspace 的 agent run。SSE 事件携带 `workspace_id`，前端只处理当前激活 tab 的事件。

## 模型管理视图（`#/models`）

- **定位**：底部 TAB「模型管理」（Agent 右侧）。原「云端模型管理」从 Agent 设置弹窗迁出——它管理的是服务端全局 provider 配置，与单个会话/设置无关；Agent 设置弹窗只保留推理强度/温度/多模态模型等会话级设置。
- **数据来源**：`list_cloud_providers` / `add_cloud_provider` / `update_cloud_provider` / `delete_cloud_provider`（Rust → 服务端 `GET|POST /v1/settings`）。页面与 Agent 页共享 `agent/store.js` 的 `S`，每次增删改后刷新 `S.providers`（有 workspace 时顺带刷新 `/providers` 快照），保证模型下拉与本列表一致；服务端写入后会重载所有 workspace 配置，无需重启。
- **独立打开**：本视图可能在 Agent 页建链之前打开，mount 时先调 `ensure_server_target` 把保存的连接串应用进全局 active target，再拉 `/v1/settings`；未配置连接串/服务端不可达时在页面内提示，引导去「设置 → 服务端连接」。
- **弹窗**：添加/修改复用同一表单（标题/按钮按模式切换），模型 ID 候选走 Rust `probe_models_endpoint`（绕开 WebView CORS）。删除确认与结果提示用视图内自建遮罩/提示条——`agent/ui.js` 的 `showConfirm` / `showNotice` 分别挂在 `.agent-root` 与聊天消息区，切到其它 TAB 时不可见，不能复用。

## 项目管理视图（`#/projects`）

- **视图结构**：左栏顶部工作目录下拉选择器（Rust `get_workdirs` ∪ `GET /v1/workspaces`，按路径去重，默认显示上次选中的工作目录）+ 下方懒加载文件树（默认全部收起，只显示项目根节点）；右侧 TAB 为 `预览 / 差异`，默认显示源文件内容，差异 TAB 仅在选中文件有 Git 变更时出现（双击变更文件可直接打开差异），差异内可切工作区/暂存。Git 命令面板已移除，受控执行能力只在源码管理视图提供。目录一次只拉一层（`GET /v1/workspaces/{id}/files`），Git 状态由服务端 `git status --porcelain=v1 -z` 解析，目录颜色由前端按子树最高优先级聚合。
- **workspace 存活依赖 SSE**：服务端在最后一条 SSE 流断开且无 hold 时会 teardown workspace。项目页每次选中项目都调用 `create_workspace({path, clientId})`（服务端按 path 幂等、Rust 复用已有 SSE 任务），返回的 `workspace_id` 作为后续所有请求的 id；不调用 `switch_workspace`（会改 Agent 页的激活 workspace）。
- **嵌套仓库**：主目录不是仓库但子目录是仓库时，服务端聚合子仓库状态（`nested_repos`），树与差异照常着色；状态栏显示「子目录 Git 仓库: N 个」。
- **能力门禁**：进入页面先 `GET /v1/version`；缺 `workspace_files` 整页提示升级，缺 `workspace_git` 隐藏颜色/差异，只保留文件浏览。
- **刷新矩阵**：进入页面/切换项目重载根目录并拉状态；展开目录只拉该层；手动刷新重载根 + 已展开目录；SSE `file` / `run_complete`（同 workspace）标记 stale 并防抖 800ms 后拉状态，已展开目录 ≤10 时自动重载，否则提示「文件已变化，点击刷新」；页面可见时每 15s 轮询 `git/status`（仅 `is_repo && git_installed`，失败退避 30s，隐藏页暂停）。当前选中文件按当前 TAB 重新拉取（预览内容或差异）。
- **渲染安全**：文件内容、diff、路径全部是服务端不可信文本，只能用 `textContent` / DOM 节点写入，禁止 `innerHTML` 拼接。
- **接口契约**：见 [`server-api.md`](server-api.md#12-文件与-git-接口项目管理)（§12）。

## 源码管理视图（`#/scm`）

- **定位**：与「项目管理」并列的独立视图，布局参考 VSCode 源代码管理器：左栏 `源代码管理`（仓库下拉 + 分支行 + 提交信息框 + `更改` / `已暂存的更改` 两个列表 + `图表` 提交图），右侧差异区。项目管理偏「浏览文件 + 查看差异」，源码管理偏「暂存 → 提交 → 看提交图」的集中工作流；两者共用服务端 §12 接口，不新增端点。
- **数据与能力**：`/v1/version` 的 `workspace_git` 缺失时整页提示升级；`workspace_git_exec` 缺失时降级为只读（可看状态/差异，隐藏提交框与暂存/丢弃/图表）。写操作只走 `POST /git/exec` 的白名单命令：`add_file` / `unstage_file` / `add_all` / `unstage_all` / `commit`（`ack=normal`，提交按钮本身即用户显式确认）/ `restore_file`（`ack=strong`，前端强确认）/ `log`（图表）。
- **布局状态**：分栏宽度存 `localStorage["scm.sidebarWidth"]`；提交信息按工作目录草稿持久化（`scm.draft.<path>`，提交成功后清空）；`更改 / 已暂存 / 图表` 的折叠状态（`scm.sectionsCollapsed`）、图表「自动」开关（`scm.graphAuto`）与差异布局（`scm.diffView`，默认 `split` 并排，可切 `unified` 统一）也存 localStorage。
- **工作区与刷新**：与项目页相同，每次选中仓库调用 `create_workspace({path, clientId})` 并依赖 SSE 保活；首次进入复用 `localStorage["projects.activePath"]`，之后记在 `scm.activePath`。页面可见时每 15s 轮询 `git/status`（失败退避 30s，动作执行/隐藏页暂停）；SSE `file` / `run_complete`（同 workspace）防抖 800ms 后刷新状态与当前差异。提交图表走 `git/exec` 的 `log`（`limit=40`），仅在展开且「自动」开启时随状态刷新重新拉取（最短间隔 30s）。
- **提交与丢弃语义**：提交按钮默认「已暂存优先」——有暂存内容直接 `commit`；没有任何暂存但有未提交更改时弹确认「暂存全部并提交」（先 `add_all` 再 `commit`）。`restore_file` 属强确认：单文件要求输入文件名，全部丢弃要求勾选确认；未跟踪文件没有删除接口，前端不提供丢弃入口。非仓库（主目录只聚合子目录仓库）时隐藏全部写操作，只允许查看差异。
- **图表与历史提交**：点击图表里的提交行展开该提交改动的文件列表（`git/exec` 的 `show_commit`，服务端 `git show --name-status -z`，前端按 NUL 解析 `M\0path\0` / `R100\0old\0new\0`，结果按 hash 缓存）；点击文件在右侧展示该提交中此文件的 unified diff（`commit_file_diff`，`path` 允许工作区已删除的历史路径）。右侧顶栏显示 `提交 <hash>` 与「返回工作区」，工作区/暂存切换在历史模式下隐藏；展开状态只在当前会话内保留，切换仓库时清空。
- **图表排版与悬停卡片**：图表固定不出横向滚动条——提交行用 flex（caret / graph / hash / 说明）布局，说明部分 `text-overflow: ellipsis` 截断；悬停提交行 180ms 后在侧栏右侧弹出详情卡片（`commit_detail`：作者、时间、完整 subject/body、`已更改 N 个文件, X 行插入(+), Y 行删除(-)`），卡片可悬停阅读、滚动图表或鼠标移开后收起，详情按 hash 缓存。卡片是 `position: fixed`，定位时以底部 TAB 栏（`#hardware-bar`）的顶边为下界（不再是 `window.innerHeight`）：上方空间够就整体上移，不够则压卡片自身的 `max-height`，保证任何窗口高度下都不会盖住底部 TAB 栏。
- **子目录 Git 仓库**：主目录不是仓库、子目录里有仓库（如 `tt/pi`）时，服务端在 `git/status` 返回 `nested_repos` 并把子仓库变更聚合进 `entries`。视图会把这些子仓库登记为独立可选仓库（下拉「子目录 Git 仓库」分组，`localStorage["scm.nestedRepos"]` 持久化），并在首次进入/刷新父目录时自动切换到第一个子仓库——以子仓库为 workspace 路径重新 `create_workspace`，从而拿到完整的暂存/提交/图表能力；手动从下拉选择父目录（`selectProject(project, {autoNested:false})`）时保持聚合只读视图，不会自动跳走。子仓库路径由「workspace 绝对路径 + 相对根」拼接，Windows/Linux 分隔符自适应。
- **渲染安全**：路径、diff、`git log` 输出全部是服务端不可信文本，只用 `textContent` / DOM 节点写入；行内按钮的 `data-action` 与 `data-path` 由前端常量生成，不拼接服务端 HTML。
- **接口契约**：与项目页共用 [`server-api.md`](server-api.md#12-文件与-git-接口项目管理)（§12）。
