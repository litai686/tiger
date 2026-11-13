//! 服务端连接模式解析（`docs/tcp-tls-ed25519.md` §11.2）。
//!
//! 两种模式：
//! - `local`：服务端与桌面端同机，走 unix socket / named pipe，不做 TLS；
//! - `remote`：服务端在另一台机器上，走 TCP + TLS 1.3 + Ed25519 双向认证，
//!   工作目录/会话/配置全部留在服务端，桌面端只是操作界面。
//!
//! 解析在启动时做一次（`set_active_transport`），之后所有 `default_host()`
//! 调用点改读 `agent_http::active_transport()`，避免半个界面连远端、半个连本地。

use std::net::IpAddr;
use std::str::FromStr;
use std::sync::Arc;

use crate::common::agent_http::{self, AgentTransport, TcpTarget};
use crate::common::config;
use crate::common::device_identity;
use crate::common::error::AppError;
use crate::common::types::Settings;

/// 解析后的连接模式。
pub enum ServerMode {
    /// 同机：本地传输，不加密（OS 权限保护）
    Local,
    /// 异机：TCP + TLS 1.3 + Ed25519 双向认证
    Remote(TcpTarget),
}

impl ServerMode {
    pub fn is_remote(&self) -> bool {
        matches!(self, ServerMode::Remote(_))
    }
}

/// 读取 `<app_data>/config.json`（与 `settings::load_settings` 同路径）。
/// 缺失或解析失败时返回默认值（= 本地模式），绝不因为配置坏掉而阻断启动。
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

/// 按配置解析模式。远程模式要求：完整地址 + 已保存的 pin + 已生成的设备身份。
pub fn resolve(app: &tauri::AppHandle) -> Result<ServerMode, AppError> {
    let settings = load_settings(app);
    if !settings.server.mode.eq_ignore_ascii_case("remote") {
        return Ok(ServerMode::Local);
    }

    let remote = &settings.server.remote;
    let addr = remote.addr.trim();
    if addr.is_empty() {
        return Err(AppError::msg("远程模式缺少服务端地址，请在设置中填写 host:port"));
    }
    let (host, port) = split_addr(addr)
        .ok_or_else(|| AppError::msg(format!("无效的服务端地址: {}（应为 host:port）", addr)))?;

    // 环回地址 = 同机部署：不值得为本机再套一层 TCP + 证书，直接按本地模式走。
    if is_loopback(&host) {
        eprintln!("[server_mode] 远程地址是环回地址 {}，按本地模式使用 sidecar 传输", addr);
        return Ok(ServerMode::Local);
    }

    let pin = remote.fingerprint.trim();
    if pin.is_empty() {
        return Err(AppError::msg(
            "远程模式缺少服务端指纹（sha256:…）。请从服务端启动日志、`tigerAgent --print-fingerprint` 或 `pair --qr` 获取",
        ));
    }

    let device = device_identity::load(&device_identity::device_dir(app)?)?;
    let sni = if remote.sni.trim().is_empty() {
        "tigerAgent.local".to_string()
    } else {
        remote.sni.trim().to_string()
    };

    Ok(ServerMode::Remote(TcpTarget {
        host,
        port,
        sni,
        pin: pin.to_string(),
        device: Arc::new(device),
    }))
}

/// 解析并把结果写进全局传输；返回模式供调用方决定是否还拉起 sidecar。
pub fn apply(app: &tauri::AppHandle) -> Result<ServerMode, AppError> {
    let mode = resolve(app)?;
    if let ServerMode::Remote(target) = &mode {
        agent_http::set_active_transport(AgentTransport::Tcp(Box::new(target.clone())));
    }
    Ok(mode)
}

/// `host:port` / `[::1]:port` → (host, port)
fn split_addr(addr: &str) -> Option<(String, u16)> {
    if let Some(rest) = addr.strip_prefix('[') {
        let (host, tail) = rest.split_once(']')?;
        let port = tail.strip_prefix(':')?;
        return Some((host.to_string(), port.parse().ok()?));
    }
    let (host, port) = addr.rsplit_once(':')?;
    if host.is_empty() {
        return None;
    }
    Some((host.to_string(), port.parse().ok()?))
}

fn is_loopback(host: &str) -> bool {
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
        assert_eq!(split_addr("nope"), None);
        assert_eq!(split_addr(":18471"), None);
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
