//! Agent 服务端传输：TCP + TLS 1.3（服务端 SPKI pin）+ Bearer token。
//!
//! 桌面端不再有「本地 sidecar」模式：服务端由用户自行启动，桌面端只做客户端，
//! 设置页只需粘贴一条连接串（地址 + 服务端指纹 + token，见
//! `docs/tcp-tls-ecdsa.md` §11）。reqwest 无法固定自签证书的 pin，因此这里用
//! hyper 直接对 TLS 流发起 HTTP/1.1 请求（含 SSE 长连接流）。

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use hyper::body::{Bytes, Incoming};
use hyper::Uri;
use http_body_util::Full;
use hyper_util::client::legacy::Client;
use hyper_util::rt::{TokioExecutor, TokioIo};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use tokio_rustls::TlsConnector;

use base64::Engine;
use sha2::{Digest, Sha256};

/// 客户端 TLS 握手中发送的 SNI。
///
/// 固定值，与服务端自签证书的 SAN 一致（`docs/tcp-tls-ecdsa.md` §11）。
/// 服务端身份由 pin 校验收口，SNI 不参与判定，因此不做成设置项。
pub const SERVER_SNI: &str = "tigerAgent.local";

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
        format!("tcp://{}:{}", self.host, self.port)
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
        let tcp = tokio::net::TcpStream::connect((t.host.as_str(), t.port)).await?;
        tcp.set_nodelay(true)?;
        let cfg = tls_client_config(&t)?;
        let sni = ServerName::try_from(SERVER_SNI)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, format!("invalid SNI: {}", e)))?;
        let stream = TlsConnector::from(cfg)
            .connect(sni, tcp)
            .await
            .map_err(|e| io::Error::new(io::ErrorKind::PermissionDenied, format!("TLS 握手失败: {}", e)))?;
        Ok(AgentStream(Box::new(stream)))
    }
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

/// 当前生效的服务端目标。用 RwLock 而不是 OnceLock：设置页保存新配置后可以立即
/// 重新解析并覆盖，不必等应用重启（旧目标已建立的连接池由 hyper 自身回收）。
static ACTIVE_TARGET: std::sync::RwLock<Option<TcpTarget>> = std::sync::RwLock::new(None);

/// 设置本进程使用的服务端目标（启动/保存配置时按配置解析）。
pub fn set_active_target(target: TcpTarget) {
    if let Ok(mut guard) = ACTIVE_TARGET.write() {
        *guard = Some(target);
    }
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

/// Agent server 的 HTTP 客户端（连接池按 target 复用）。
///
/// 包一层是为了在每个请求上统一附加 `Authorization: Bearer <token>`，
/// 这样 `send` / `stream_get` 之外不会出现漏带凭据的调用路径。
#[derive(Clone)]
pub struct AgentHttpClient {
    inner: Client<AgentConnector, Full<Bytes>>,
    token: String,
}

impl AgentHttpClient {
    pub async fn request(
        &self,
        mut req: hyper::Request<Full<Bytes>>,
    ) -> Result<hyper::Response<Incoming>, hyper_util::client::legacy::Error> {
        if !self.token.is_empty() {
            if let Ok(value) = hyper::http::HeaderValue::from_str(&format!("Bearer {}", self.token)) {
                req.headers_mut().insert(hyper::header::AUTHORIZATION, value);
            }
        }
        self.inner.request(req).await
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
    })
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
        .map_err(|e| format!("HTTP 请求失败: {}", e))?;
    let status = resp.status().as_u16();
    let collected = resp
        .into_body()
        .collect()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;
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
        .map_err(|e| format!("HTTP 请求失败: {}", e))?;
    Ok((resp.status().as_u16(), resp.into_body()))
}

/// GET /v1/health 探活：能连上且返回 2xx 视为 server 就绪。
pub async fn health_check(client: &AgentHttpClient) -> bool {
    match tokio::time::timeout(
        Duration::from_secs(3),
        send(client, "GET", "/v1/health", None),
    )
    .await
    {
        Ok(Ok((status, _))) => (200..300).contains(&status),
        _ => false,
    }
}
