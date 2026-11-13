// settings.html 对应逻辑（配置管理）

use crate::common::*;
use crate::common::config;
use crate::dbg_log;
use crate::app_state::AppState;
use tauri::Manager;

// ===== Tauri Command =====

#[tauri::command]
pub async fn save_settings(app: tauri::AppHandle, settings: Settings) -> Result<(), AppError> {
    dbg_log!("[DEBUG] save_settings called with: {:?}", settings);
    // 持有 config 写锁：防止与 agent.rs / ilink.rs 的 read-modify-write 并发互相覆盖
    let state = app.state::<AppState>();
    let _lock = state.config_write_lock.lock().map_err(|e| e.to_string())?;
    let data_dir = config::get_data_dir(Some(&app))?;
    let config_path = data_dir.join("config.json");

    let json = serde_json::to_string_pretty(&settings).map_err(|e| AppError::msg(format!("序列化配置失败: {}", e)))?;
    dbg_log!("[DEBUG] Writing config.json to: {:?}", config_path);
    dbg_log!("[DEBUG] config.json content: {}", json);
    
    // 直接写入目标文件，避免 macOS 上 rename 操作可能因文件系统属性/权限/沙盒问题失败
    std::fs::write(&config_path, &json).map_err(|e| AppError::msg(format!("写入配置文件失败: {}", e)))?;
    
    // 确保数据刷盘
    if let Ok(file) = std::fs::File::open(&config_path) {
        let _ = file.sync_all();
    }

    // 同步「多模态模型」到 admAgent.json 顶层 agent_vision_model（vision 子命令读取），
    // 值变化时触发服务端重载；失败静默（vision 缺省回退内置 adm-models）
    crate::pages::agent::sync_agent_vision_model(&app, &settings.agent_vision_model);

    // 同步「代理配置」到 admAgent.json 顶层 agent_proxy，失败静默
    crate::pages::agent::sync_agent_proxy(&app, &settings.agent_proxy);

    // 同步「开启所有工具调用」到 admAgent.json 的 options.bash_allow_all，失败静默
    crate::pages::agent::sync_agent_allow_all_tools(&app, settings.agent_allow_all_tools);

    // 同步「压缩时自动提取记忆规则」到 admAgent.json 的 options.project_memory_sync，失败静默。
    // 字段为 None（旧配置没写过 / Settings::default() 首次落盘）时按开启处理，
    // 只有用户显式关过（Some(false)）才写 false。
    crate::pages::agent::sync_agent_project_memory(
        &app,
        settings.agent_project_memory_sync.unwrap_or(true),
    );

    dbg_log!("[DEBUG] Config saved successfully to: {:?}", config_path);
    Ok(())
}

#[tauri::command]
pub async fn load_settings(app: tauri::AppHandle) -> Result<Settings, AppError> {
    let data_dir = config::get_data_dir(Some(&app))?;
    let config_path = data_dir.join("config.json");

    dbg_log!("[DEBUG] load_settings: reading from {:?}", config_path);
    if !config_path.exists() {
        dbg_log!("[DEBUG] load_settings: config.json not found, returning defaults");
        return Ok(Settings::default());
    }

    let json = std::fs::read_to_string(&config_path).map_err(|e| AppError::msg(format!("读取配置文件失败: {}", e)))?;
    dbg_log!("[DEBUG] load_settings raw json: {}", json);
    let settings: Settings = serde_json::from_str(&json).map_err(|e| AppError::msg(format!("解析配置文件失败: {}", e)))?;
    dbg_log!("[DEBUG] load_settings parsed: {:?}", settings);

    Ok(settings)
}

#[tauri::command]
pub async fn get_app_version(app: tauri::AppHandle) -> Result<String, AppError> {
    let version = app.config().version.clone().unwrap_or_else(|| "0.0.0".to_string());
    Ok(version)
}

#[tauri::command]
pub async fn get_tauri_version() -> Result<String, AppError> {
    Ok(tauri::VERSION.to_string())
}

// ===== 服务端连接（本地 / 远程，docs/tcp-tls-ed25519.md §11）=====

/// 设置页展示的服务端连接状态。
#[derive(serde::Serialize)]
pub struct ServerConnectionInfo {
    /// "local" 或 "remote"
    pub mode: String,
    pub addr: String,
    pub sni: String,
    pub fingerprint: String,
    /// 本机设备指纹（未生成时为空）
    pub device_fingerprint: String,
    pub device_ready: bool,
    /// 解析失败原因（空 = 配置可解析）
    pub error: String,
}

#[tauri::command]
pub async fn get_server_connection(app: tauri::AppHandle) -> Result<ServerConnectionInfo, AppError> {
    let settings = crate::common::server_mode::load_settings(&app);
    let device = crate::common::device_identity::device_dir(&app)
        .ok()
        .and_then(|dir| crate::common::device_identity::load(&dir).ok());
    let (device_fingerprint, device_ready) = match device {
        Some(d) => (d.fingerprint, true),
        None => (String::new(), false),
    };
    let mut error = String::new();
    let mode = match crate::common::server_mode::resolve(&app) {
        Ok(m) => {
            if m.is_remote() { "remote" } else { "local" }
        }
        Err(e) => {
            error = e.to_string();
            if settings.server.mode.eq_ignore_ascii_case("remote") { "remote" } else { "local" }
        }
    };
    Ok(ServerConnectionInfo {
        mode: mode.to_string(),
        addr: settings.server.remote.addr,
        sni: settings.server.remote.sni,
        fingerprint: settings.server.remote.fingerprint,
        device_fingerprint,
        device_ready,
        error,
    })
}

/// 保存服务端连接设置（只改 `server` 段，其余字段原样保留）。
#[tauri::command]
pub async fn set_server_connection(
    app: tauri::AppHandle,
    mode: String,
    addr: String,
    sni: String,
    fingerprint: String,
) -> Result<(), AppError> {
    let mode = mode.trim().to_ascii_lowercase();
    if mode != "local" && mode != "remote" {
        return Err(AppError::msg("mode 必须是 local 或 remote"));
    }
    if mode == "remote" {
        if addr.trim().is_empty() {
            return Err(AppError::msg("远程模式必须填写服务端地址（host:port）"));
        }
        if !addr.contains(':') {
            return Err(AppError::msg("服务端地址应形如 host:port，例如 192.168.1.20:18471"));
        }
        if fingerprint.trim().is_empty() {
            return Err(AppError::msg(
                "远程模式必须填写服务端指纹（从服务端日志、--print-fingerprint 或 pair --qr 获取）",
            ));
        }
    }

    let state = app.state::<AppState>();
    let _lock = state.config_write_lock.lock().map_err(|e| e.to_string())?;
    let data_dir = config::get_data_dir(Some(&app))?;
    let config_path = data_dir.join("config.json");

    // 读-改-写：保留其它设置字段
    let mut root: serde_json::Value = if config_path.exists() {
        let raw = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("读取配置文件失败: {}", e))?;
        serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    root["server"] = serde_json::json!({
        "mode": mode,
        "remote": {
            "addr": addr.trim(),
            "sni": if sni.trim().is_empty() { "tigerAgent.local" } else { sni.trim() },
            "fingerprint": fingerprint.trim(),
            "paired_at": if mode == "remote" { chrono::Utc::now().to_rfc3339() } else { String::new() },
        }
    });
    let json = serde_json::to_string_pretty(&root)
        .map_err(|e| format!("序列化配置失败: {}", e))?;
    std::fs::write(&config_path, &json)
        .map_err(|e| format!("写入配置文件失败: {}", e))?;
    Ok(())
}

/// 生成（或读取）本机设备身份，返回指纹。
/// 桌面端不打包服务端，因此身份由本机 rcgen 自签，不依赖任何外部二进制。
#[tauri::command]
pub async fn prepare_device_identity(app: tauri::AppHandle) -> Result<String, AppError> {
    let name = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "tigerAgent-client".to_string());
    let dir = crate::common::device_identity::device_dir(&app)?;
    let device = crate::common::device_identity::ensure(&dir, &name)?;
    Ok(device.fingerprint)
}

/// 测试当前配置的连接（本地探活 / 远程 TLS 握手 + /v1/health）。
#[tauri::command]
pub async fn test_server_connection(app: tauri::AppHandle) -> Result<String, AppError> {
    use crate::common::agent_http::{build_client, health_check, AgentTransport};

    let mode = crate::common::server_mode::resolve(&app)?;
    let transport = match &mode {
        crate::common::server_mode::ServerMode::Local => AgentTransport::default_host(),
        crate::common::server_mode::ServerMode::Remote(t) => AgentTransport::Tcp(Box::new(t.clone())),
    };
    let client = build_client(&transport, std::time::Duration::from_secs(5))
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;
    if health_check(&client).await {
        return Ok(format!("连接成功：{}", transport.display()));
    }
    let hint = if mode.is_remote() {
        "远程模式：请确认服务端地址可达、指纹与服务端一致，且本设备已在服务端执行 tigerAgent pair --approve"
    } else {
        "本地模式：请确认 admAgent server 已启动"
    };
    Err(AppError::msg(format!(
        "无法连接 {}：{}",
        transport.display(),
        hint
    )))
}
