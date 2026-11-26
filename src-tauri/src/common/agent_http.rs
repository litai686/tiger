//! Agent 服务端传输：TCP + TLS 1.3（服务端 SPKI pin）+ Bearer token。
//!
//! 桌面端不再有「本地 sidecar」模式：服务端由用户自行启动，桌面端只做客户端，
//! 设置页只需粘贴一条连接串（地址 + 服务端指纹 + token，见
//! `docs/tcp-tls-ecdsa.md` §11）。reqwest 无法固定自签证书的 pin，因此这里用
//! hyper 直接对 TLS 流发起 HTTP/1.1 请求（含 SSE 长连接流）。

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use hyper::body::{Bytes, Incoming};
use hyper::Uri;
use http_body_util::combinators::UnsyncBoxBody;
use hyper_util::client::legacy::Client;
use hyper_util::rt::{TokioExecutor, TokioIo};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use tokio_rustls::TlsConnector;

use base64::Engine;
use sha2::{Digest, Sha256};

// 客户端 TLS 握手中发送的 SNI 取连接串里的 host（`docs/tcp-tls-ecdsa.md` §11）。
// 服务端自签证书的 SAN 固定为 `tigerAgent.local`，但身份由 SPKI pin 校验收口，
// 不依赖主机名；SNI 用真实 host 是为了让「域名 + 反向代理 / 隧道预览域名」的
// 部署能按 SNI 路由到服务端。IP 字面量走 `ServerName::IpAddress`，不发 SNI。

/// 连接串 host 不是合法 DNS 名（如含下划线）时回退到服务端证书 SAN，
/// 保证这类内网主机名仍能完成握手（身份仍由 pin 判定）。
const FALLBACK_SNI: &str = "tigerAgent.local";

/// 服务端目标（`docs/tcp-tls-ecdsa.md` §11.3）。
#[derive(Clone)]
pub struct TcpTarget {
    pub host: String,
    pub port: u16,
    /// 服务端 SPKI 指纹 `sha256:<base64url-nopad>`
    pub pin: String,
    /// 服务端令牌，随每个请求放进 `Authorization: Bearer ...`
    pub token: String,
}

// 手写 Debug：TcpTarget 会出现在错误上下文里，token 绝不能进日志。
impl std::fmt::Debug for TcpTarget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TcpTarget")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("pin", &self.pin)
            .field("token", &"<redacted>")
            .finish()
    }
}

impl TcpTarget {
    pub fn display(&self) -> String {
        format!("tcp://{}", self.authority())
    }

    /// HTTP `Host` 头（IPv6 加方括号，443 省略端口）。
    ///
    /// 域名反向代理按 Host 做虚拟主机路由时必须与连接串一致；直连时服务端
    /// 不校验 Host，保持真实值也便于服务端日志排查。
    pub fn authority(&self) -> String {
        let host = if self.host.contains(':') {
            format!("[{}]", self.host)
        } else {
            self.host.clone()
        };
        if self.port == 443 {
            host
        } else {
            format!("{}:{}", host, self.port)
        }
    }
}

/// 校验器：只做 SPKI pin 比对，签名验证仍走 rustls 默认实现。
#[derive(Debug)]
struct SpkiPinVerifier {
    expected: String,
}

impl ServerCertVerifier for SpkiPinVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let got = spki_fingerprint(end_entity.as_ref())
            .map_err(|e| rustls::Error::General(format!("parse server certificate: {}", e)))?;
        if got != self.expected {
            // Hard failure: never fall back to plaintext or auto-accept a new key.
            return Err(rustls::Error::General(format!(
                "server fingerprint mismatch: got {} want {}",
                got, self.expected
            )));
        }
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// TLS 客户端流（服务端证书已按 pin 校验；客户端以 Bearer token 认证，不出示客户端证书）。
pub struct AgentStream(Box<tokio_rustls::client::TlsStream<tokio::net::TcpStream>>);

impl tokio::io::AsyncRead for AgentStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let s = self.get_mut();
        Pin::new(&mut *s.0).poll_read(cx, buf)
    }
}

impl tokio::io::AsyncWrite for AgentStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let s = self.get_mut();
        Pin::new(&mut *s.0).poll_write(cx, buf)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let s = self.get_mut();
        Pin::new(&mut *s.0).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let s = self.get_mut();
        Pin::new(&mut *s.0).poll_shutdown(cx)
    }
}

/// hyper-util 连接元数据：无额外信息，返回空 Connected。
impl hyper_util::client::legacy::connect::Connection for AgentStream {
    fn connected(&self) -> hyper_util::client::legacy::connect::Connected {
        hyper_util::client::legacy::connect::Connected::new()
    }
}

/// hyper 连接器：忽略请求 URI 的 authority，只按 target 建立 TLS 连接。
/// 连接过程受 connect_timeout 约束（服务端不可达时快速失败）。
#[derive(Clone)]
pub struct AgentConnector {
    pub target: TcpTarget,
    pub connect_timeout: Duration,
}

impl AgentConnector {
    async fn connect(self) -> io::Result<AgentStream> {
        let t = self.target;
        let sni = ServerName::try_from(t.host.clone())
            .or_else(|_| ServerName::try_from(FALLBACK_SNI.to_string()))
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, format!("invalid SNI: {}", e)))?;
        // 已确认该目标由反向代理终止 TLS：后续连接直接走公共根证书，省掉一次
        // 必然失败的 pin 握手（终端输入/SSE 重连对建链延迟敏感）。
        if proxy_tls_active() {
            let stream = tls_connect(&t, sni, proxy_tls_client_config()?).await?;
            return Ok(AgentStream(Box::new(stream)));
        }
        let pin_cfg = tls_client_config(&t)?;
        match tls_connect(&t, sni.clone(), pin_cfg).await {
            Ok(stream) => Ok(AgentStream(Box::new(stream))),
            Err(err) if is_pin_mismatch(&err) => {
                // 域名反向代理 / 隧道预览域名终止 TLS 时，客户端看到的是代理证书，
                // pin 永远对不上。此时退回标准 HTTPS 信任模型：公共根证书 + 主机名
                // 校验，再由 token 认证。只有代理证书确实被公共根证书信任才会成功，
                // 直连自签服务端时错误 pin 仍然硬失败。
                let proxy_cfg = proxy_tls_client_config()?;
                match tls_connect(&t, sni, proxy_cfg).await {
                    Ok(stream) => {
                        PROXY_TLS.store(true, Ordering::Relaxed);
                        eprintln!(
                            "[server] {} 的 TLS 由反向代理终止：改用公共根证书校验（pin 只用于直连场景）",
                            t.display()
                        );
                        Ok(AgentStream(Box::new(stream)))
                    }
                    Err(proxy_err) => Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        format!(
                            "{}；反向代理证书校验失败: {}（直连请核对连接串指纹；经反向代理时代理证书必须由公共根证书签发且域名匹配）",
                            err, proxy_err
                        ),
                    )),
                }
            }
            Err(err) => Err(err),
        }
    }
}

/// 建一条 TCP + TLS 连接。pin 校验失败时由调用方决定是否按反向代理重试；
/// 每次调用都新建 TCP 连接（失败的 TLS 流不能复用）。
async fn tls_connect(
    target: &TcpTarget,
    sni: ServerName<'static>,
    cfg: Arc<ClientConfig>,
) -> io::Result<tokio_rustls::client::TlsStream<tokio::net::TcpStream>> {
    let tcp = tokio::net::TcpStream::connect((target.host.as_str(), target.port)).await?;
    tcp.set_nodelay(true)?;
    TlsConnector::from(cfg)
        .connect(sni, tcp)
        .await
        .map_err(|e| io::Error::new(io::ErrorKind::PermissionDenied, format!("TLS 握手失败: {}", e)))
}

fn is_pin_mismatch(err: &io::Error) -> bool {
    err.to_string().contains("server fingerprint mismatch")
}

/// 构建 TLS 客户端配置：
/// - 只允许 TLS 1.3（与服务端一致）
/// - 服务端证书校验完全由 SPKI pin 完成（自签证书不进系统信任库）
/// - 不出示客户端证书：客户端身份由 Bearer token 证明
fn tls_client_config(target: &TcpTarget) -> Result<Arc<ClientConfig>, io::Error> {
    let verifier = Arc::new(SpkiPinVerifier { expected: target.pin.clone() });
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let cfg = ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, format!("TLS 配置失败: {}", e)))?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    Ok(Arc::new(cfg))
}

/// 反向代理终止 TLS 时的客户端配置：公共根证书 + 主机名校验（标准 HTTPS 信任模型）。
///
/// 端到端 pin 要求服务端自己出示证书；域名反代由代理出示公共证书，pin 在该拓扑下
/// 不可能命中，因此只在 pin 校验失败后作为回退使用，身份最终由 Bearer token 证明。
fn proxy_tls_client_config() -> Result<Arc<ClientConfig>, io::Error> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    let cfg = ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, format!("TLS 配置失败: {}", e)))?
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(Arc::new(cfg))
}

/// 当前生效的服务端目标。用 RwLock 而不是 OnceLock：设置页保存新配置后可以立即
/// 重新解析并覆盖，不必等应用重启（旧目标已建立的连接池由 hyper 自身回收）。
static ACTIVE_TARGET: std::sync::RwLock<Option<TcpTarget>> = std::sync::RwLock::new(None);

/// 最近一次成功建链是否走了「反向代理终止 TLS」的回退（设置页/日志提示用）。
static PROXY_TLS: AtomicBool = AtomicBool::new(false);

/// 是否经反向代理（公共根证书）建链：pin 在该拓扑下不参与校验。
pub fn proxy_tls_active() -> bool {
    PROXY_TLS.load(Ordering::Relaxed)
}

/// 设置本进程使用的服务端目标（启动/保存配置时按配置解析）。
/// 目标可能换了地址/指纹/token，旧的连接池不再可用，直接丢弃。
pub fn set_active_target(target: TcpTarget) {
    if let Ok(mut guard) = ACTIVE_TARGET.write() {
        *guard = Some(target);
    }
    PROXY_TLS.store(false, Ordering::Relaxed);
    reset_shared_client();
}

/// 当前生效的服务端目标；未配置（或配置不完整）时为 None。
pub fn active_target() -> Option<TcpTarget> {
    ACTIVE_TARGET.read().ok().and_then(|guard| guard.clone())
}

impl tower_service::Service<Uri> for AgentConnector {
    type Response = TokioIo<AgentStream>;
    type Error = io::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, _req: Uri) -> Self::Future {
        let this = self.clone();
        let timeout = self.connect_timeout;
        Box::pin(async move {
            let fut = this.connect();
            match tokio::time::timeout(timeout, fut).await {
                Ok(r) => r.map(TokioIo::new),
                Err(_) => Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "连接 Agent server 超时",
                )),
            }
        })
    }
}

/// `sha256:<base64url_nopad>` over the certificate's SubjectPublicKeyInfo.
///
/// 必须与服务端 `server.SPKIFingerprint` 相同：用 SPKI 而不是整张证书，
/// 这样“换证不换钥”时指纹不变，客户端不需要重新配置。
pub fn spki_fingerprint(cert_der: &[u8]) -> Result<String, String> {
    let (_, cert) = x509_parser::parse_x509_certificate(cert_der)
        .map_err(|e| format!("解析证书失败: {}", e))?;
    let spki = cert.tbs_certificate.subject_pki.raw;
    let digest = Sha256::digest(spki);
    Ok(format!(
        "sha256:{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
    ))
}

/// 请求体统一装箱类型：普通请求用 `Full`，文件上传用按块读盘的流式 body。
/// 流式 body（文件流）不满足 `Sync`，因此用 unsync 版本。
type AgentRequestBody = UnsyncBoxBody<Bytes, Box<dyn std::error::Error + Send + Sync>>;

/// Agent server 的 HTTP 客户端（连接池按 target 复用）。
///
/// 包一层是为了在每个请求上统一附加 `Authorization: Bearer <token>`，
/// 这样 `send` / `stream_get` 之外不会出现漏带凭据的调用路径。
#[derive(Clone)]
pub struct AgentHttpClient {
    inner: Client<AgentConnector, AgentRequestBody>,
    token: String,
    /// 真实主机的 `Host` 头：URI 里用的是内部占位 authority，反向代理按域名
    /// 路由时不能把占位值发出去。
    authority: String,
}

impl AgentHttpClient {
    pub async fn request<B>(
        &self,
        mut req: hyper::Request<B>,
    ) -> Result<hyper::Response<Incoming>, hyper_util::client::legacy::Error>
    where
        B: hyper::body::Body<Data = Bytes> + Send + 'static,
        B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
    {
        if !self.token.is_empty() {
            if let Ok(value) = hyper::http::HeaderValue::from_str(&format!("Bearer {}", self.token)) {
                req.headers_mut().insert(hyper::header::AUTHORIZATION, value);
            }
        }
        if let Ok(value) = hyper::http::HeaderValue::from_str(&self.authority) {
            req.headers_mut().insert(hyper::header::HOST, value);
        }
        use http_body_util::BodyExt;
        self.inner.request(req.map(|body| body.map_err(Into::into).boxed_unsync())).await
    }
}

/// 构建连接超时受限的 HTTP 客户端。
/// 注意：这里的超时只约束建连；请求总体超时由调用方用 tokio::time::timeout 包一层
/// （SSE 长连接绝不能设总超时，见 agent.rs forward_sse_events 注释）。
pub fn build_client(
    target: &TcpTarget,
    connect_timeout: Duration,
) -> Result<AgentHttpClient, String> {
    let connector = AgentConnector {
        target: target.clone(),
        connect_timeout,
    };
    Ok(AgentHttpClient {
        inner: Client::builder(TokioExecutor::new()).build(connector),
        token: target.token.clone(),
        authority: target.authority(),
    })
}

/// 进程级共享客户端：按 target 身份缓存，复用 hyper 的连接池。
///
/// 终端输入/轮询都是高频小请求；如果每次请求都 [`build_client`]，就会为每个
/// 请求重新做 TCP + TLS 1.3 握手（还要重建 rustls ClientConfig），打字回显会被
/// 每次握手的 1–2 个 RTT 拉长。缓存后同一 target 复用 keep-alive 连接。
/// target 变化（地址/指纹/token）时下一次请求自动重建。
static SHARED_CLIENT: std::sync::RwLock<Option<(String, AgentHttpClient)>> =
    std::sync::RwLock::new(None);

fn client_key(target: &TcpTarget) -> String {
    format!(
        "{}|{}|{}|{}",
        target.host, target.port, target.pin, target.token
    )
}

/// 返回当前 target 的共享客户端（连接池复用）。
pub fn shared_client(
    target: &TcpTarget,
    connect_timeout: Duration,
) -> Result<AgentHttpClient, String> {
    let key = client_key(target);
    if let Ok(guard) = SHARED_CLIENT.read() {
        if let Some((cached, client)) = guard.as_ref() {
            if cached == &key {
                return Ok(client.clone());
            }
        }
    }
    let client = build_client(target, connect_timeout)?;
    if let Ok(mut guard) = SHARED_CLIENT.write() {
        *guard = Some((key, client.clone()));
    }
    Ok(client)
}

/// 丢弃共享客户端（例如断开连接/切换 target 时主动释放空闲连接）。
pub fn reset_shared_client() {
    if let Ok(mut guard) = SHARED_CLIENT.write() {
        *guard = None;
    }
}

/// 生成请求 URI：authority 固定为 "agent"（连接器忽略主机，只用 path）
pub fn uri_for(path: &str) -> Result<Uri, String> {
    Uri::builder()
        .scheme("http")
        .authority("agent")
        .path_and_query(path)
        .build()
        .map_err(|e| format!("无效的请求路径 {}: {}", path, e))
}

/// 把错误连同底层原因拼成一条可读消息。
///
/// hyper-util 只把传输失败归类成 `client error (Connect)` / `client error (SendRequest)`，
/// 真正原因（DNS 解析失败、连接被拒、TLS 握手 / 指纹不匹配、建连超时）都藏在
/// `source()` 链里。只打印第一层时，界面和日志里只剩一个无法排查的分类名，
/// 因此逐层拼接底层原因。
pub fn describe_error(err: &(dyn std::error::Error + 'static)) -> String {
    let mut out = err.to_string();
    let mut source = err.source();
    while let Some(cause) = source {
        let text = cause.to_string();
        if !text.is_empty() && !out.contains(&text) {
            out.push_str(": ");
            out.push_str(&text);
        }
        source = cause.source();
    }
    out
}

/// 发送一次请求并读完整响应体，返回 (HTTP 状态码, 响应体字节)。
/// 调用方负责整体超时与状态码语义（202/204/200/4xx…）。
pub async fn send(
    client: &AgentHttpClient,
    method: &str,
    path: &str,
    body: Option<serde_json::Value>,
) -> Result<(u16, Vec<u8>), String> {
    use http_body_util::BodyExt;
    use http_body_util::Full;
    use hyper::body::Bytes;

    let uri = uri_for(path)?;
    let mut builder = hyper::Request::builder().method(method).uri(uri);
    if body.is_some() {
        builder = builder.header("content-type", "application/json");
    }
    let payload = body.map(|b| b.to_string().into_bytes()).unwrap_or_default();
    let req = builder
        .body(Full::new(Bytes::from(payload)))
        .map_err(|e| format!("构建请求失败: {}", e))?;
    let resp = client
        .request(req)
        .await
        .map_err(|e| format!("HTTP 请求失败: {}", describe_error(&e)))?;
    let status = resp.status().as_u16();
    let collected = resp
        .into_body()
        .collect()
        .await
        .map_err(|e| format!("读取响应失败: {}", describe_error(&e)))?;
    Ok((status, collected.to_bytes().to_vec()))
}

/// 把本地文件包成按块读取的请求体：任意时刻只有当前 64 KiB 块在内存里。
/// 每读出一块就把累计字节数交给 `on_progress`（上传进度用）。
fn file_body<F>(file: tokio::fs::File, len: u64, on_progress: F) -> impl hyper::body::Body<Data = Bytes, Error = io::Error>
where
    F: FnMut(u64) + Send + 'static,
{
    use futures_util::TryStreamExt;

    struct BodyState<F> {
        reader: tokio::io::Take<tokio::fs::File>,
        on_progress: F,
        sent: u64,
    }

    let state = BodyState {
        reader: tokio::io::AsyncReadExt::take(file, len),
        on_progress,
        sent: 0,
    };
    let stream = futures_util::stream::unfold(state, |mut state| async move {
        let mut buf = vec![0u8; 64 * 1024];
        match tokio::io::AsyncReadExt::read(&mut state.reader, &mut buf).await {
            Ok(0) => None,
            Ok(n) => {
                buf.truncate(n);
                state.sent += n as u64;
                (state.on_progress)(state.sent);
                Some((Ok(Bytes::from(buf)), state))
            }
            Err(err) => Some((Err(err), state)),
        }
    });
    http_body_util::StreamBody::new(stream.map_ok(hyper::body::Frame::data))
}

/// 流式发送一个本地文件（`application/octet-stream` 原始体）并读完整响应体。
/// 请求体按块读盘，不把整文件读进内存；`len` 必须取自同一个文件快照（调用方
/// 先用 metadata 取大小），`on_progress` 按累计已发送字节回调（首帧为 0）。
pub async fn send_file(
    client: &AgentHttpClient,
    method: &str,
    path: &str,
    content_type: &str,
    file: tokio::fs::File,
    len: u64,
    mut on_progress: impl FnMut(u64) + Send + 'static,
) -> Result<(u16, Vec<u8>), String> {
    use http_body_util::BodyExt;

    on_progress(0);
    let uri = uri_for(path)?;
    let req = hyper::Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", content_type)
        .header(hyper::header::CONTENT_LENGTH, len.to_string())
        .body(file_body(file, len, on_progress))
        .map_err(|e| format!("构建请求失败: {}", e))?;
    let resp = client
        .request(req)
        .await
        .map_err(|e| format!("HTTP 请求失败: {}", describe_error(&e)))?;
    let status = resp.status().as_u16();
    let collected = resp
        .into_body()
        .collect()
        .await
        .map_err(|e| format!("读取响应失败: {}", describe_error(&e)))?;
    Ok((status, collected.to_bytes().to_vec()))
}

/// GET 请求并返回响应体流（SSE 长连接用）。连接超时由客户端 builder 控制，
/// 流本身不设总超时。
pub async fn stream_get(
    client: &AgentHttpClient,
    path: &str,
) -> Result<(u16, Incoming), String> {
    use http_body_util::Full;
    use hyper::body::Bytes;

    let uri = uri_for(path)?;
    let req = hyper::Request::builder()
        .method("GET")
        .uri(uri)
        .body(Full::new(Bytes::new()))
        .map_err(|e| format!("构建请求失败: {}", e))?;
    let resp = client
        .request(req)
        .await
        .map_err(|e| format!("HTTP 请求失败: {}", describe_error(&e)))?;
    Ok((resp.status().as_u16(), resp.into_body()))
}

/// 同 [`stream_get`]，但保留响应头（下载进度需要 Content-Length）。
pub async fn stream_get_with_headers(
    client: &AgentHttpClient,
    path: &str,
) -> Result<(u16, hyper::HeaderMap, Incoming), String> {
    use http_body_util::Full;
    use hyper::body::Bytes;

    let uri = uri_for(path)?;
    let req = hyper::Request::builder()
        .method("GET")
        .uri(uri)
        .body(Full::new(Bytes::new()))
        .map_err(|e| format!("构建请求失败: {}", e))?;
    let resp = client
        .request(req)
        .await
        .map_err(|e| format!("HTTP 请求失败: {}", describe_error(&e)))?;
    let status = resp.status().as_u16();
    let headers = resp.headers().clone();
    Ok((status, headers, resp.into_body()))
}

/// GET /v1/health 探活：能连上且返回 2xx 视为 server 就绪。
/// 失败时返回具体原因（DNS / 连接拒绝 / TLS 握手 / 指纹 / HTTP 状态），
/// 调用方直接展示，避免所有失败都变成「无法连接」。
pub async fn health_check(client: &AgentHttpClient) -> Result<(), String> {
    match tokio::time::timeout(
        Duration::from_secs(3),
        send(client, "GET", "/v1/health", None),
    )
    .await
    {
        Ok(Ok((status, _))) if (200..300).contains(&status) => Ok(()),
        Ok(Ok((status, _))) => Err(format!("GET /v1/health 返回 HTTP {}", status)),
        Ok(Err(e)) => Err(e),
        Err(_) => Err("GET /v1/health 超时（3s）".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(host: &str, port: u16) -> TcpTarget {
        TcpTarget {
            host: host.to_string(),
            port,
            pin: "sha256:x".to_string(),
            token: "tk".to_string(),
        }
    }

    #[test]
    fn authority_matches_connection_string() {
        assert_eq!(target("example.com", 443).authority(), "example.com");
        assert_eq!(target("example.com", 8000).authority(), "example.com:8000");
        assert_eq!(target("::1", 443).authority(), "[::1]");
        assert_eq!(target("::1", 8000).authority(), "[::1]:8000");
    }

    #[test]
    fn describe_error_walks_sources() {
        #[derive(Debug)]
        struct Cause;
        impl std::fmt::Display for Cause {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "由于目标计算机积极拒绝，无法连接。")
            }
        }
        impl std::error::Error for Cause {}

        #[derive(Debug)]
        struct Wrapper(Cause);
        impl std::fmt::Display for Wrapper {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "client error (Connect)")
            }
        }
        impl std::error::Error for Wrapper {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                Some(&self.0)
            }
        }

        assert_eq!(
            describe_error(&Wrapper(Cause)),
            "client error (Connect): 由于目标计算机积极拒绝，无法连接。"
        );
    }

    #[test]
    fn detects_pin_mismatch_only() {
        let pin = io::Error::new(
            io::ErrorKind::PermissionDenied,
            "TLS 握手失败: invalid peer certificate: server fingerprint mismatch: got a want b",
        );
        assert!(is_pin_mismatch(&pin));
        let refused = io::Error::new(io::ErrorKind::ConnectionRefused, "connection refused");
        assert!(!is_pin_mismatch(&refused));
    }
}
