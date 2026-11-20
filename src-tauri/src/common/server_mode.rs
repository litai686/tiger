//! 服务端连接配置解析（`docs/tcp-tls-ecdsa.md` §11）。
//!
//! 桌面端只有一种连接方式：用户自行启动的远程服务端，TCP + TLS 1.3。设置页只
//! 保存**一条连接串**，服务端启动时打印、客户端整条粘贴：
//!
//! ```text
//! tigerAgent://[host][:port]?fp=sha256:…&token=…
//! ```
//!
//! `fp` 固定服务端身份（自签证书不在系统信任库，只能靠 pin 防中间人），
//! `token` 是服务端签发的 Bearer 凭据；客户端不再生成任何设备身份。
//!
//! 解析在启动时做一次（`apply`），之后所有请求点改读
//! `agent_http::active_target()`，避免半个界面连一个地址、半个连另一个。

use std::net::IpAddr;
use std::str::FromStr;

use crate::common::agent_http::{self, TcpTarget};
use crate::common::config;
use crate::common::error::AppError;
use crate::common::types::Settings;

const CONNECTION_PREFIX: &str = "tigerAgent://";

/// 连接串省略端口时的默认端口。域名部署（反向代理 / 隧道预览域名，如
/// `tigerAgent://<子域>.preview.example.com?fp=…&token=…`）只给出主机名，
/// 对外统一走 443，由代理转发到服务端实际监听的端口。
pub const DEFAULT_PORT: u16 = 443;

/// 读取 `<app_data>/config.json`（与 `settings::load_settings` 同路径）。
/// 缺失或解析失败时返回默认值，绝不因为配置坏掉而阻断启动。
pub fn load_settings(app: &tauri::AppHandle) -> Settings {
    let Ok(dir) = config::get_data_dir(Some(app)) else {
        return Settings::default();
    };
    let path = dir.join("config.json");
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Settings::default();
    };
    serde_json::from_str::<Settings>(&raw).unwrap_or_default()
}

/// 按配置解析服务端目标。
pub fn resolve(app: &tauri::AppHandle) -> Result<TcpTarget, AppError> {
    let settings = load_settings(app);
    let raw = settings.server.remote.connection.trim();
    if raw.is_empty() {
        return Err(AppError::msg(
            "未配置服务端连接串：请在设置 → 服务端连接中粘贴服务端启动时打印的 tigerAgent://… 连接串",
        ));
    }
    parse_connection(raw)
}

/// 解析连接串：`tigerAgent://[host][:port]?fp=sha256:…&token=…`。
/// 省略端口时用 [`DEFAULT_PORT`]（域名部署由反向代理转发），IPv6 需写成 `[::1]:port`。
/// 值不做百分号编码（host:port、sha256:+base64url、base64url 都是安全字符），
/// 与 Go 侧 `server.ConnectionString` 保持一致。
pub fn parse_connection(raw: &str) -> Result<TcpTarget, AppError> {
    let rest = raw.trim().strip_prefix(CONNECTION_PREFIX).ok_or_else(|| {
        AppError::msg(
            "连接串格式应为 tigerAgent://<host>[:<port>]?fp=sha256:…&token=…（在服务端启动日志或 `tigerAgent --print-connection` 中获取）",
        )
    })?;
    let (authority, query) = rest.split_once('?').ok_or_else(|| {
        AppError::msg("连接串缺少 ?fp=…&token=… 部分（请复制服务端打印的完整连接串）")
    })?;
    let (host, port) = split_addr(authority).ok_or_else(|| {
        AppError::msg(format!(
            "连接串地址无效: {}（应为 host 或 host:port，省略端口时默认 {}）",
            authority, DEFAULT_PORT
        ))
    })?;

    let mut pin: Option<String> = None;
    let mut token: Option<String> = None;
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (key, value) = pair
            .split_once('=')
            .ok_or_else(|| AppError::msg(format!("连接串参数格式无效: {}", pair)))?;
        match key {
            "fp" => pin = Some(value.trim().to_string()),
            "token" => token = Some(value.trim().to_string()),
            _ => {}
        }
    }

    let pin = pin
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::msg("连接串缺少 fp=（服务端指纹）"))?;
    if !pin.starts_with("sha256:") {
        return Err(AppError::msg("连接串里的 fp 应以 sha256: 开头"));
    }
    let token = token
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::msg("连接串缺少 token=（服务端令牌）"))?;

    Ok(TcpTarget { host, port, pin, token })
}

/// 解析并把结果写进全局目标；返回目标供调用方建链。
pub fn apply(app: &tauri::AppHandle) -> Result<TcpTarget, AppError> {
    let target = resolve(app)?;
    agent_http::set_active_target(target.clone());
    Ok(target)
}

/// `host` / `host:port` / `[::1]` / `[::1]:port` → (host, port)。
/// 省略端口时用 [`DEFAULT_PORT`]。
fn split_addr(addr: &str) -> Option<(String, u16)> {
    if let Some(rest) = addr.strip_prefix('[') {
        let (host, tail) = rest.split_once(']')?;
        if host.is_empty() {
            return None;
        }
        if tail.is_empty() {
            return Some((host.to_string(), DEFAULT_PORT));
        }
        let port = tail.strip_prefix(':')?.parse().ok()?;
        return Some((host.to_string(), port));
    }
    let (host, port) = match addr.rsplit_once(':') {
        Some((host, port)) => (host, port.parse().ok()?),
        None => (addr, DEFAULT_PORT),
    };
    if host.is_empty() || !is_plain_host(host) {
        return None;
    }
    Some((host.to_string(), port))
}

/// 非方括号形式的主机名：不能含空白、路径、认证信息或裸 `:`（IPv6 必须加方括号）。
fn is_plain_host(host: &str) -> bool {
    !host
        .chars()
        .any(|c| c.is_whitespace() || matches!(c, '/' | '\\' | '@' | '#' | '?' | ':'))
}

/// 地址是否是环回地址：仅用于提示（`127.0.0.1` 也是合法 TCP 目标）。
pub fn is_loopback(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    IpAddr::from_str(host).map(|ip| ip.is_loopback()).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_host_port() {
        assert_eq!(split_addr("192.168.1.20:18471"), Some(("192.168.1.20".into(), 18471)));
        assert_eq!(split_addr("[::1]:18471"), Some(("::1".into(), 18471)));
        assert_eq!(split_addr("[::1]"), Some(("::1".into(), DEFAULT_PORT)));
        assert_eq!(split_addr("nope"), Some(("nope".into(), DEFAULT_PORT)));
        assert_eq!(split_addr(":18471"), None);
        assert_eq!(split_addr("::1"), None);
    }

    #[test]
    fn parses_domain_without_port() {
        let target = parse_connection(
            "tigerAgent://8000-01m779avzhpa3yjqcy7pfm76jh.preview.renrencodex.com?fp=sha256:abcDEF_123&token=tok_en-1",
        )
        .expect("parse");
        assert_eq!(target.host, "8000-01m779avzhpa3yjqcy7pfm76jh.preview.renrencodex.com");
        assert_eq!(target.port, DEFAULT_PORT);
        assert_eq!(target.pin, "sha256:abcDEF_123");
        assert_eq!(target.token, "tok_en-1");
    }

    #[test]
    fn rejects_invalid_hosts() {
        assert_eq!(split_addr("example.com/path"), None);
        assert_eq!(split_addr("user@example.com"), None);
        assert_eq!(split_addr("example .com"), None);
        assert!(parse_connection("tigerAgent://example.com/?fp=sha256:a&token=b").is_err());
    }

    #[test]
    fn parses_connection_string() {
        let target = parse_connection(
            "tigerAgent://192.168.1.20:18471?fp=sha256:abcDEF_123&token=tok_en-1",
        )
        .expect("parse");
        assert_eq!(target.host, "192.168.1.20");
        assert_eq!(target.port, 18471);
        assert_eq!(target.pin, "sha256:abcDEF_123");
        assert_eq!(target.token, "tok_en-1");
    }

    #[test]
    fn rejects_incomplete_connection_strings() {
        assert!(parse_connection("192.168.1.20:18471?fp=sha256:a&token=b").is_err());
        assert!(parse_connection("tigerAgent://192.168.1.20:18471").is_err());
        assert!(parse_connection("tigerAgent://192.168.1.20:18471?fp=sha256:a").is_err());
        assert!(parse_connection("tigerAgent://192.168.1.20:18471?fp=nope&token=b").is_err());
        assert!(parse_connection("tigerAgent://192.168.1.20:18471?fp=sha256:a&token=").is_err());
    }

    #[test]
    fn detects_loopback() {
        assert!(is_loopback("localhost"));
        assert!(is_loopback("127.0.0.1"));
        assert!(is_loopback("::1"));
        assert!(!is_loopback("192.168.1.20"));
        assert!(!is_loopback("example.com"));
    }
}
