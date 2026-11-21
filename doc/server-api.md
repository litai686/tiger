# Agent Server 模式 API 文档

> 本文档面向 GUI 客户端开发者，涵盖 Agent server 模式下所有 HTTP API 端点。
>
> 路由注册源码：`internal/server/server.go` → `installHandler()`
>
> Handler 实现：`internal/server/proto.go`、`internal/server/config.go`
>
> 数据结构定义：`internal/proto/`

---

## 目录

- [概述](#概述)
- [传输协议](#传输协议)
- [通用错误处理](#通用错误处理)
- [SSE 事件流](#sse-事件流)
- [1. 系统接口](#1-系统接口)
- [2. 工作区接口](#2-工作区接口)
- [3. 会话接口](#3-会话接口)
- [4. Agent 接口](#4-agent-接口)
- [5. 配置接口](#5-配置接口)
- [6. 权限接口](#6-权限接口)
- [7. 文件追踪接口](#7-文件追踪接口)
- [8. 项目接口](#8-项目接口)
- [9. Skills 接口](#9-skills-接口)
- [10. MCP 接口](#10-mcp-接口)
- [11. 文件与 Git 接口（项目管理）](#11-文件与-git-接口项目管理)
- [附录 A：数据结构定义](#附录-a数据结构定义)
- [附录 B：GUI 开发建议](#附录-bgui-开发建议)

---

## 概述

Agent server 模式通过 HTTP/1.1 + HTTP/2 (unencrypted h2c) 提供全部 RESTful API，所有路径以 `/v1/` 为前缀。Swagger 文档可通过 `/v1/docs/` 访问。

### 基础信息

| 项目 | 说明 |
|------|------|
| Base Path | `/v1` |
| 协议 | HTTP/1.1、HTTP/2 (h2c) |
| 请求格式 | JSON (`Content-Type: application/json`) |
| 响应格式 | JSON (`Content-Type: application/json`) |
| Swagger UI | `GET /v1/docs/` |

---

## 传输协议

Agent server 支持三种传输方式（由 host 参数决定）：

| 协议 | 格式 | 平台 | 默认值 |
|------|------|------|--------|
| Unix Socket | `unix:///path/to/socket` | Linux/macOS | `unix:///tmp/Agent-<uid>.sock` |
| Named Pipe | `npipe:////./pipe/Agent.sock` | Windows | `npipe:////./pipe/Agent.sock` |
| TCP | `tcp://host:port` | 全平台 | 无 |

GUI 客户端需根据运行平台选择合适的传输方式连接 server。

---

## 认证与加密

`tcp://` 监听默认启用 TLS 1.3：服务端使用自签 ECDSA P-256 证书，客户端通过 SPKI 指纹 pin 住服务端身份；客户端身份由服务端生成的随机 token 证明（服务端启动时打印的连接串 `tigerAgent://[host][:port]?fp=…&token=…` 含全部参数，省略端口时客户端默认连 443）。域名反向代理可透传 TCP/TLS（pin 生效）或终止 TLS（桌面端改用公共根证书校验代理证书，pin 只用于直连，身份由 token 证明）。除匿名端点 `GET /v1/health`、`GET /v1/version`、`GET /v1/tls/info` 外，所有请求需带：

```
Authorization: Bearer <token>
```

缺少或带错 token 返回 `401 Unauthorized` + `WWW-Authenticate: Bearer`。`unix` / `npipe` 不启用 TLS 与 token，依靠文件系统 / 管道 ACL 保护。细节见仓库根 `docs/tcp-tls-ecdsa.md`。

服务端还内嵌管理界面 `https://<服务端地址>/admin/`：用**服务端指纹 + 任一有效 token** 登录后可生成/删除/查看 token、复制连接串、查看客户端活跃连接与最近使用地址（管理界面仅 TLS 下可用）。

---

## 通用错误处理

所有错误响应统一使用以下结构：

```json
{
  "message": "错误描述信息"
}
```

### 错误状态码映射

| HTTP 状态码 | 触发条件 |
|-------------|----------|
| `400 Bad Request` | 请求体解析失败、Agent 未初始化、缺少路径参数、缺少 `client_id` 或 `client_id` 非 UUID 格式、无效的权限操作、未知命令、无效的 client_id |
| `403 Forbidden` | 路径不在当前项目内（逃逸 workspace、命中 `.git/`、跨盘符/UNC） |
| `404 Not Found` | 工作区不存在、文件不存在 |
| `409 Conflict` | 工作区正在关闭中、客户端未挂载（无活跃 SSE 流）、服务器非空闲（有活跃会话）、客户端已被回收 |
| `500 Internal Server Error` | 其他未预期错误 |
| `503 Service Unavailable` | 服务器正在关闭中 |

### 请求体大小上限

除 `POST /v1/workspaces/{id}/files/upload`（流式落盘、不受此限制）外，所有端点的请求体都经 `http.MaxBytesReader` 限制为 128 MiB（`internal/server` 的 `maxRequestBodyBytes`，包裹在 handler 链最内层）。超限时 `json.Decode` 报错，端点按普通请求体解析失败返回 `400`。**为什么**：附件是 base64 内联发出的，`encoding/json` 会把整个 body 读进内存，没有上限时一个 POST 就能把 daemon 内存打满。新增端点不需要单独处理，但不要在 handler 里 `r.Body` 上再套一层自己的 `MaxBytesReader` 覆盖这个值。

---

## SSE 事件流

GUI 客户端通过 `GET /v1/workspaces/{id}/events` 订阅 Server-Sent Events，实时接收工作区内所有事件。

### 连接要求

- 需要查询参数 `client_id`（UUID 格式）
- 响应头：`Content-Type: text/event-stream`、`Cache-Control: no-cache`、`Connection: keep-alive`
- 每个事件格式：`data: {"JSON"}\n\n`
- **写超时**：每条事件的写/`Flush` 都设 30s deadline（`sseWriteTimeout`）。写失败或 `Flush` 失败即结束该流并摘除挂载客户端，不会无限阻塞在 `Fprintf` 上。客户端崩死、休眠、socket 缓冲打满这些情况靠这条兜底，之前没有 deadline 时 handler 会永久挂住，`DetachClient` 永不执行，工作区留下一个幽灵挂载客户端。

### 事件信封结构

```json
{
  "type": "事件类型字符串",
  "payload": { ... }
}
```

其中外层 `type`/`payload` 是 `pubsub.Payload`，内层 `type`/`payload` 是具体事件数据。

### 事件类型一览

| `type` 值 | 内层 payload 类型 | 说明 |
|-----------|-------------------|------|
| `mcp_event` | `MCPEvent` | MCP 客户端状态变更 |
| `permission_request` | `PermissionRequest` | 权限请求（等待用户授权） |
| `permission_notification` | `PermissionNotification` | 权限处理结果通知 |
| `message` | `Message` | 消息创建/更新/删除 |
| `session` | `Session` | 会话创建/更新/删除 |
| `file` | `File` | 历史文件变更 |
| `agent_event` | `AgentEvent` | Agent 事件（错误/响应/摘要） |
| `config_changed` | `ConfigChanged` | 配置变更通知 |
| `skills_event` | `SkillsEvent` | Skill 发现状态变更 |
| `run_complete` | `RunComplete` | Agent 运行完成信号（每轮精确一次） |

### 内层事件 `type` 取值

事件内层的 `type` 字段（`pubsub.EventType`）取值为：

| 值 | 说明 |
|----|------|
| `created` | 资源创建 |
| `updated` | 资源更新 |
| `deleted` | 资源删除 |

### 关键事件说明

#### RunComplete（运行完成）

这是每轮 Agent 对话的**权威结束信号**，每轮顶层 agent turn 恰好触发一次。GUI 客户端应基于此事件判断对话是否结束。

```json
{
  "type": "run_complete",
  "payload": {
    "type": "updated",
    "payload": {
      "session_id": "会话ID",
      "run_id": "运行ID（可选，用于精确关联）",
      "message_id": "最终消息ID",
      "text": "最终文本输出",
      "error": "错误信息（非空表示运行出错）",
      "cancelled": false,
      "empty_output": false,
      "incomplete_todos": 0
    }
  }
}
```

**关联策略**：优先用 `run_id` 关联（当客户端发送消息时设置了 `run_id`），否则退化为 `session_id` 关联。

> **`empty_output`**：本轮正常结束（无 error、未取消）但没有任何可用输出（正文与工具调用皆无）时为 `true`，客户端据此提示"模型未产生有效输出"，不要当成静默成功。

> **`incomplete_todos`**：本轮正常结束时任务清单仍有未完成项的数量（`pending` / `in_progress` 计数，全部完成时为 0，字段使用 `omitempty`）。非 0 表示模型在正文里宣称完成、`todos` 却从未回写完成态——服务端未完成 todos nudge 用尽预算后结束本轮，会话里的 todos 就是这份未完成列表。桌面端据此提示"任务清单还有 N 项未完成，可发送继续让模型收尾"，不要用终稿正文覆盖面板状态。

> **步数触顶**：当 `error` 包含 `max_steps_reached` 时，表示模型本轮用完了步数预算（64 步）仍在正常干活，任务可能未完成。这不是故障，客户端应提示用户可发送"继续"恢复任务（桌面端表现为"继续干活/终止查看原因"决策弹窗）。该 token 是前后端契约，服务端改文案不得移除。

#### AgentEvent（Agent 事件）

Agent 运行过程中产生的事件，包括错误、响应和摘要通知。

```json
{
  "type": "agent_event",
  "payload": {
    "type": "updated",
    "payload": {
      "type": "error",
      "message": { ... },
      "error": "错误信息（仅 type=error 时有值）",
      "run_id": "运行ID（可选，用于精确关联）",
      "session_id": "会话ID（摘要事件时使用）",
      "session_title": "会话标题",
      "progress": "进度描述",
      "done": false
    }
  }
}
```

`AgentEvent.type` 取值：

| 值 | 说明 |
|----|------|
| `error` | Agent 运行出错（`error` 字段携带错误文本，`run_id` 可用于关联具体请求） |
| `response` | Agent 响应 |
| `summarize` | 会话摘要事件（携带 `session_id`、`session_title`、`progress`、`done`） |

#### PermissionRequest（权限请求）

当 Agent 执行需要用户授权的操作时，会通过此事件通知 GUI 弹出权限确认对话框。

```json
{
  "type": "permission_request",
  "payload": {
    "type": "created",
    "payload": {
      "id": "权限请求ID",
      "session_id": "会话ID",
      "tool_call_id": "工具调用ID",
      "tool_name": "bash",
      "description": "操作描述",
      "action": "执行命令",
      "params": { ... },
      "path": "相关文件路径"
    }
  }
}
```

#### MCPEvent（MCP 事件）

MCP 客户端状态或工具/资源列表变更通知。

```json
{
  "type": "mcp_event",
  "payload": {
    "type": "created",
    "payload": {
      "type": "state_changed",
      "name": "filesystem",
      "state": "connected",
      "error": "",
      "tool_count": 5,
      "prompt_count": 2,
      "resource_count": 10
    }
  }
}
```

`MCPEvent.type` 取值：

| 值 | 说明 |
|----|------|
| `state_changed` | MCP 客户端状态变更 |
| `tools_list_changed` | 工具列表变更 |
| `prompts_list_changed` | Prompt 列表变更 |
| `resources_list_changed` | Resource 列表变更 |

`MCPEvent.state` 为字符串类型（`MCPState`），取值：`disabled`、`starting`、`connected`、`error`。

#### SkillsEvent（Skill 事件）

Skill 发现状态变更通知。

```json
{
  "type": "skills_event",
  "payload": {
    "type": "created",
    "payload": {
      "states": [
        {
          "name": "skill名称",
          "path": "/path/to/skill.md",
          "state": 0,
          "error": ""
        }
      ]
    }
  }
}
```

`SkillState.state` 为整数类型（`SkillDiscoveryState`），取值：`0`=正常、`1`=错误。

---

## 1. 系统接口

### 1.1 健康检查

```
GET /v1/health
```

检查服务器是否正常运行。

**请求参数**：无

**响应**：`200 OK`（无响应体）

---

### 1.2 获取版本信息

```
GET /v1/version
```

获取服务器版本信息。

**响应** `200 OK`：

```json
{
  "version": "版本号",
  "commit": "Git提交哈希",
  "build_id": "构建ID",
  "go_version": "Go版本",
  "platform": "操作系统/架构",
  "pid": 12345,
  "capabilities": ["settings_v1", "fs_list", "workspace_files", "workspace_git"]
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `version` | string | 语义化版本号 |
| `commit` | string | Git commit hash |
| `build_id` | string | 构建标识 |
| `go_version` | string | 编译用的 Go 版本 |
| `platform` | string | 运行平台 (如 `linux/amd64`) |
| `pid` | int | 服务器进程 PID（用于升级时定位进程） |
| `capabilities` | string[] | 可选能力列表；客户端据此对老服务端降级（`settings_v1`、`fs_list`、`workspace_files`、`workspace_git` 等） |

---

### 1.3 获取全局配置

```
GET /v1/config
```

返回全局服务器配置。

**响应** `200 OK`：全局配置对象（`config.Config` 结构，详见配置文件格式）。

> 返回的是 `ConfigStore.Config()` 里的 `*config.Config`，**不是** `ConfigStore` 本身——`ConfigStore` 的字段全部未导出且没有 `MarshalJSON`，直接编码只会得到 `{}`，而客户端解码 `{}` 不会报错，会拿到一份零值配置。新增配置端点时同样注意别把 store 直接往 `jsonEncode` 里塞。

---

### 1.4 发送控制命令

```
POST /v1/control
```

向服务器发送控制命令（如关闭服务器）。

**请求体**：

```json
{
  "command": "shutdown"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `command` | string | 是 | 控制命令，支持 `"shutdown"` 和 `"shutdown_if_idle"` |

**`command` 取值说明**：

| 值 | 说明 |
|----|------|
| `shutdown` | 请求关闭服务器。仅当服务器空闲（无活跃会话）时才会执行关闭，否则返回 `409` |
| `shutdown_if_idle` | 仅在服务器空闲时关闭。行为与 `shutdown` 相同，但旧版服务器会拒绝此命令（返回 `400`），可用于探测服务器是否支持空闲检测 |

> **注意**：两种命令均经过空闲检测。`shutdown_if_idle` 的存在是为了让客户端可以探测服务器是否支持此检查——不支持该功能的服务器会返回 `400`（未知命令），而非关闭并中断其他会话。

**响应**：`200 OK`（无响应体）

**错误**：
- `400` - 未知命令
- `409` - 服务器非空闲（存在活跃会话，无法关闭）

---

### 1.5 回收客户端

```
DELETE /v1/clients/{client_id}
```

回收指定客户端，释放其持有的所有资源（如当前会话绑定、SSE 流等）。

GUI 客户端在退出时应调用此接口，确保服务器端清理客户端状态。

**路径参数**：

| 参数 | 说明 |
|------|------|
| `client_id` | 客户端 ID（UUID 格式） |

**响应**：`200 OK`（无响应体）

**错误**：
- `400` - 无效的 client_id
- `409` - 客户端已被回收

---

### 1.6 服务端硬件信息

```
GET /v1/system/info
```

返回**服务端主机**的硬件快照（桌面端底部状态栏数据源，客户端每 5s 轮询一次）。响应字段：

```json
{
  "hostname": "server-host",
  "os": "linux",
  "arch": "amd64",
  "cpu_model": "Example CPU @ 3.60GHz",
  "cpu_physical_cores": 8,
  "cpu_logical_cores": 16,
  "cpu_usage": 0.12,
  "total_ram": 34359738368,
  "used_ram": 12884901888,
  "disk_total": 511000000000,
  "disk_used": 102000000000,
  "disk_available": 409000000000,
  "uptime_seconds": 86400
}
```

- `cpu_usage`：0..1 的占比，来自 1s 后台采样（Linux `/proc/stat`，Windows `GetSystemTimes`）；其它平台恒为 0（未知）。
- `disk_total` / `disk_used` / `disk_available`：**服务端数据目录所在卷**的字节数（Unix `statfs`，Windows `GetDiskFreeSpaceEx`）。
- 显卡探测已移除：响应中没有 `has_gpu` / `gpus` / `total_vram` / `used_vram` / `warnings`（不再执行 `nvidia-smi`）。

---

### 1.9 服务端目录浏览 / 路径校验 / 创建目录

（与仓库根 `docs/server-api.md` §1.9 同步）

```
GET  /v1/fs/list?path=/srv
POST /v1/fs/validate
POST /v1/fs/mkdir
```

`list` 返回 `{ "path": "...", "entries": [{ "name", "path", "is_dir", "size", "mtime" }] }`（目录在前，最多 2000 项）；`path` 为空时返回服务端用户主目录。

`validate` 请求体 `{ "paths": ["/srv/proj/a"] }`，响应 `{ "results": [{ "path", "exists", "is_dir", "writable" }] }`；越界路径额外带 `error`。

`mkdir` 请求体 `{ "name": "my-project" }`，在**服务端用户主目录**下创建同名文件夹并返回 `{ "path", "name", "created" }`；目录已存在时 `created=false` 直接返回该路径，已有同名文件返回 `400`。`name` 只接受单段目录名（空、`.`、`..`、含 `/` 或 `\` 均返回 `400`）。桌面端「添加工作目录」弹窗只填名称，由它建目录后再 `add_workdir` + 切换工作区（`src/views/agent/workspace.js`）——客户端本机既看不到也建不了服务端目录。

**安全边界**：`list` / `validate` 只允许访问服务端用户主目录、服务端工作目录与已配置的工作目录（先 `EvalSymlinks` 再判前缀），越界返回 `403`；`mkdir` 固定落在服务端用户主目录下。不提供读取文件内容的接口。

### 1.11 服务端日志

（与仓库根 `docs/server-api.md` §1.11 同步）

```
GET /v1/logs                        # 列出日志文件
GET /v1/logs/{name}?tail=1000       # 读取文本（tail=0 = 整个文件）
GET /v1/logs/{name}?download=1      # 原样下载（附件）
DELETE /v1/logs                     # 清空全部日志
```

桌面端入口：设置 → 服务端日志（`src/views/agent/server_logs.js` + Rust `src-tauri/src/pages/logs.rs`）；远程部署时客户端本机没有 `tigerAgent.log`，只能经这些接口查看 / 下载 / 清空。

`DELETE /v1/logs` 返回 `{ "dir", "truncated", "removed" }`：正在写入的 `tigerAgent.log` 原地截断（服务端进程持有写句柄，删除在 Windows 上会失败），panic 转储、`.prev` 与轮转文件直接删除；服务端不需要重启。`name` 白名单与 `GET /v1/logs/{name}` 相同（`tigerAgent` 开头、`.log` / `.log.prev` 结尾的裸文件名）。

---

## 2. 工作区接口

### 2.1 列出所有工作区

```
GET /v1/workspaces
```

**响应** `200 OK`：

```json
[
  {
    "id": "工作区ID",
    "path": "/path/to/project",
    "exists": true,
    "yolo": false,
    "debug": false,
    "data_dir": "/path/to/data",
    "version": "版本号",
    "client_id": "创建者客户端ID",
    "config": { ... },
    "env": ["ENV_VAR=value"],
    "skills": [
      {
        "name": "skill名称",
        "path": "/path/to/skill.md",
        "state": 0,
        "error": ""
      }
    ]
  }
]
```

语义：

- `exists` 是响应时对 `path` 的实时检查：服务端主机上该路径仍是目录即为 `true`。工作区不会因为目录被删而立即销毁（要等最后一条 SSE 流断开且没有创建 hold），`exists:false` 表示目录已删、工作区还活着；桌面端「项目管理」据此不把该工作区并入项目列表，避免已删除的目录重新出现成打不开的项目。
- 其余字段与 `proto.Workspace` 一致（`config` 可能较大，按需读取）。

---

### 2.2 创建工作区

```
POST /v1/workspaces
```

**请求体**（`proto.Workspace`）：

```json
{
  "path": "/path/to/project",
  "yolo": false,
  "debug": false,
  "data_dir": "",
  "client_id": "客户端ID",
  "env": ["ENV_VAR=value"]
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `path` | string | 是 | 工作目录路径 |
| `yolo` | bool | 否 | 跳过所有权限确认 |
| `debug` | bool | 否 | 调试模式 |
| `data_dir` | string | 否 | 数据存储目录 |
| `client_id` | string | 否 | 创建者客户端标识 |
| `env` | []string | 否 | 环境变量列表 |

**响应** `200 OK`：创建后的 `Workspace` 对象

---

### 2.3 删除工作区

```
DELETE /v1/workspaces/{id}?client_id={client_id}
```

**路径参数**：

| 参数 | 说明 |
|------|------|
| `id` | 工作区 ID |

**查询参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `client_id` | string (UUID) | 是 | 客户端标识 |

**响应**：`200 OK`（无响应体）

**错误**：
- `400` - 缺少 `client_id` 或格式无效
- `409` - 工作区正在关闭中

---

### 2.4 获取单个工作区

```
GET /v1/workspaces/{id}
```

**响应** `200 OK`：`Workspace` 对象

---

### 2.5 设置当前会话

```
POST /v1/workspaces/{id}/current-session?client_id={client_id}
```

记录客户端当前选中的会话。空 `session_id` 表示清除（如回到落地页）。

**请求体**（`proto.CurrentSession`）：

```json
{
  "session_id": "会话ID"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `session_id` | string | 是 | 当前会话 ID，空字符串表示清除 |

**响应**：`200 OK`（无响应体）

---

### 2.6 获取工作区配置

```
GET /v1/workspaces/{id}/config
```

**响应** `200 OK`：工作区配置对象

---

### 2.7 获取可用 Providers

```
GET /v1/workspaces/{id}/providers
```

列出工作区可用的模型提供商列表。

`models[]` 为 ModelInfo 结构：上下文窗口字段是 `ctx_size`（旧键 `context_window` 只在读取 tigerAgent.json 时作为别名接受，不会出现在响应里；服务端内存注入的内置 provider `tigerAgent/agent-models` 尤其只有 `ctx_size`）。客户端读窗口时必须新键优先、旧键兜底。

**响应** `200 OK`：Provider 信息对象

---

### 2.8 获取工作区所有用户消息

```
GET /v1/workspaces/{id}/messages/user
```

返回工作区内所有会话的用户消息（跨会话）。

**响应** `200 OK`：`Message[]`

---

### 2.9 订阅工作区事件流（SSE）

```
GET /v1/workspaces/{id}/events?client_id={client_id}
```

**响应** `200 OK`：`text/event-stream`

详见 [SSE 事件流](#sse-事件流) 章节。

---

### 2.10 获取工作区 git 信息

```
GET /v1/workspaces/{id}/git-info
```

在**服务端所在主机**上探测工作区目录（撤销能力提示用）。工作目录在服务端，客户端本地
跑 `git rev-parse` 只会得到「不是 git 仓库」。

**响应** `200 OK`（`GitInfo`）：

```json
{
  "path": "/srv/projects/demo",
  "exists": true,
  "git_installed": true,
  "is_repo": true
}
```

- `exists=false`：服务端找不到该目录（已被删除/移动），撤销只能回退对话记录。
- `git_installed=false`：服务端没装 git（或不在 PATH）。
- `is_repo=false`：装了 git，但该目录不是工作树。

---

### 2.11 读取项目记忆

```
GET /v1/workspaces/{id}/project-memory
```

读取跨会话项目记忆（`project_memory.json`，上下文压缩时沉淀的 durable 约束/决策）。
数据来自服务端进程内的 `ProjectStore`，不是按 workspace `data_dir` 拼本地路径。

**响应** `200 OK`（`ProjectAnchor[]`）：

```json
[
  {
    "kind": "constraint",
    "key": "constraint:不要改 internal/agent 的公共接口",
    "value": "不要改 internal/agent 的公共接口",
    "why": "外部插件依赖",
    "updated_at": 1763000000
  }
]
```

**失败**：工作区不存在 → `404`；Agent 尚未初始化 → `500`（先建会话触发初始化）。

---

### 2.12 覆盖项目记忆

```
POST /v1/workspaces/{id}/project-memory
```

桌面端编辑器按「整表提交」写入。服务端只保留 `constraint` / `decision`、丢弃空
`value`、同名 `key` 合并、超预算按 salience 裁剪，然后原子落盘（`.tmp` + rename）。
注意 Agent 下一次压缩仍会把内存里的 anchors 合并回写，手工删除的条目可能被再次沉淀。

**请求体**（`ProjectMemoryRequest`）：

```json
{
  "anchors": [
    { "kind": "decision", "value": "日志统一写 tigerAgent.log", "why": "排查习惯" }
  ]
}
```

**响应** `200 OK`：规范化后的完整列表（`ProjectAnchor[]`，含补全的 `key` 与
`updated_at`）。

---

## 3. 会话接口

### 3.1 列出会话

```
GET /v1/workspaces/{id}/sessions
```

**响应** `200 OK`：`Session[]`

```json
[
  {
    "id": "会话ID",
    "parent_session_id": "父会话ID",
    "title": "会话标题",
    "message_count": 10,
    "prompt_tokens": 1000,
    "completion_tokens": 500,
    "context_tokens": 800,
    "summary_message_id": "摘要消息ID",
    "cost": 0.0023,
    "todos": [
      {
        "content": "任务内容",
        "status": "in_progress",
        "active_form": "正在处理..."
      }
    ],
    "created_at": 1719500000,
    "updated_at": 1719500100,
    "is_busy": false,
    "attached_clients": 1
  }
]
```

---

### 3.2 创建会话

```
POST /v1/workspaces/{id}/sessions
```

**请求体**：

```json
{
  "title": "会话标题"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `title` | string | 否 | 会话标题 |

**响应** `200 OK`：`Session` 对象

---

### 3.3 获取单个会话

```
GET /v1/workspaces/{id}/sessions/{sid}
```

**响应** `200 OK`：`Session` 对象

---

### 3.4 更新会话

```
PUT /v1/workspaces/{id}/sessions/{sid}
```

**请求体**（`Session`）：

```json
{
  "title": "新标题",
  "todos": [...]
}
```

- 请求体按 **`proto.Session`**（蛇形 `json` tag：`prompt_tokens`、`summary_message_id`、`todos` …）解析后转成 `session.Session` 落库。`session.Session` 本身没有 json tag，曾因直接解码它导致改名时把累计 token、成本、压缩摘要锚点、任务清单全部写成 0（`sessionFromProto` 就是为此加的）。
- `{sid}` 是权威：请求体缺 `id` 时用路径参数补上，否则会更新到零值行。

**响应** `200 OK`：更新后的 `Session` 对象

---

### 3.5 删除会话

```
DELETE /v1/workspaces/{id}/sessions/{sid}
```

**响应**：`200 OK`（无响应体）

---

### 3.6 获取会话历史文件

```
GET /v1/workspaces/{id}/sessions/{sid}/history
```

返回该会话中被修改/创建的历史文件快照列表。

**响应** `200 OK`：`File[]`

```json
[
  {
    "id": "文件记录ID",
    "session_id": "会话ID",
    "path": "/path/to/file.go",
    "content": "文件内容快照",
    "version": 3,
    "created_at": 1719500000,
    "updated_at": 1719500100
  }
]
```

---

### 3.7 获取会话所有消息

```
GET /v1/workspaces/{id}/sessions/{sid}/messages
```

**响应** `200 OK`：`Message[]`

消息结构详见 [附录 A](#message-结构)。

---

### 3.8 获取会话用户消息

```
GET /v1/workspaces/{id}/sessions/{sid}/messages/user
```

仅返回该会话中 `role` 为 `user` 的消息。

**响应** `200 OK`：`Message[]`

---

## 4. Agent 接口

### 4.1 获取 Agent 信息

```
GET /v1/workspaces/{id}/agent
```

**响应** `200 OK`（`proto.AgentInfo`）：

```json
{
  "is_busy": false,
  "is_ready": true,
  "model": {
    "id": "gpt-4o",
    "name": "GPT-4o",
    "ctx_size": 128000,
    "supports_images": true,
    "can_reason": false
  },
  "model_cfg": {
    "model": "gpt-4o",
    "provider": "openai"
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `is_busy` | bool | Agent 是否正在运行 |
| `is_ready` | bool | Agent 是否已就绪 |
| `model` | ModelInfo | 当前模型信息 |
| `model_cfg` | SelectedModel | 当前选中的模型配置 |

---

### 4.2 发送消息给 Agent

```
POST /v1/workspaces/{id}/agent
```

向 Agent 发送用户消息，异步触发 Agent 运行。此接口是 **fire-and-forget**：立即返回 `202 Accepted`，实际运行结果通过 SSE 事件流获取。

**请求体**（`proto.AgentMessage`）：

```json
{
  "session_id": "会话ID",
  "run_id": "可选的运行ID",
  "prompt": "用户输入内容",
  "attachments": [
    {
      "file_path": "/path/to/file",
      "file_name": "file.png",
      "mime_type": "image/png",
      "content": "base64编码内容"
    }
  ],
  "decision": {
    "mode": "auto",
    "tool_policy": "none",
    "structured_output": "auto"
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `session_id` | string | 是 | 目标会话 ID |
| `run_id` | string | 否 | 运行 ID，用于精确关联 `RunComplete` 事件 |
| `prompt` | string | 是 | 用户提示内容 |
| `attachments` | []Attachment | 否 | 附件列表（content 为 base64 编码） |
| `decision` | DecisionSpec | 否 | 决策输出模式（见下）；省略 = 普通对话，行为与历史版本完全一致 |

**决策输出模式（`decision`，仅桌面端使用）**

带 `decision` 的请求走服务端的**独立决策轮**：不注册工具、不做空 stop / 叙述性 stop / todos nudge 重试，只允许一次结果校验重定向重试，必须在回复里返回一个结构化决策结果。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `decision.mode` | string | 是 | `auto` / `choice` / `bool` / `score` |
| `decision.tool_policy` | string | 否 | 目前仅支持 `none`（默认）；决策轮是"给结论"，不执行任何操作 |
| `decision.structured_output` | string | 否 | `auto`（默认）或 `off`；`auto` 当前等同提示词约束（`response_format` 强制为后续阶段） |

服务端在该轮的系统提示词里注入输出契约（不进用户消息、不落历史），要求整条回复只包含一个 `<agent_decision_result>` JSON 块：

```json
{"type":"choice","selected":"value","reason":"...","candidates":[{"value":"...","label":"...","rationale":"..."}]}
{"type":"bool","value":true,"reason":"..."}
{"type":"score","score":8,"min":0,"max":10,"level":"...","reason":"..."}
```

契约不满足时服务端会带具体原因重试一次；两次仍不满足则以 `run_complete.error = invalid decision output after 2 attempts: …` 结束本轮（前端据此提示，不再靠客户端事后兜底）。

**结果落库形式**：校验通过的轮次，assistant 消息会带一个专用 ContentPart，正文里不再保留 JSON 块：

```json
{ "type": "decision", "data": { "kind": "bool", "mode": "bool", "value": true, "reason": "…", "raw": "{…}" } }
```

`kind` 为 `choice`（带 `selected` + `candidates[]`）/ `bool`（`value`）/ `score`（`score`/`min`/`max`/`level`）；`raw` 是模型原文，便于排查。未知 kind 的 part 应被客户端忽略或折叠展示，不要当作错误（前向兼容）。旧会话历史里仍是正文 `<agent_decision_result>` 标签。

**结构化输出**：`decision.structured_output=auto`（默认）时服务端会附带 `response_format: {type: "json_schema", …}`；上游明确拒绝该参数时自动去掉它重试一次，并按 `base URL + model` 记住不支持，后续请求不再探测（模型此时可能返回无标签的裸 JSON，服务端解析同样接受）。传 `off` 可完全关闭。

**响应**：`202 Accepted`（无响应体）

**错误**：
- `400` - Agent 未初始化；或 `decision.mode` / `decision.tool_policy` / `decision.structured_output` 取值非法
- `409` - 会话繁忙且无法排队

> **GUI 提示**：发送消息后，通过 SSE 事件流接收 `message`（增量更新）和 `run_complete`（结束信号）事件。如果需要在多个并发运行中精确匹配某次请求的结果，请在发送时设置 `run_id`。

---

### 4.3 初始化 Agent

```
POST /v1/workspaces/{id}/agent/init
```

为工作区初始化 Agent。

**响应**：`200 OK`（无响应体）

---

### 4.4 更新 Agent

```
POST /v1/workspaces/{id}/agent/update
```

更新工作区的 Agent 配置（如模型变更后重新加载）。

**响应**：`200 OK`（无响应体）

---

### 4.5 获取 Agent 会话信息

```
GET /v1/workspaces/{id}/agent/sessions/{sid}
```

获取指定会话的 Agent 状态信息。

**响应** `200 OK`（`proto.AgentSession`）：

```json
{
  "id": "会话ID",
  "title": "标题",
  "is_busy": false,
  ...
}
```

---

### 4.6 取消 Agent 会话

```
POST /v1/workspaces/{id}/agent/sessions/{sid}/cancel
```

取消正在运行的 Agent 会话。

**响应**：`200 OK`（无响应体）

---

### 4.7 查询排队提示状态

```
GET /v1/workspaces/{id}/agent/sessions/{sid}/prompts/queued
```

查询该会话是否有排队的提示。

**响应** `200 OK`：

```json
{
  "queued": true
}
```

---

### 4.8 列出排队提示

```
GET /v1/workspaces/{id}/agent/sessions/{sid}/prompts/list
```

列出该会话所有排队的提示内容。

**响应** `200 OK`：`string[]`

---

### 4.9 清除排队提示

```
POST /v1/workspaces/{id}/agent/sessions/{sid}/prompts/clear
```

清除会话中所有排队的提示。

**响应**：`200 OK`（无响应体）

---

### 4.10 摘要会话

```
POST /v1/workspaces/{id}/agent/sessions/{sid}/summarize
```

触发会话摘要生成。

**响应**：`200 OK`（无响应体）

---

### 4.11 撤销上一轮

```
POST /v1/workspaces/{id}/agent/sessions/{sid}/undo
```

撤销 Agent turn 的操作（回滚文件变更）。

**请求体**（可选）：

```json
{ "anchor": "<userMessageId>" }
```

- 带 `anchor`（某轮的起始 user 消息 ID）：回滚**该轮及其之后的所有轮次**（`coordinator.Undo` 的 anchor 分支）。
- 不带 body 或 `anchor` 为空：只回滚**最后一轮**（旧行为，TUI 的 `ctrl+b` 走这条）。

**响应**：`200 OK`（无响应体）；body 存在但不是合法 JSON 时 `400`（不静默退化成"回滚最后一轮"，否则会把用户指定的更早一轮撤错）。

**语义与限制**（客户端依赖这些行为，改 Agent 前先看）：

- 一次调用回滚的粒度是「轮」：删掉这些轮产生的消息与 file-history 版本，并把整棵工作树还原到目标轮开始前的 git 快照（`git reset --hard` + `checkout-index` + `clean`）。
- 目标轮没有文件快照（该轮没改文件 / 已被保留窗口淘汰 / 目录不是 git 仓库）时退化为**只回滚对话**：消息被删，文件原样保留。anchor 必须是本会话真实存在的 user 消息，否则返回 `ErrNothingToUndo`（防止按时间戳兜底删错行）。
- 成功后该 anchor 及其之后的所有快照一并丢弃（`Snapshotter.RemoveFrom`）：工作树已经回到更早的状态，保留更新的快照会让后续撤销复活已回滚的文件。
- 同工作目录还有 run 在飞时返回错误拒绝（`ErrUndoConcurrentSession`），因为回滚是整仓库的。
- 每个会话保留的每轮快照数 = `options.undo_checkpoints`（默认 10，上限 100，`internal/undo` `DefaultMaxCheckpoints`）；淘汰会写日志 `Undo checkpoint evicted: retention window full`。
- 桌面端每个对话容器上的撤销按钮调一次本接口（带 `anchor`），客户端实现见 `src/views/agent/undo.js`。

---

### 4.12 执行 Shell 命令

```
POST /v1/workspaces/{id}/agent/sessions/{sid}/shell
```

在工作区中直接执行 Shell 命令（Bang 模式）。

**请求体**（`proto.ShellCommandRequest`）：

```json
{
  "session_id": "会话ID",
  "command": "ls -la",
  "term_width": 80
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `session_id` | string | 否 | 会话 ID（路径参数已提供，会自动设置） |
| `command` | string | 是 | 要执行的命令 |
| `term_width` | int | 否 | 终端宽度（影响输出格式） |

**响应** `200 OK`（`proto.ShellCommandResponse`）：

```json
{
  "output": "命令输出内容",
  "exit_code": 0
}
```

---

## 5. 配置接口

### 5.1 设置配置字段

```
POST /v1/workspaces/{id}/config/set
```

**请求体**（`proto.ConfigSetRequest`）：

```json
{
  "scope": 0,
  "key": "配置键名",
  "value": "配置值（任意类型）"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `scope` | int | 是 | 配置范围：`0`=全局，`1`=工作区 |
| `key` | string | 是 | 配置键名 |
| `value` | any | 是 | 配置值（任意 JSON 类型） |

**响应**：`200 OK`（无响应体）

---

### 5.2 移除配置字段

```
POST /v1/workspaces/{id}/config/remove
```

**请求体**（`proto.ConfigRemoveRequest`）：

```json
{
  "scope": 1,
  "key": "配置键名"
}
```

**响应**：`200 OK`（无响应体）

---

### 5.3 设置首选模型

```
POST /v1/workspaces/{id}/config/model
```

**请求体**（`proto.ConfigModelRequest`）：

```json
{
  "scope": 1,
  "model": {
    "model": "gpt-4o",
    "provider": "openai",
    "reasoning_effort": "high",
    "think": false,
    "temperature": 0.7
  }
}
```

DeepSeek 非思考模式支持以下两种等价写法，Agent 会兼容并按配置透传：

```json
{ "reasoning_effort": "none" }
```

```json
{ "thinking": { "type": "disabled" } }
```

桌面端只负责把选定的写法写进模型配置（关闭思考时默认写 `reasoning_effort: "none"`），**回退不发生在桌面端**：Agent 调用上游 LLM 时，若上游明确返回 `400`（包括只给 `invalid_request_error / invalid request` 的通用参数错误），且不属于上下文超限、配额、内容安全、鉴权等其它错误，Agent 会自动用另一种写法重试一次，并按 `base URL + model` 在进程内存中记住成功的那一种；网络错误、超时、`5xx` 不会触发该回退。两种写法都被拒绝时返回 `400`（`thinking mode unsupported`），错误文本以 **`thinking_mode_unsupported`** 开头并附两次失败原因摘要——这是前后端契约 token（`internal/llm/client_test.go` 有单测锁定）：桌面端据此分类并提示「本模型不支持关闭思考，请切回思考模式」，同时中断本轮。Agent **不会**为此静默去掉参数继续跑，也**不会**改写用户设置的推理档位（该模型只能显式切回思考档）。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `scope` | int | 是 | 配置范围 |
| `model.model` | string | 是 | 模型 ID |
| `model.provider` | string | 是 | 提供商 ID |
| `model.reasoning_effort` | string | 否 | 推理强度：`none`/`low`/`medium`/`high`；`off` 为 `none` 的兼容别名。DeepSeek 使用 `none` 关闭思考 |
| `model.thinking.type` | string | 否 | 思考模式：`enabled`/`disabled`。DeepSeek 可使用 `disabled` 关闭思考；省略时沿用提供商默认行为 |
| `model.think` | bool | 否 | 旧版 Anthropic 思考开关 |
| `model.temperature` | *float64 | 否 | 采样温度 |
| `model.top_p` | *float64 | 否 | Top-p |
| `model.top_k` | *int64 | 否 | Top-k |
| `model.frequency_penalty` | *float64 | 否 | 频率惩罚 |
| `model.presence_penalty` | *float64 | 否 | 存在惩罚 |
| `model.provider_options` | map | 否 | 提供商特定选项 |

**响应**：`200 OK`（无响应体）

---

### 5.4 设置 Compact 模式

```
POST /v1/workspaces/{id}/config/compact
```

**请求体**（`proto.ConfigCompactRequest`）：

```json
{
  "scope": 1,
  "enabled": true
}
```

**响应**：`200 OK`（无响应体）

---

### 5.5 设置 Provider API Key

```
POST /v1/workspaces/{id}/config/provider-key
```

**请求体**（`proto.ConfigProviderKeyRequest`）：

```json
{
  "scope": 0,
  "provider_id": "openai",
  "kind": "string",
  "api_key": "sk-xxxxx"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `scope` | int | 是 | 配置范围 |
| `provider_id` | string | 是 | Provider ID |
| `kind` | string | 是 | 凭据类型，目前仅支持 `"string"` |
| `api_key` | json.RawMessage | 是 | API Key（JSON 编码的字符串） |

**响应**：`200 OK`（无响应体）

---

## 6. 权限接口

### 6.1 获取跳过权限状态

```
GET /v1/workspaces/{id}/permissions/skip
```

**响应** `200 OK`（`proto.PermissionSkipRequest`）：

```json
{
  "skip": false
}
```

---

### 6.2 设置跳过权限

```
POST /v1/workspaces/{id}/permissions/skip
```

设置是否跳过所有权限确认（YOLO 模式开关）。

**请求体**（`proto.PermissionSkipRequest`）：

```json
{
  "skip": true
}
```

**响应**：`200 OK`（无响应体）

---

### 6.3 授权权限请求

```
POST /v1/workspaces/{id}/permissions/grant
```

响应 Agent 发起的权限请求（允许/拒绝）。

**请求体**（`proto.PermissionGrant`）：

```json
{
  "permission": {
    "id": "权限请求ID",
    "session_id": "会话ID",
    "tool_call_id": "工具调用ID",
    "tool_name": "bash",
    "description": "执行命令: rm -rf /tmp/cache",
    "action": "执行命令",
    "params": { "command": "rm -rf /tmp/cache" },
    "path": ""
  },
  "action": "allow"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `permission` | PermissionRequest | 是 | 权限请求详情（从 SSE 事件获取） |
| `action` | string | 是 | 授权动作：`allow`、`allow_session`、`deny` |

**`action` 取值说明**：

| 值 | 说明 |
|----|------|
| `allow` | 允许本次操作 |
| `allow_session` | 允许本次会话内所有同类操作 |
| `deny` | 拒绝操作 |

**响应** `200 OK`（`proto.PermissionGrantResponse`）：

```json
{
  "resolved": true
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `resolved` | bool | `true`=本次调用处理了该请求；`false`=请求已被其他客户端处理 |

---

## 7. 文件追踪接口

### 7.1 列出会话追踪文件

```
GET /v1/workspaces/{id}/sessions/{sid}/filetracker/files
```

返回指定会话中 Agent 读取过的文件列表。

**响应** `200 OK`：`string[]`（文件路径列表）

---

### 7.2 记录文件读取

```
POST /v1/workspaces/{id}/filetracker/read
```

记录一次文件读取事件。

**请求体**（`proto.FileTrackerReadRequest`）：

```json
{
  "session_id": "会话ID",
  "path": "/path/to/file.go"
}
```

**响应**：`200 OK`（无响应体）

---

### 7.3 获取最后读取时间

```
GET /v1/workspaces/{id}/filetracker/lastread?path={path}&session_id={sid}
```

**查询参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `path` | string | 是 | 文件路径 |
| `session_id` | string | 否 | 会话 ID（不传则查询工作区级别） |

**响应** `200 OK`：最后读取时间（时间戳）

---

## 8. 项目接口

### 8.1 检查项目是否需要初始化

```
GET /v1/workspaces/{id}/project/needs-init
```

**响应** `200 OK`（`proto.ProjectNeedsInitResponse`）：

```json
{
  "needs_init": true
}
```

---

### 8.2 标记项目已初始化

```
POST /v1/workspaces/{id}/project/init
```

**响应**：`200 OK`（无响应体）

---

### 8.3 获取项目初始化提示

```
GET /v1/workspaces/{id}/project/init-prompt
```

获取用于项目初始化的系统提示内容。

**响应** `200 OK`（`proto.ProjectInitPromptResponse`）：

```json
{
  "prompt": "初始化提示文本..."
}
```

---

## 9. Skills 接口

### 9.1 列出可见 Skills

```
GET /v1/workspaces/{id}/skills
```

**响应** `200 OK`（`proto.SkillInfo[]`）：

```json
[
  {
    "id": "skill-id",
    "name": "skill名称",
    "description": "技能描述",
    "label": "显示标签",
    "source": "builtin",
    "user_invocable": true
  }
]
```

---

### 9.2 读取 Skill 内容

```
POST /v1/workspaces/{id}/skills/read
```

**请求体**（`proto.ReadSkillRequest`）：

```json
{
  "skill_id": "skill-id"
}
```

**响应** `200 OK`（`proto.ReadSkillResponse`）：

```json
{
  "content": "base64编码的skill内容",
  "result": {
    "name": "skill名称",
    "description": "技能描述",
    "source": "builtin",
    "builtin": true
  }
}
```

---

## 10. MCP 接口

### 10.1 获取 MCP 客户端状态

```
GET /v1/workspaces/{id}/mcp/states
```

**响应** `200 OK`（`map[string]MCPClientInfo`）：

```json
{
  "filesystem": {
    "name": "filesystem",
    "state": "connected",
    "error": "",
    "tool_count": 5,
    "prompt_count": 2,
    "resource_count": 10,
    "connected_at": "2025-07-26T10:00:00Z"
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | MCP 客户端名称 |
| `state` | string | MCP 客户端状态（字符串，见下表） |
| `error` | string | 错误信息（无错误时为空字符串） |
| `tool_count` | int | 工具数量 |
| `prompt_count` | int | Prompt 数量 |
| `resource_count` | int | Resource 数量 |
| `connected_at` | string | 连接时间（ISO 8601） |

MCP `state` 取值（`proto.MCPState`，序列化为字符串）：

| 值 | 说明 |
|----|------|
| `disabled` | 已禁用 |
| `starting` | 启动中 |
| `connected` | 已连接 |
| `error` | 错误 |

---

### 10.2 刷新 MCP 工具

```
POST /v1/workspaces/{id}/mcp/refresh-tools
```

**请求体**（`proto.MCPNameRequest`）：

```json
{
  "name": "filesystem"
}
```

**响应**：`200 OK`（无响应体）

---

### 10.3 刷新 MCP Prompts

```
POST /v1/workspaces/{id}/mcp/refresh-prompts
```

**请求体**：同 11.2

**响应**：`200 OK`（无响应体）

---

### 10.4 刷新 MCP Resources

```
POST /v1/workspaces/{id}/mcp/refresh-resources
```

**请求体**：同 11.2

**响应**：`200 OK`（无响应体）

---

### 10.5 读取 MCP 资源

```
POST /v1/workspaces/{id}/mcp/read-resource
```

**请求体**（`proto.MCPReadResourceRequest`）：

```json
{
  "name": "filesystem",
  "uri": "file:///path/to/resource"
}
```

**响应** `200 OK`：资源内容对象

---

### 10.6 获取 MCP Prompt

```
POST /v1/workspaces/{id}/mcp/get-prompt
```

**请求体**（`proto.MCPGetPromptRequest`）：

```json
{
  "client_id": "MCP客户端ID",
  "prompt_id": "prompt标识",
  "args": {
    "key": "value"
  }
}
```

**响应** `200 OK`（`proto.MCPGetPromptResponse`）：

```json
{
  "prompt": "prompt文本内容"
}
```

---

### 10.7 启用 Docker MCP

```
POST /v1/workspaces/{id}/mcp/docker/enable
```

启用 Docker MCP 服务器。

**响应**：`200 OK`（无响应体）

---

### 10.8 禁用 Docker MCP

```
POST /v1/workspaces/{id}/mcp/docker/disable
```

禁用 Docker MCP 服务器。

**响应**：`200 OK`（无响应体）

---

## 11. 文件与 Git 接口（项目管理）

> 对应桌面端「项目管理」标签页（`#/projects`）。文件与 Git 数据全部由**服务端主机**读取/执行：桌面端可能连接远程服务端，客户端本地文件系统不可信。
>
> 所有路径参数都是 **workspace 相对路径**，使用 `/` 分隔，空串表示 workspace 根。路径中出现 `..` 上跳、绝对路径、盘符/UNC、NUL 或任一段为 `.git`（Windows 上大小写不敏感，`.GIT`、`.git.` 视为同一目录）时返回 `403`；workspace 不存在返回 `404`。

### 11.0 capability

有本组接口的服务端在 `GET /v1/version` 的 `capabilities` 中返回：

| capability | 含义 |
| --- | --- |
| `workspace_files` | 目录列表、文件内容与原始下载 |
| `workspace_files_write` | 重命名文件/目录、写入文件内容 |
| `workspace_files_delete` | 删除文件/目录（目录连同整棵子树，含项目根目录） |
| `workspace_files_create` | 新建空文件/文件夹、上传文件 |
| `workspace_git` | Git 状态与差异 |

老服务端缺少对应项时客户端按能力降级：缺 `workspace_files` 整页不可用并提示升级；缺 `workspace_files_write` 只隐藏「编辑 / 重命名」入口；缺 `workspace_files_delete` 只隐藏「删除」入口；缺 `workspace_files_create` 只隐藏「新建 / 上传」入口；缺 `workspace_git` 只隐藏 Git 颜色/差异。

### 11.1 列出目录（单层）

```
GET /v1/workspaces/{id}/files?path=src%2Fviews&show_hidden=1
```

| 参数 | 位置 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | path | 是 | Workspace ID |
| `path` | query | 否 | 相对目录，默认 `""`（根） |
| `show_hidden` | query | 否 | `0` 过滤 `.` 开头的条目；默认 `1` |

**响应** `200 OK`：

```json
{
  "path": "src/views",
  "entries": [
    { "name": "agent", "path": "src/views/agent", "is_dir": true, "size": 0, "mtime": 1726300000, "symlink": false, "external": false, "hidden": false },
    { "name": "agent.js", "path": "src/views/agent.js", "is_dir": false, "size": 12345, "mtime": 1726300000, "symlink": false, "external": false, "hidden": false }
  ],
  "truncated": false
}
```

语义：

- 排序为「目录优先、名称不区分大小写」；单目录最多 2000 条，超出时 `truncated:true`。
- 永不返回 `.git` 与 `.tigerAgent` 条目（Windows 上含大小写与结尾点号变体）；其余隐藏文件按 `show_hidden` 决定。`.tigerAgent` 是 tigerAgent 自己的数据目录（配置快照/会话库/撤销快照），不属于项目内容。
- 符号链接：`symlink:true`；目标在 workspace 内且为目录时 `is_dir:true` 可展开；目标在 workspace 外时 `external:true`，客户端禁用展开/预览。`path` 始终是逻辑相对路径，不是解析后的物理路径。
- 目录不存在/不可读 → `400`。

### 11.2 读取文件内容

```
GET /v1/workspaces/{id}/files/content?path=README.md&max_bytes=1048576
```

| 参数 | 位置 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | path | 是 | Workspace ID |
| `path` | query | 是 | 相对文件路径 |
| `max_bytes` | query | 否 | 读取上限，默认 1 MiB；下限 4 KiB、上限 8 MiB |

**响应** `200 OK`：

```json
{
  "path": "README.md",
  "size": 8123,
  "mtime": 1726300000,
  "binary": false,
  "encoding": "utf-8",
  "truncated": false,
  "line_count": 123,
  "content": "# tigerAgent\n..."
}
```

语义：

- 二进制判定与 Agent `view` 工具一致：读到的字节不是合法 UTF-8 即 `binary:true`，此时 `content:""`、`encoding:""`。
- `encoding` 为 `utf-8` 或 `utf-8-bom`（内容不剥离 BOM，客户端展示前自行处理）。
- `truncated:true` 表示还有剩余字节未读；截断点若落在多字节字符中间，服务端回退到上一个合法 UTF-8 边界。
- 目录 → `400`；文件不存在 → `404`；`.git/` → `403`。
- 内容不做日志输出。

### 11.2.2 重命名文件/目录

```
POST /v1/workspaces/{id}/files/rename
Content-Type: application/json

{ "path": "src/old.js", "name": "new.js" }
```

| 参数 | 位置 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | path | 是 | Workspace ID |
| `path` | body | 是 | 相对路径（文件或目录，不能是 workspace 根） |
| `name` | body | 是 | 新名称，单个路径段（不能包含 `/`、`\`） |

**响应** `200 OK`：

```json
{ "path": "src/new.js", "name": "new.js" }
```

语义：

- 只在原父目录内改名；目录改名自动带上整个子树。
- `name` 为空 / `.` / `..` / 含路径分隔符或控制字符 → `400`；Windows 上还拒绝 `<>:"|?*` 以及以点/空格结尾的名称。
- 目标已存在 → `409`（大小写不敏感的同一项仅改大小写时除外）；源不存在 → `404`；workspace 根 → `400`；`.git` 名称或路径逃逸 → `403`。
- 符号链接改的是链接本身，不跟随到目标；成功后调用方需重新拉目录与 Git 状态。

### 11.2.3 写入文件内容

```
PUT /v1/workspaces/{id}/files/content
Content-Type: application/json

{ "path": "src/a.js", "content": "...", "expected_mtime": 1726300000, "expected_size": 8123 }
```

| 参数 | 位置 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | path | 是 | Workspace ID |
| `path` | body | 是 | 相对文件路径（必须是已存在的普通文件） |
| `content` | body | 是 | 新文本内容（UTF-8） |
| `expected_mtime` | body | 否 | 读取时的 mtime（Unix 秒）；与当前不符 → `409` |
| `expected_size` | body | 否 | 读取时的文件大小；与当前不符 → `409` |

**响应** `200 OK`：

```json
{ "path": "src/a.js", "size": 123, "mtime": 1726300001 }
```

语义：

- 只覆盖已存在的普通文件（不新建、不写目录）：目录 → `400`，文件不存在 → `404`。
- `expected_mtime` / `expected_size` 是乐观并发护栏：文件在读取后被 Agent 或其他客户端改动时返回 `409`，客户端刷新后重试，避免静默覆盖。
- 原文件带 UTF-8 BOM 时自动保留 BOM；`content` 含 NUL 字节 → `400`；内容上限 8 MiB。
- 写入先落到同目录临时文件再 `rename` 覆盖，并发读取不会看到半截内容；文件权限模式沿用原文件，不做换行/格式化转换（CRLF 风格由客户端保持）。

### 12.2.1 下载文件（原始字节）

```
GET /v1/workspaces/{id}/files/raw?path=assets%2Flogo.png
```

| 参数 | 位置 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | path | 是 | Workspace ID |
| `path` | query | 是 | 相对文件路径 |

**响应** `200 OK`：`application/octet-stream` 原始字节流，带 `Content-Disposition: attachment; filename="<basename>"` 与 `Content-Length`。

语义：

- 与 `files/content`（1 MiB 文本预览）互补：无大小上限、不做 UTF-8/二进制判定，字节原样到达，供桌面端「下载到本地」使用。
- 路径校验与 `files/content` 一致：目录 → `400`；文件不存在 → `404`；`..`/`.git/`/绝对路径/盘符相对路径 → `403`。
- 文件名取逻辑路径 basename，剔除 `"`、`\` 与控制字符以保证头字段合法。

### 11.2.4 删除文件/目录

```
POST /v1/workspaces/{id}/files/delete
Content-Type: application/json

{ "path": "src/old" }
```

| 参数 | 位置 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | path | 是 | Workspace ID |
| `path` | body | 是 | 相对路径；空串（或 `.`）表示 workspace 根目录本身 |

**响应** `200 OK`：

```json
{ "path": "src/old", "name": "old", "is_dir": true }
```

语义：

- 目录**一次性递归删除整棵子树**（等价 `os.RemoveAll`），不存在「非空目录拒绝」。
- `path` 为空串时删除 workspace 根目录本身；文件系统根目录与服务端用户的 home 目录一律 `403`（误配置保护）。
- 符号链接删的是链接本身、不跟随目标，此时 `is_dir:false`。
- 路径不存在 → `404`；`..`/`.git/`/绝对路径/盘符相对路径 → `403`；删除失败（权限、被占用）→ `400`。
- 删除后调用方需重新拉目录与 Git 状态；根目录删除后 `git/status` 返回 `exists:false`。

### 11.2.5 新建文件 / 文件夹

```
POST /v1/workspaces/{id}/files/create
Content-Type: application/json

{ "path": "src", "name": "new.js", "is_dir": false }
```

| 参数 | 位置 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | path | 是 | Workspace ID |
| `path` | body | 否 | 父目录相对路径，默认 `""`（项目根），必须已存在 |
| `name` | body | 是 | 新条目名称，单个路径段 |
| `is_dir` | body | 否 | `true` 新建目录；默认新建空文件 |

**响应** `200 OK`：

```json
{ "path": "src/new.js", "name": "new.js", "is_dir": false }
```

语义：

- 父目录不存在 → `404`；父路径不是目录 → `400`；同名文件或目录已存在 → `409`。
- `name` 规则与重命名一致（空 / `.` / `..` / 含路径分隔符或控制字符 → `400`，Windows 额外拒绝 `<>:"|?*` 与点/空格结尾）；`.git` 与 `.tigerAgent` 为保留名 → `403`。
- 文件按 `0644` 创建、目录按 `0755` 创建。

### 11.2.6 上传文件

```
POST /v1/workspaces/{id}/files/upload?path=assets&name=logo.png[&overwrite=1]
Content-Type: application/octet-stream

<原始文件字节>
```

| 参数 | 位置 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | path | 是 | Workspace ID |
| `path` | query | 否 | 目标目录相对路径，默认 `""`（项目根），必须已存在 |
| `name` | query | 是 | 目标文件名（单个路径段） |
| `overwrite` | query | 否 | `1` 覆盖已存在的同名文件；默认冲突返回 `409` |

请求体是**原始字节**（不做 multipart / base64），按块流式写入目标目录的临时文件后 `rename`，不设大小上限（受服务端磁盘剩余空间限制）；该接口豁免全局 128 MiB 请求体内存上限（body 不经过内存缓冲）。

**响应** `200 OK`：

```json
{ "path": "assets/logo.png", "name": "logo.png", "size": 20480, "mtime": 1726300000 }
```

语义：

- 目标目录不存在 → `404`；不是目录 → `400`；同名**目录** → `400`；同名文件且未带 `overwrite=1` → `409`。
- 覆盖写入沿用原文件权限；落盘走同目录临时文件 + `rename`，并发读取不会看到半截内容。
- `name` 规则同 `files/create`（含 `.git` / `.tigerAgent` 保留名 → `403`）；磁盘写满等落盘失败 → `400`，不会留下半截文件。
- 桌面端由 Rust `upload_workspace_files`（原生多选对话框）逐个调用本接口，路径按文件 basename 取。

### 11.3 Git 状态

```
GET /v1/workspaces/{id}/git/status
```

**响应** `200 OK`（仓库）：

```json
{
  "exists": true,
  "is_repo": true,
  "git_installed": true,
  "branch": "main",
  "detached": false,
  "head": "3f9c1ab",
  "ahead": 1,
  "behind": 0,
  "entries": [
    { "path": "src/views/agent.js", "orig_path": "", "index": "M", "worktree": " ", "untracked": false, "ignored": false },
    { "path": "src/views/new.js", "orig_path": "", "index": "?", "worktree": "?", "untracked": true, "ignored": false },
    { "path": "src/views/renamed.js", "orig_path": "src/views/old.js", "index": "R", "worktree": " ", "untracked": false, "ignored": false }
  ],
  "truncated": false
}
```

非仓库 / 未安装 git 同样是 `200`（`is_repo:false` / `git_installed:false`，`entries:[]`），客户端据此禁用仓库级 Git 功能（命令面板）而不是显示错误。

主目录本身不是仓库、但子目录里有仓库时（多项目根目录），服务端会扫描子目录中的 `.git`（深度 5 层、最多 2000 个目录 / 20 个仓库，跳过 `.git`、`node_modules`、`.tigerAgent`、`.cache`），把这些仓库的状态聚合进 `entries`（路径带子目录前缀，如 `pi/a.txt`），并在 `nested_repos` 返回仓库相对根（如 `["pi"]`）。此时 `is_repo` 仍为 `false`，因为仓库级命令不适用于该目录本身。

语义：

- `entries[].path` 是 workspace 相对路径：workspace 位于仓库子目录时，服务端按 `git rev-parse --show-prefix` 裁剪仓库内其它子树。`orig_path` 仅重命名/复制条目有值。
- `index` / `worktree` 即 `git status --porcelain=v1` 的两列（`" "`、`M`、`A`、`D`、`R`、`C`、`U`、`?`、`!`）。
- 最多 5000 条，按路径排序后截断并置 `truncated:true`。
- `ahead` / `behind` 仅在上游存在时计算，失败归 0。
- workspace 目录在服务端已不存在时 `exists:false`。

### 11.4 Git 差异

```
GET /v1/workspaces/{id}/git/diff?path=src%2Fa.js&staged=0
```

| 参数 | 位置 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | path | 是 | Workspace ID |
| `path` | query | 是 | 相对文件路径 |
| `staged` | query | 否 | `1` = 索引 vs HEAD；默认 `0` = 工作区 vs 索引 |

**响应** `200 OK`：

```json
{
  "path": "src/a.js",
  "staged": false,
  "untracked": false,
  "binary": false,
  "truncated": false,
  "diff": "diff --git a/src/a.js b/src/a.js\n..."
}
```

语义：

- 未跟踪文件：`untracked:true`、`diff:""`，客户端用内容接口渲染「全部新增」。
- 二进制差异（`Binary files ` / `GIT binary patch`）：`binary:true`、`diff:""`。
- 无变更：`200` + `diff:""`。
- 直接返回 `git diff` 的 unified 文本（`--no-ext-diff --no-textconv --unified=3 --relative`），上限 2 MiB，超出截断并置 `truncated:true`。
- 已删除文件仍返回删除 diff；内容接口对同一路径返回 `404`。
- 主目录不是仓库时，服务端向上查找文件所属的子目录仓库并在该仓库执行 diff；文件不属于任何仓库 → `400`。
- `path` 命中 `.git/` 或逃逸 workspace → `403`；非 Git 仓库 → `400`；git 执行失败 → `500`。

### 11.5 错误码

| 状态码 | 场景 |
| --- | --- |
| `200` | 成功（含 `is_repo:false`、`untracked:true`、`binary:true` 等业务态） |
| `400` | 路径/名称缺失或格式非法、目标是目录（content/write）、目录不可读、`max_bytes` 非法、非 Git 仓库（diff）、写入内容过大或含 NUL |
| `403` | 路径逃逸 workspace、命中 `.git/`、跨盘符/UNC |
| `404` | workspace 不存在、文件不存在 |
| `409` | 重命名目标已存在；写入时 `expected_mtime` / `expected_size` 与当前文件不符 |
| `500` | git 执行失败（无法启动/未安装）、读取文件失败等内部错误 |

---

## 附录 A：数据结构定义

### Workspace 结构

```typescript
interface Workspace {
  id: string;                    // 工作区 ID
  path: string;                  // 工作目录路径
  yolo?: boolean;                // 跳过权限确认
  debug?: boolean;               // 调试模式
  data_dir?: string;             // 数据目录
  version?: string;              // 版本号
  client_id?: string;            // 创建者客户端 ID
  config?: object;               // 配置对象
  env?: string[];                // 环境变量
  skills?: SkillState[];         // Skill 快照
}
```

### Session 结构

```typescript
interface Session {
  id: string;
  parent_session_id: string;
  title: string;
  message_count: number;
  prompt_tokens: number;
  completion_tokens: number;
  context_tokens: number;
  summary_message_id: string;
  cost: number;
  todos?: Todo[];
  created_at: number;            // Unix 时间戳
  updated_at: number;
  is_busy: boolean;              // 是否有运行中的 Agent
  attached_clients: number;      // 当前查看此会话的客户端数
}

interface Todo {
  content: string;
  status: string;                // pending | in_progress | completed | cancelled
  active_form: string;
}
```

### <a id="message-结构"></a>Message 结构

```typescript
interface Message {
  id: string;
  role: "assistant" | "user" | "system" | "tool";
  session_id: string;
  parts: ContentPart[];
  model: string;
  provider: string;
  created_at: number;
  updated_at: number;
}

// ContentPart 是联合类型，通过 type 字段区分
type ContentPart =
  | { type: "text"; data: { text: string } }
  | { type: "reasoning"; data: { thinking: string; signature: string; started_at?: number; finished_at?: number } }
  | { type: "image_url"; data: { url: string; detail?: string } }
  | { type: "binary"; data: { path: string; mime_type: string; data: string } }
  | { type: "tool_call"; data: { id: string; name: string; input: string; type?: string; finished?: boolean } }
  | { type: "tool_result"; data: { tool_call_id: string; name: string; content: string; data?: string; mime_type?: string; metadata: string; is_error: boolean } }
  | { type: "finish"; data: { reason: string; time: number; message?: string; details?: string } }
  | { type: "shell_command"; data: { command: string; output: string; exit_code: number } };
```

**FinishReason 取值**：`end_turn`、`max_tokens`、`tool_use`、`canceled`、`error`、`unknown`

### PermissionRequest 结构

```typescript
interface PermissionRequest {
  id: string;
  session_id: string;
  tool_call_id: string;
  tool_name: string;             // bash | edit | write | multiedit | download | fetch | agentic_fetch | view | ls
  description: string;
  action: string;
  params: any;                   // 根据工具名反序列化为具体类型
  path: string;
}
```

### PermissionNotification 结构

```typescript
interface PermissionNotification {
  tool_call_id: string;
  granted: boolean;
  denied: boolean;
}
```

### AgentEvent 结构

```typescript
interface AgentEvent {
  type: "error" | "response" | "summarize";
  message: Message;              // 关联的消息（可能为零值）
  error?: string;                // 错误文本（仅 type=error 时有值）
  run_id?: string;               // 运行 ID（用于关联具体请求）
  session_id?: string;           // 会话 ID（摘要事件时使用）
  session_title?: string;        // 会话标题
  progress?: string;             // 进度描述（摘要事件）
  done?: boolean;                // 是否完成（摘要事件）
}
```

### RunComplete 结构

```typescript
interface RunComplete {
  session_id: string;
  run_id?: string;               // 运行 ID（用于关联请求）
  message_id: string;
  text?: string;                 // 最终文本输出
  error?: string;                // 错误信息（非空表示运行出错）
  cancelled?: boolean;           // 是否被取消
}
```

### MCPClientInfo 结构

```typescript
interface MCPClientInfo {
  name: string;
  state: "disabled" | "starting" | "connected" | "error";
  error?: string;
  tool_count?: number;
  prompt_count?: number;
  resource_count?: number;
  connected_at: string;          // ISO 8601 时间
}
```

### MCPEvent 结构

```typescript
interface MCPEvent {
  type: "state_changed" | "tools_list_changed" | "prompts_list_changed" | "resources_list_changed";
  name: string;
  state: "disabled" | "starting" | "connected" | "error";
  error?: string;
  tool_count?: number;
  prompt_count?: number;
  resource_count?: number;
}
```

### GitInfo 结构

```typescript
interface GitInfo {
  path: string;
  exists: boolean;               // 服务端能否看到该目录
  git_installed: boolean;        // 服务端是否装了 git
  is_repo: boolean;              // 是否处于 git 工作树内
}
```

### ProjectAnchor 结构

```typescript
interface ProjectAnchor {
  kind: "constraint" | "decision";
  key: string;                   // 去重键，服务端会按 kind:value 补全
  value: string;
  why?: string;
  source?: string;
  salience?: number;
  updated_at?: number;           // unix 秒
}
```

### SkillsEvent 结构

```typescript
interface SkillsEvent {
  states: SkillState[];
}

interface SkillState {
  name: string;
  path: string;
  state: number;                 // 0=normal, 1=error
  error?: string;
}
```

### ConfigChanged 结构

```typescript
interface ConfigChanged {
  workspace_id: string;
}
```

### AgentInfo 结构

```typescript
interface AgentInfo {
  is_busy: boolean;
  is_ready: boolean;
  model: ModelInfo;
  model_cfg: SelectedModel;
}

interface ModelInfo {
  id: string;
  name?: string;
  ctx_size?: number;                 // 上下文窗口；旧键 context_window 仅为配置输入别名
  output_tokens?: number;            // 旧键 default_max_tokens（配置别名）
  provider_max_output_tokens?: number; // 旧键 max_output_tokens（配置别名）
  default_reasoning_effort?: string;
  reasoning_levels?: string[];
  supports_images?: boolean;
  can_reason?: boolean;
  cost_per_1m_in?: number;
  cost_per_1m_out?: number;
  cost_per_1m_in_cached?: number;
  cost_per_1m_out_cached?: number;
  options?: ModelInfoOptions;
}

interface ModelInfoOptions {
  provider_options?: Record<string, any>;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
}

interface SelectedModel {
  model: string;
  provider: string;
  reasoning_effort?: string;     // none | low | medium | high | off
  think?: boolean;
  thinking?: { type: "enabled" | "disabled" };
  temperature?: number;
  top_p?: number;
  top_k?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  provider_options?: Record<string, any>;
}
```

### Config Scope 枚举

```typescript
enum Scope {
  Global = 0,      // ~/.local/share/tigerAgent/tigerAgent.json
  Workspace = 1,   // .Agent/tigerAgent.json
}
```

---

## 附录 B：GUI 开发建议

### B.1 客户端标识 (client_id)

以下接口**必须**提供 `client_id`（UUID 格式，服务端会校验格式）：

- `DELETE /v1/clients/{client_id}` — 路径参数
- `DELETE /v1/workspaces/{id}?client_id=...` — 查询参数
- `POST /v1/workspaces/{id}/current-session?client_id=...` — 查询参数
- `GET /v1/workspaces/{id}/events?client_id=...` — 查询参数

如果 `client_id` 缺失或不是有效的 UUID，服务器返回 `400 Bad Request`。

GUI 启动时应生成一个全局唯一的 `client_id` 并在整个生命周期中复用。退出时应调用 `DELETE /v1/clients/{client_id}` 以释放服务器端资源。

### B.2 典型 GUI 工作流

```
1. GET  /v1/health                         → 检查 server 是否在线
2. GET  /v1/version                        → 获取版本信息
3. POST /v1/workspaces                     → 创建/连接工作区
4. POST /v1/workspaces/{id}/agent/init     → 初始化 Agent
5. GET  /v1/workspaces/{id}/project/needs-init → 检查是否需要项目初始化
6. POST /v1/workspaces/{id}/sessions       → 创建会话
7. GET  /v1/workspaces/{id}/events         → 建立 SSE 连接（保持长连接）
8. POST /v1/workspaces/{id}/agent          → 发送用户消息
9.    [SSE] message 事件                   → 增量渲染 Agent 输出
10.   [SSE] permission_request 事件         → 弹出权限确认对话框
11. POST /v1/workspaces/{id}/permissions/grant → 用户授权/拒绝
12.   [SSE] run_complete 事件               → 标记本轮对话结束
...
13. DELETE /v1/clients/{client_id}         → GUI 退出时回收客户端
```

### B.3 SSE 事件处理要点

1. **先订阅再发消息**：建立 SSE 连接后再发送 Agent 消息，避免遗漏事件。
2. **断线重连**：SSE 连接断开后需自动重连，重连后重新获取会话状态（`GET /sessions/{sid}/messages`）以补全可能缺失的消息。
3. **多客户端同步**：多个 GUI 客户端可同时连接同一工作区，通过 SSE 事件保持状态同步。`attached_clients` 字段反映当前查看某会话的客户端数量。
4. **RunComplete 关联**：使用 `run_id` 精确关联请求与完成事件，特别是在会话繁忙时排队多个请求的场景。
5. **AgentEvent 错误关联**：`agent_event` 事件中的 `error` 类型也携带 `run_id`，可用于将运行时错误关联到具体请求。

### B.4 权限处理流程

```
[SSE] permission_request 事件到达
  → GUI 弹出确认对话框，显示 tool_name、description、params
  → 用户选择：允许 / 允许本次会话 / 拒绝
  → POST /v1/workspaces/{id}/permissions/grant
  → [SSE] permission_notification 事件确认处理结果
```

### B.5 服务器关闭流程

```
GUI 准备退出或升级：
  → POST /v1/control { "command": "shutdown_if_idle" }
  → 200 OK: 服务器空闲，已开始关闭
  → 409: 服务器非空闲（有活跃会话），拒绝关闭
  → 400: 服务器不支持空闲检测（旧版本）
```

> **注意**：`shutdown` 和 `shutdown_if_idle` 均经过空闲检测。两者的区别仅在于旧版服务器的行为：旧版会直接执行 `shutdown`（可能中断活跃会话），但对 `shutdown_if_idle` 返回 `400`（未知命令）。

### B.6 API 端点汇总表

| # | 方法 | 路径 | 说明 |
|---|------|------|------|
| 1 | GET | `/v1/health` | 健康检查 |
| 2 | GET | `/v1/version` | 版本信息 |
| 3 | GET | `/v1/config` | 全局配置 |
| 4 | POST | `/v1/control` | 控制命令（shutdown / shutdown_if_idle） |
| 5 | DELETE | `/v1/clients/{client_id}` | 回收客户端 |
| 6 | GET | `/v1/workspaces` | 列出工作区 |
| 7 | POST | `/v1/workspaces` | 创建工作区 |
| 8 | DELETE | `/v1/workspaces/{id}` | 删除工作区 |
| 9 | GET | `/v1/workspaces/{id}` | 获取工作区 |
| 10 | POST | `/v1/workspaces/{id}/current-session` | 设置当前会话 |
| 11 | GET | `/v1/workspaces/{id}/config` | 工作区配置 |
| 12 | GET | `/v1/workspaces/{id}/providers` | 可用 Providers |
| 13 | GET | `/v1/workspaces/{id}/events` | SSE 事件流 |
| 14 | GET | `/v1/workspaces/{id}/messages/user` | 所有用户消息 |
| 15 | GET | `/v1/workspaces/{id}/sessions` | 列出会话 |
| 16 | POST | `/v1/workspaces/{id}/sessions` | 创建会话 |
| 17 | GET | `/v1/workspaces/{id}/sessions/{sid}` | 获取会话 |
| 18 | PUT | `/v1/workspaces/{id}/sessions/{sid}` | 更新会话 |
| 19 | DELETE | `/v1/workspaces/{id}/sessions/{sid}` | 删除会话 |
| 20 | GET | `/v1/workspaces/{id}/sessions/{sid}/history` | 历史文件 |
| 21 | GET | `/v1/workspaces/{id}/sessions/{sid}/messages` | 会话消息 |
| 22 | GET | `/v1/workspaces/{id}/sessions/{sid}/messages/user` | 用户消息 |
| 23 | GET | `/v1/workspaces/{id}/sessions/{sid}/filetracker/files` | 追踪文件 |
| 24 | POST | `/v1/workspaces/{id}/filetracker/read` | 记录文件读取 |
| 25 | GET | `/v1/workspaces/{id}/filetracker/lastread` | 最后读取时间 |
| 26 | GET | `/v1/workspaces/{id}/permissions/skip` | 获取跳过权限状态 |
| 27 | POST | `/v1/workspaces/{id}/permissions/skip` | 设置跳过权限 |
| 28 | POST | `/v1/workspaces/{id}/permissions/grant` | 授权权限请求 |
| 29 | GET | `/v1/workspaces/{id}/agent` | Agent 信息 |
| 30 | POST | `/v1/workspaces/{id}/agent` | 发送消息给 Agent |
| 31 | POST | `/v1/workspaces/{id}/agent/init` | 初始化 Agent |
| 32 | POST | `/v1/workspaces/{id}/agent/update` | 更新 Agent |
| 33 | GET | `/v1/workspaces/{id}/agent/sessions/{sid}` | Agent 会话信息 |
| 34 | POST | `/v1/workspaces/{id}/agent/sessions/{sid}/cancel` | 取消会话 |
| 35 | GET | `/v1/workspaces/{id}/agent/sessions/{sid}/prompts/queued` | 排队状态 |
| 36 | GET | `/v1/workspaces/{id}/agent/sessions/{sid}/prompts/list` | 排队列表 |
| 37 | POST | `/v1/workspaces/{id}/agent/sessions/{sid}/prompts/clear` | 清除排队 |
| 38 | POST | `/v1/workspaces/{id}/agent/sessions/{sid}/summarize` | 摘要会话 |
| 39 | POST | `/v1/workspaces/{id}/agent/sessions/{sid}/undo` | 撤销上一轮 |
| 40 | POST | `/v1/workspaces/{id}/agent/sessions/{sid}/shell` | 执行 Shell |
| 41 | POST | `/v1/workspaces/{id}/config/set` | 设置配置字段 |
| 42 | POST | `/v1/workspaces/{id}/config/remove` | 移除配置字段 |
| 43 | POST | `/v1/workspaces/{id}/config/model` | 设置模型 |
| 44 | POST | `/v1/workspaces/{id}/config/compact` | 设置 Compact 模式 |
| 45 | POST | `/v1/workspaces/{id}/config/provider-key` | 设置 API Key |
| 46 | GET | `/v1/workspaces/{id}/project/needs-init` | 检查项目初始化 |
| 47 | POST | `/v1/workspaces/{id}/project/init` | 标记已初始化 |
| 48 | GET | `/v1/workspaces/{id}/project/init-prompt` | 初始化提示 |
| 49 | GET | `/v1/workspaces/{id}/skills` | Skills 列表 |
| 50 | POST | `/v1/workspaces/{id}/skills/read` | 读取 Skill |
| 51 | POST | `/v1/workspaces/{id}/mcp/refresh-tools` | 刷新 MCP 工具 |
| 52 | POST | `/v1/workspaces/{id}/mcp/read-resource` | 读取 MCP 资源 |
| 53 | POST | `/v1/workspaces/{id}/mcp/get-prompt` | 获取 MCP Prompt |
| 54 | GET | `/v1/workspaces/{id}/mcp/states` | MCP 状态 |
| 55 | POST | `/v1/workspaces/{id}/mcp/refresh-prompts` | 刷新 MCP Prompts |
| 56 | POST | `/v1/workspaces/{id}/mcp/refresh-resources` | 刷新 MCP Resources |
| 57 | POST | `/v1/workspaces/{id}/mcp/docker/enable` | 启用 Docker MCP |
| 58 | POST | `/v1/workspaces/{id}/mcp/docker/disable` | 禁用 Docker MCP |
| 59 | GET | `/v1/workspaces/{id}/git-info` | 工作区 git 信息 |
| 60 | GET | `/v1/workspaces/{id}/project-memory` | 读取项目记忆 |
| 61 | POST | `/v1/workspaces/{id}/project-memory` | 覆盖项目记忆 |
| 62 | GET | `/v1/docs/` | Swagger 文档 |
