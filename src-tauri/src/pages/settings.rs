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
    // 持有 config 写锁：防止与 agent.rs 的 read-modify-write 并发互相覆盖
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

    // 同步 Agent 侧设置（代理 / 多模态模型 / 工具开关 / 记忆开关）到服务端：
    // 桌面端不再写本机 tigerAgent.json —— 远程部署下服务端看不到本机文件，
    // 旧链路会让这些开关静默失效。失败只记日志；对应面板保存时用
    // apply_server_settings 会拿到明确错误。
    crate::pages::agent::push_agent_settings(&app, &settings);

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

// ===== 服务端连接（TCP + TLS，docs/tcp-tls-ecdsa.md §11）=====
//
// 桌面端不再有「本地模式」：服务端由用户自行启动，桌面端只保存一条连接串
// （地址 + 服务端指纹 + token），不再生成任何设备身份。

/// 设置页展示的服务端连接配置。
#[derive(serde::Serialize)]
pub struct ServerConnectionInfo {
    pub connection: String,
    /// 配置是否可解析（地址 + 指纹 + token 齐全）
    pub configured: bool,
    /// 解析失败原因（空 = 配置可解析）
    pub error: String,
}

#[tauri::command]
pub async fn get_server_connection(app: tauri::AppHandle) -> Result<ServerConnectionInfo, AppError> {
    let settings = crate::common::server_mode::load_settings(&app);
    let mut error = String::new();
    let configured = match crate::common::server_mode::resolve(&app) {
        Ok(_) => true,
        Err(e) => {
            error = e.to_string();
            false
        }
    };
    Ok(ServerConnectionInfo {
        connection: settings.server.remote.connection,
        configured,
        error,
    })
}

/// 保存服务端连接串（只改 `server` 段，其余字段原样保留）。
#[tauri::command]
pub async fn set_server_connection(
    app: tauri::AppHandle,
    connection: String,
) -> Result<(), AppError> {
    let raw = connection.trim();
    if raw.is_empty() {
        return Err(AppError::msg(
            "必须粘贴服务端连接串（tigerAgent://<host>[:<port>]?fp=…&token=…）",
        ));
    }
    // 保存前先解析：把「格式不对 / 缺 token」这类问题立刻告诉用户
    crate::common::server_mode::parse_connection(raw)?;

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
        "remote": {
            "connection": raw,
            "paired_at": chrono::Utc::now().to_rfc3339(),
        }
    });
    let json = serde_json::to_string_pretty(&root)
        .map_err(|e| format!("序列化配置失败: {}", e))?;
    std::fs::write(&config_path, &json)
        .map_err(|e| format!("写入配置文件失败: {}", e))?;

    // 立即应用新目标：设置页保存后无需重启就能检测/连接
    if let Ok(target) = crate::common::server_mode::apply(&app) {
        eprintln!("[server] 已切换服务端目标 {}", target.display());
    }
    Ok(())
}

/// 测试当前配置的连接：TLS 握手 + pin 校验 → /v1/health → 带 token 的
/// /v1/workspaces（health 是匿名端点，只有认证端点才能区分「服务端在跑」
/// 和「token 不对」）。
#[tauri::command]
pub async fn test_server_connection(app: tauri::AppHandle) -> Result<String, AppError> {
    use crate::common::agent_http::{build_client, health_check, send};

    let target = crate::common::server_mode::apply(&app)?;
    let client = build_client(&target, std::time::Duration::from_secs(5))
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;
    if !health_check(&client).await {
        return Err(AppError::msg(format!(
            "无法连接 {}：请确认服务端已启动（tigerAgent --host tcp://0.0.0.0:<端口>）、地址可达、指纹与服务端一致",
            target.display()
        )));
    }
    let (status, _) = send(&client, "GET", "/v1/workspaces", None)
        .await
        .map_err(|e| format!("请求 /v1/workspaces 失败: {}", e))?;
    match status {
        200..=299 => {}
        401 | 403 => {
            return Err(AppError::msg(
                "服务端拒绝了请求：token 不正确（请重新复制服务端打印的完整连接串）",
            ))
        }
        other => return Err(AppError::msg(format!("服务端返回 HTTP {}", other))),
    }
    let mode_hint = if crate::common::server_mode::is_loopback(&target.host) {
        "（环回地址：请确认本机已启动 tigerAgent --host tcp://127.0.0.1:<端口>）"
    } else {
        ""
    };
    Ok(format!("连接成功：{}{}", target.display(), mode_hint))
}

/// 把当前保存的连接串解析进全局 active target，不发起任何网络请求。
///
/// 非 Agent 页面（如「模型管理」）可能在 Agent 视图建链之前就发 HTTP 命令
/// （`list_cloud_providers` → `/v1/settings`）；没有这一步，`active_target()`
/// 为空时这些命令会误报「未连接服务端」。
#[tauri::command]
pub fn ensure_server_target(app: tauri::AppHandle) -> Result<String, AppError> {
    let target = crate::common::server_mode::apply(&app)?;
    Ok(target.display())
}
