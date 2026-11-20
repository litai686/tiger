# TCP 传输安全设计：TLS 1.3 + 服务端指纹 pin + Bearer token

> 状态：**已实现（v1.0）** — 服务端 / Go 客户端 / 桌面端均已按本文实现；客户端只填一条连接串，服务端自带 `/admin` 管理界面
>
> 范围：`server` 模式在 `tcp://` 传输下的加密与服务端身份校验、客户端 token 认证，以及内嵌管理界面
>
> 相关源码（服务端）：`internal/server/auth.go`、`internal/server/admin.go`、`internal/server/adminui/`、`internal/server/tls.go`、`internal/server/tls_handlers.go`、`internal/server/server.go`、`internal/server/logging.go`、`internal/cmd/tls.go`、`internal/cmd/server.go`、`internal/cmd/root.go`、`internal/config/config.go`、`internal/client/tls.go`、`internal/client/client.go`、`internal/proto/version.go`
>
> 相关源码（桌面端）：`desktop/src-tauri/src/common/agent_http.rs`、`desktop/src-tauri/src/common/server_mode.rs`、`desktop/src-tauri/src/common/types.rs`、`desktop/src-tauri/src/pages/settings.rs`、`desktop/src/views/settings.js`、`desktop/src/index.html`、`desktop/src/i18n.js`
>
> 关联文档：`docs/server-api.md`、`docs/desktop-server-settings.md`、`desktop/doc/frontend-architecture.md`、`desktop/doc/rust-backend.md`
>
> **变更记录**
>
> - v0.1：TLS + SPKI pinning；客户端认证可选 token 或 mTLS。
> - v0.2–v0.7：曾经采用 Ed25519 双向认证（客户端自签证书 + 服务端 `clients.json` 白名单、`pair --approve` / `pair --window` / `clients` / `device` 命令）。该模型要求客户端生成设备身份并交给服务端批准，配对成本高，已在 v0.8 整体移除。
> - v0.8：**单向 TLS + Bearer token**。服务端继续自签 Ed25519 证书，客户端用 SPKI 指纹 pin 住服务端（防中间人）；客户端身份改由服务端生成的随机 token 证明，客户端**不再生成任何指纹/证书**。地址、指纹、token 合并成**一条连接串**，客户端整条粘贴即可。
> - v0.9：token 从单文件改为**多 token 列表**（`tls/tokens.json`，支持生成/删除/查看、按 token 统计活跃连接），并内嵌 `html+css+js` 管理界面 `/admin/`：登录需填**服务端指纹 + 任一有效 token**，可一键复制各 token 的连接串。
> - v1.0（当前）：服务端身份从 Ed25519 切换为 **ECDSA P-256** 自签证书。原因：Chromium 系浏览器（Chrome/Edge）不在 TLS 1.3 `signature_algorithms` 里声明 Ed25519，Go 服务端选不到可用证书，`/admin/` 无法打开（日志 `tls: peer doesn't support any of the certificate's signature algorithms`）；P-256 被所有主流浏览器接受。升级时旧 Ed25519 身份会被自动替换，**指纹变化**，客户端与管理界面需用新连接串。
>
> 历史版本（v0.1–v0.7）的设计正文已随实现删除；需要追溯 mTLS 细节时查 git 历史。

---

## 1. 目标与非目标

### 1.1 目标

1. TCP 传输的机密性与完整性（TLS 1.3，AEAD + 前向保密）。
2. **服务端身份可验证**：ECDSA P-256 自签证书 + 客户端 SPKI pin，不需要 CA、域名、公网；浏览器也能直连 `/admin/`。
3. **客户端身份可验证**：服务端生成 256-bit 随机 token，客户端以 `Authorization: Bearer` 出示；服务端常量时间比较。
4. 客户端零配置负担：**一条连接串**（`tigerAgent://[host][:port]?fp=…&token=…`，省略端口时默认 443）完成全部参数。
5. 零外部依赖（仅 Go 标准库），不改变 REST/SSE 协议语义。
6. 桌面端（`desktop/`，Tauri v2 + Rust）为第一目标客户端：`send` / `stream_get` 调用方零改动，token 在统一的请求包装层注入。

### 1.2 非目标

- 不做客户端证书 / mTLS / 设备白名单 / 配对窗口（v0.8 已删除）。
- 不做应用层 AES 信封加密或自研握手（TLS 已提供加密、完整性与抗重放）。
- 不替代 WireGuard / Tailscale 之类的网络层隔离（见 §7.4）。

---

## 2. 威胁模型

| # | 威胁 | 缓解措施 | 覆盖 |
|---|------|----------|------|
| T1 | 同网段被动窃听 | TLS 1.3 全程加密 | ✅ |
| T2 | 主动中间人（ARP/DNS 欺骗、透明代理） | 服务端 ECDSA P-256 证书 + SPKI pin，指纹不匹配硬失败、不回退明文 | ✅ |
| T3 | 未授权设备连接 | Bearer token（256-bit 随机）；无 token / 错 token → 401 | ✅（token 可复制，见 §7.1） |
| T4 | 重放历史流量 | TLS AEAD + 每连接独立密钥 | ✅ |
| T5 | 服务端私钥泄露 | `server.key` 0600，仅存本地；可用 `--tls-regenerate` 轮换（指纹变化） | ✅ |
| T6 | 客户端凭据被复制 | token 是 bearer 凭据，复制即可冒用；撤销只能 `--rotate-token`（影响所有客户端） | ⚠️ 见 §7.1 |
| T7 | 本机其他用户读取密钥/token | 数据目录 0700，`server.key` / `token` 0600 | ✅ |
| T9 | 恶意服务端冒充（客户端连错地址） | 指纹不匹配即硬失败 | ✅ |
| T10 | 降级攻击（诱导客户端走明文） | 服务端 `tcp` 默认强制 TLS；客户端无「无 pin」代码路径 | ✅ |
| T11 | token 泄漏 | `tigerAgent --rotate-token` 立即换发，旧 token 全部失效 | ✅（全局撤销，非按设备） |

> 与 v0.7 的差异：原 T3 依赖客户端证书 + 白名单，现在依赖共享 token。敌方拿到 token 即可连接（和任何 bearer 方案一样）；拿到 server 指纹不构成威胁（指纹是公开信息）。

---

## 3. 总体设计

```
┌─────────────────────────────────────────────┐
│ 应用层：REST /v1/*  + SSE /events           │  ← 不变
├─────────────────────────────────────────────┤
│ 认证层：Authorization: Bearer <token>       │  ← 新增（server/auth.go）
├─────────────────────────────────────────────┤
│ 传输层：HTTP/1.1 (+ h2 via ALPN)            │
├─────────────────────────────────────────────┤
│ 安全层：TLS 1.3 + 服务端 ECDSA P-256 证书    │  ← 客户端 SPKI pin
├─────────────────────────────────────────────┤
│ net.Listener：tcp / unix / npipe            │  ← 不变
└─────────────────────────────────────────────┘
```

### 3.1 行为矩阵

| host scheme | TLS | 认证 | 说明 | 桌面端 |
|-------------|-----|------|------|--------|
| `unix` | off | off | OS 文件权限（socket 0600） | 不使用 |
| `npipe` | off | off | Windows 用户级管道 ACL | 不使用 |
| `tcp://127.0.0.1:*` | on | **token** | 环回也加密；token 防同机其他用户 | 允许 |
| `tcp://<非环回>` | on（强制） | **token** | 需显式 `--tls=off --allow-plaintext-tcp` 才允许明文（token 会以明文传输，启动时告警） | 远程模式 |

### 3.2 连接建立时序

1. 服务端启动：加载/生成 `server.key`、`server.crt`、`token`，打印连接串。
2. 客户端解析连接串，按 `fp` 建立 TLS 1.3 连接（实际身份由 pin 判定，与证书 SAN / SNI 无关；Go 客户端 SNI 固定 `tigerAgent.local`，桌面端 SNI 取连接串 host、IP 字面量不发 SNI，便于域名 + 反向代理按 SNI 路由）。
3. 握手成功后，客户端在每个请求带 `Authorization: Bearer <token>`。
4. 服务端中间件校验 token：通过则进入路由，否则 401 + `WWW-Authenticate: Bearer`。
5. SSE 长连接使用同一条头部（桌面端 Rust hyper 可设头，不依赖浏览器 EventSource）。

### 3.3 匿名端点

以下端点不要求 token（不含用户数据，且让客户端能区分「服务端没启动」与「token 不对」）：

- `GET /v1/health`
- `GET /v1/version`
- `GET /v1/tls/info`

其余 `/v1/*`（含 SSE `/v1/workspaces/{id}/events`、`/v1/docs/`）一律需要 token。

---

## 4. 证书、指纹与 token

### 4.1 文件布局

默认目录 `<data-dir>/tls/`：

| 文件 | 内容 | 权限 |
|------|------|------|
| `server.key` | ECDSA P-256 私钥，PKCS#8 DER | 0600 |
| `server.crt` | 自签证书 DER（SAN：`tigerAgent.local`、`localhost`、`127.0.0.1`、`::1`；有效期 3650 天） | 0644 |
| `token` | Bearer token，base64url（32 字节随机，43 字符） | 0600 |

`clients.json` / `pending.json` / `pair_window.json` 不再存在。

### 4.2 指纹定义

```
sha256:<base64url_nopad(sha256(cert.RawSubjectPublicKeyInfo))>
```

用 SPKI 而非整张证书：`--tls-regenerate-cert` 重签证书时指纹不变，客户端无需改配置。Go 与 Rust 两侧必须逐字节一致（`server.SPKIFingerprint` / `agent_http::spki_fingerprint`）。

### 4.3 token 生命周期

- 首次启动自动生成一个名为 `default` 的 token 并写入 `<data-dir>/tls/tokens.json`（0600）；v0.8 的单个 `tls/token` 文件会在首次加载时自动迁移成 `default` 记录并删除。
- 可同时存在多个 token（管理界面生成，名称可选）；每个 token 独立记录 `last_seen` / `last_addr` / 当前活跃连接数。
- 删除某个 token 会立即关闭使用它的连接；**最后一个 token 不允许删除**（否则管理界面会把自己锁在外面）。
- `tigerAgent --rotate-token` 会删除全部旧 token 并生成一个新的 `default`，打印新连接串后退出；运行中的服务端会在 1 秒内重新加载 `tokens.json`（无需重启）。
- token 与 TLS 私钥同为 0600 文件，信任级别一致；token 明文存储是因为管理界面需要再次展示。
- token 只用于认证，不参与加密；加密始终由 TLS 完成。

### 4.4 管理界面（`/admin/`）

- 入口：`<addr>/admin/`，静态资源内嵌在二进制（`internal/server/adminui/`，`go:embed`），不依赖外部文件或 CDN。
- 登录：**服务端指纹 + 任一有效 token**。指纹只用于确认连的是正确服务端，不能单独作为密码——`/v1/tls/info` 匿名返回指纹。
- 会话：`HttpOnly` + `SameSite=Strict` + `Secure` cookie，8 小时过期，绑定登录时用的 token；该 token 被删除后会话立即失效。
- 管理能力：查看服务器地址/版本/运行时长/活跃连接数/指纹；生成 token（可选名称）；删除 token（同时断开其连接）；查看每个 token 的最近使用时间与来源地址；一键复制 token、连接串、指纹。
- 防护：`POST` / `DELETE` 要求 `X-Requested-With: tigerAgent-admin` 且校验 `Origin` 同源（CSRF）；每 IP 每分钟最多 8 次失败尝试，失败后延迟 150ms；接口响应 `Cache-Control: no-store`。
- 仅 TLS 下可用：`--tls=off` 时登录直接返回 400。
- 浏览器兼容：服务端证书为 ECDSA P-256 + TLS 1.3，Chrome / Edge / Firefox 均可访问；自签证书首次访问需在浏览器里点「高级 → 继续前往」。

### 4.4 连接串

```
tigerAgent://[host][:port]?fp=<sha256:…>&token=<…>
```

- 由服务端生成：启动时打印到 **stderr**（不写入日志文件），或 `tigerAgent --print-connection` 重新打印。
- 值为 `host:port`、`sha256:`+base64url、base64url，均为安全字符，**不做百分号编码**；Go 与 Rust 用同一格式手工拼接/解析。
- **端口可省略**：省略时默认 443，适用于域名 / 反向代理 / 隧道预览域名部署（如 `tigerAgent://8000-xxx.preview.example.com?fp=…&token=…`）；此时客户端直连 443，要求代理**透传 TCP/TLS**（代理终止 TLS 会使 pin 校验失败），由代理转发到服务端实际监听端口。
- 监听 host 留空 / `0.0.0.0` / `::` 时，打印的 host 取本机第一个非环回 IPv4（没有则 `127.0.0.1`），需要公网/域名时手动替换 host 部分。
- 连接串含 token，**不要**做二维码、贴到公开渠道或写进日志。

---

## 5. 服务端实现

### 5.1 TLS（`internal/server/tls.go`）

- `ServerTLSConfig` 只装证书，固定 `MinVersion = MaxVersion = TLS 1.3`，`ClientAuth` 保持 `NoClientCert`（不请求客户端证书）。
- 自签身份固定为 **ECDSA P-256**（`crypto/ecdsa` + `elliptic.P256`）：`server.key` 为 PKCS#8 DER，`server.crt` 为 DER 自签证书；TLS 1.3 下签名算法为 `ecdsa_secp256r1_sha256`。
- `--tls-cert/--tls-key` 也必须提供 P-256 私钥，其它算法直接报错 `key is not ECDSA P-256`；可用于替换为受信任 CA 签发的 P-256 证书，从而消除浏览器自签告警。
- 升级兼容：启动时若发现旧 Ed25519 `server.key`/`server.crt`，自动生成并覆盖为新的 P-256 身份（stderr 输出 WARN 与新指纹），客户端需重新配对。
- 禁止明文 TCP（除 `--tls=off --allow-plaintext-tcp`）。
- `--tls-regenerate` 换密钥（指纹变化，客户端需更新连接串）；`--tls-regenerate-cert` 只重签（指纹不变）。

### 5.2 认证（`internal/server/auth.go`）

- `AuthStore`：加载/维护 `tokens.json`（多 token）、`Verify` 用 `crypto/subtle.ConstantTimeCompare`、`Add` / `Delete`（拒绝删最后一个）/ `Rotate`、连接注册表（`AttachConn` / `DetachConn` / `ActiveConnections`）。
- `Server.EnableAuth(store)` 在 `ListenAndServe` 前调用；中间件包在路由最外层（`server.go` 的 `authHandler(bodyLimitHandler(mux))`），401 在进入任何 handler 之前返回。
- `ConnContext` 把 `net.Conn` 挂进请求上下文，认证成功后登记到 token；token 被删除时直接关闭这些连接。
- `AuthMode()` 返回 `token` / `none`，供 `/v1/version`、`/v1/tls/info` 上报。
- 访问日志只记录 `auth=bearer` 或空，**不记录** token 值。

### 5.3 CLI

```bash
# 启动服务（TCP 自动启用 TLS + token）
# 启动后打印：客户端连接串、管理页面地址、登录用指纹与 token
tigerAgent --host tcp://:18471

# 只打印连接串（会创建证书/token，适合首次部署或忘记保存时）
tigerAgent --print-connection

# 只打印指纹（调试用）
tigerAgent --print-fingerprint

# 轮换 token（删除全部旧 token，打印新连接串后退出；运行中的服务端 1 秒内生效）
tigerAgent --rotate-token

# 证书维护
tigerAgent --tls-regenerate         # 换密钥（指纹变化）
tigerAgent --tls-regenerate-cert    # 只重签（指纹不变）

# 显式明文 TCP（token 会被明文传输，启动时告警）
tigerAgent --host tcp://:18471 --tls=off --allow-plaintext-tcp
```

`tigerAgent pair`、`clients`、`device` 命令已删除；`--tls-client-auth`、`--pinned-clients`、`--pair-window`、`--pair-auto-approve` 标志已删除。

监听地址的 host 留空（`tcp://:18471`，等价于所有网卡）时，服务端分别绑定 `0.0.0.0`（IPv4）和 `[::]`（IPv6，`IPV6_V6ONLY=1`）两个 socket，`netstat` / `ss` 中显示为 `tcp` / `tcp6` 各一行；主机禁用 IPv6 时只绑 IPv4 并在日志中告警，IPv4 绑定失败（如端口被占用）则直接启动失败。显式写 host（`0.0.0.0` / `[::]` / 具体 IP）时只绑该地址。

### 5.4 配置（`options.server`）

保留：`tls`、`cert_file`、`key_file`、`cert_validity_days`、`allow_plaintext_tcp`。
删除：`client_auth`、`pinned_clients`、`pair_window`、`pair_auto_approve`。

### 5.5 API

`GET /v1/tls/info`（匿名）：

```json
{
  "tls_required": true,
  "fingerprint": "sha256:…",
  "auth": "token",
  "server_name": "tigerAgent.local",
  "protocol": "tls1.3"
}
```

`GET /v1/version` 同样带 `auth` 字段（`token` / `none`）。字段 `client_auth` 已移除。

管理界面 API（cookie 会话，不要求 Bearer 头；登录除外）：

| 端点 | 说明 |
|------|------|
| `GET /admin/` | 管理界面（内嵌静态资源） |
| `POST /admin/api/login` | `{fingerprint, token}` → 设置会话 cookie |
| `POST /admin/api/logout` | 退出登录 |
| `GET /admin/api/state` | 服务器信息 + token 列表（含连接串、最近使用、活跃连接） |
| `POST /admin/api/tokens` | `{name}` → 生成 token（需要 CSRF 头） |
| `DELETE /admin/api/tokens/{id}` | 删除 token 并断开其连接（需要 CSRF 头） |

---

## 6. 客户端实现

### 6.1 Go 客户端（`internal/client`）

- `EnableTLS(TLSConfig{Pin, Token, ServerName})`：TLS 1.3，`InsecureSkipVerify` + `VerifyConnection` 内做 SPKI 比对（常量时间），token 由 `buildReq` 统一附加。
- `SetToken` 用于不走 TLS 的调用（unix / plaintext tcp）。
- 错误分类：`ErrFingerprintMismatch`、`ErrNoServerCert`、`ErrServerRequiresTLS`、`ErrUnauthorized`。

### 6.2 桌面端（`desktop/src-tauri`）

- 设置页只有一个输入框：连接串。保存前用 `server_mode::parse_connection` 校验（缺 `fp` / 缺 `token` / 缺 `?` 都给出具体错误）；**端口可省略，默认 443**（域名 / 反向代理部署，如 `tigerAgent://8000-xxx.preview.example.com?fp=…&token=…`），IPv6 需写 `[::1]:port`。
- `TcpTarget { host, port, pin, token }`；`agent_http::AgentHttpClient` 包装 hyper 客户端，在 `request()` 里统一加 `Authorization: Bearer`，`send` / `stream_get` / `health_check` 调用方无需感知 token。
- TLS 配置：`with_no_client_auth()` + 自定义 `SpkiPinVerifier`；不出示客户端证书。SNI 取 `TcpTarget.host`（`ServerName::try_from`，IP 字面量走 `IpAddress` 不发 SNI），身份仍只由 pin 判定——域名 + 反向代理可按 SNI 路由到服务端。
- 「检测服务端」= 解析连接串 → `/v1/health`（匿名，判断可达）→ `/v1/workspaces`（认证，区分 token 错误）。
- 设备身份目录 `<app_data>/device/`、`prepare_device_identity` 命令、`rcgen` 依赖均已删除；旧配置里的 `server.mode` / `server.remote.addr` / `server.remote.fingerprint` 会被忽略，需要重新粘贴连接串。

---

## 7. 安全约束与已知限制

### 7.1 token 是共享凭据

- 无按设备身份 / 按设备撤销：泄漏后 `--rotate-token` 会让所有客户端同时失效，需要逐个更新连接串。
- 客户端把 token 存明文 `config.json`；同机其他用户若能读该文件即可冒用（多用户机器建议依赖 OS 账户隔离）。
- 服务端启动时把连接串打印到终端，注意 shell 历史 / 屏幕共享 / CI 日志。

### 7.2 指纹不是秘密

`fp` 用于防中间人（客户端校验服务端），泄漏它不会让攻击者获得访问权；反过来，只拿 token 但指纹不匹配的客户端也连不上，因为服务端证书 pin 会失败。

### 7.3 明文 TCP

`--tls=off --allow-plaintext-tcp` 下 token 会以明文传输，仅供完全可信的本机网络临时调试。

### 7.4 不替代网络层隔离

对外暴露时仍建议只监听内网地址 / 环回，或用防火墙、WireGuard/Tailscale 限制来源；token 只解决「谁在调用」，不解决「谁能扫到端口」。

### 7.5 本地传输

`unix` / `npipe` 依赖 OS 权限，不启用 TLS 与 token（`AuthMode()` 返回 `none`）。

---

## 8. 测试

- `internal/server/tls_test.go`：证书/指纹稳定性（ECDSA P-256 身份生成、旧 Ed25519 身份自动迁移、非 P-256 自定义证书被拒）、`AuthStore`（多 token 生成/持久化/0600/校验/删除/轮换/旧文件迁移/连接计数）、连接串格式、认证中间件（匿名端点、401、Bearer 大小写）。
- `internal/server/admin_test.go`：管理界面登录（TLS/指纹/token 三要素）、会话 cookie、token 增删、最后 token 保护、CSRF、删除 token 后会话失效、静态资源。
- `internal/server/e2e_tls_test.go`：无客户端证书的 TLS 握手、pin 不匹配、明文请求被拒、TLS 1.2 被拒、`/v1/tls/info` 字段、受保护端点无 token 返回 401。
- `internal/client/tls_test.go`：pin-only 连接、Bearer token 注入、无 token 被拒、pin 不匹配、`SetToken`。
- 桌面端：`server_mode` 连接串解析单测（`host:port`、域名无端口默认 443、`[::1]` / `[::1]:port`、非法 host 拒绝）；前端 `pnpm typecheck`。

---

## 9. 迁移清单（v0.7 → v0.8）

1. 服务端升级后启动一次，拿到打印的连接串（或 `--print-connection`）与管理界面地址。
2. 桌面端设置页粘贴连接串，删除旧的「地址 / 指纹 / 生成设备身份」配置（旧字段会被忽略）。
3. 服务端 `tls/` 目录下的 `clients.json`、`pending.json`、`pair_window.json` 可删除；旧的 `tls/token` 会自动迁移进 `tls/tokens.json`。
4. 若之前分发过旧 mTLS 客户端，升级到新版本后重新粘贴连接串。
5. 对外部署请确认只暴露必要网段；token 泄漏时执行 `--rotate-token` 并重新分发连接串。

---

## 10. 迁移清单（Ed25519 → ECDSA P-256）

1. 升级服务端后首次启动（或执行 `--print-connection` / `--print-fingerprint`）时，旧的 Ed25519 `server.key` / `server.crt` 会被自动替换为新的 ECDSA P-256 身份，日志出现 WARN 与新指纹。
2. **所有客户端必须换成新连接串**：旧 pin 会对新证书硬失败（`server fingerprint mismatch`），这是预期行为，不存在自动信任新密钥的回退路径。
3. 管理界面登录用「新指纹 + 原 token」；`tokens.json` 不受影响。
4. 自签 P-256 证书仍会触发浏览器证书告警（`ERR_CERT_AUTHORITY_INVALID`），点「高级 → 继续前往」即可；如需无告警，改用受信任 CA 签发的 P-256 证书（`--tls-cert/--tls-key`）。
5. Ed25519 与 P-256 密钥无法互转，旧指纹无法保留；如需保留旧客户端连接，只能让旧版本服务端继续运行直到客户端全部升级。
