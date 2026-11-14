// 技能管理（桌面端只是 UI，技能安装在**服务端**主机上）。
//
// 远程部署下桌面端与 Agent server 不在同一台机器：旧实现把技能下载/解压到
// 桌面本机目录，服务端既看不到也无法使用。现在四个命令全部转发到服务端：
//   fetch_skill_store      — 拉取远程技能商店列表（纯网络读取，保留在桌面端）
//   install_skill          — POST /v1/skills/install（服务端下载 + 校验 + 解压）
//   install_skill_from_zip — POST /v1/skills/install-zip（上传 zip；target=None 仅校验）
//   uninstall_skill        — POST /v1/skills/uninstall
//   list_installed_skills  — GET /v1/skills/installed（扫描服务端技能目录）
//
// 校验规则（skill-development.md §4.3 规则 1-6）由服务端执行，错误消息沿用
// `[skill:exists]` / `[skill:invalid]` 前缀，前端分支逻辑不变。
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::bail;
use crate::common::agent_http;
use crate::common::error::AppError;
use crate::pages::agent::api_debug_log;

/// 技能商店数据源
const STORE_URL: &str = "https://adm.tuduoduo.top/skills.json";
/// 上传包大小上限（与服务端一致）
const MAX_SKILL_ZIP_BYTES: usize = 50 * 1024 * 1024;
/// 安装请求超时：服务端要下载 + 解压，给足时间
const INSTALL_TIMEOUT_SECS: u64 = 300;

// ===== 返回结构 =====

#[derive(Serialize, Deserialize)]
pub struct SkillStoreItem {
    skill_name: String,
    skill_type: String,
    skill_url: String,
    skill_info: String,
}

#[derive(Serialize)]
pub struct InstallResult {
    ok: bool,
    dir: String,
    /// zip 包内实际技能目录名（商店展示名可能是中文，目录名以包内为准）
    name: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct InstalledSkill {
    name: String,
    path: String,
    /// user=全局、project=当前项目
    source: String,
    description: String,
    user_invocable: bool,
    /// SKILL.md 完整内容的 base64 编码（供前端直接附加）
    content_base64: String,
}

// ===== 服务端请求 =====

/// 调用服务端技能接口并解析 JSON。非 2xx 时把服务端 `message` 原样抛给前端
/// （其中含 `[skill:exists]` / `[skill:invalid]` 前缀）。
async fn server_request(
    method: &str,
    path: &str,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, AppError> {
    let target = agent_http::active_target()
        .ok_or_else(|| AppError::msg("未连接服务端：技能安装在服务端主机上，请先完成服务端连接"))?;
    let client = agent_http::build_client(&target, Duration::from_secs(5)).map_err(AppError::msg)?;
    let (status, bytes) = tokio::time::timeout(
        Duration::from_secs(INSTALL_TIMEOUT_SECS),
        agent_http::send(&client, method, path, body),
    )
    .await
    .map_err(|_| AppError::msg("请求服务端超时"))?
    .map_err(|e| AppError::msg(format!("请求服务端失败: {}", e)))?;

    let value: serde_json::Value =
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    if !(200..300).contains(&status) {
        let message = value
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("请求失败");
        bail!("{}", message);
    }
    Ok(value)
}

/// 当前激活 workspace（project scope 需要；global scope 允许为空）。
fn active_workspace(app: &tauri::AppHandle) -> String {
    crate::pages::agent::active_workspace_id(app).unwrap_or_default()
}

// ===== Tauri 命令 =====

/// 拉取远程技能商店列表（10s 超时，避免 CORS 走 Rust 端）。
#[tauri::command]
pub async fn fetch_skill_store() -> Result<Vec<SkillStoreItem>, AppError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let response = client
        .get(STORE_URL)
        .send()
        .await
        .map_err(|e| format!("加载技能商店失败: {}", e))?;
    if !response.status().is_success() {
        bail!("加载技能商店失败，服务器返回: {}", response.status());
    }
    let items = response
        .json::<Vec<SkillStoreItem>>()
        .await
        .map_err(|e| AppError::msg(format!("解析技能商店数据失败: {}", e)))?;
    api_debug_log(|| format!("Skills: fetch_skill_store OK count={}", items.len()));
    Ok(items)
}

/// 商店安装：由服务端下载、校验、解压到服务端技能目录。
#[tauri::command]
pub async fn install_skill(
    app: tauri::AppHandle,
    skill_url: String,
    skill_name: String,
    target: String,
    overwrite: Option<bool>,
) -> Result<InstallResult, AppError> {
    api_debug_log(|| format!("Skills: install_skill url={} target={}", skill_url, target));
    let value = server_request(
        "POST",
        "/v1/skills/install",
        Some(serde_json::json!({
            "url": skill_url,
            "name": skill_name,
            "scope": target,
            "workspace_id": active_workspace(&app),
            "overwrite": overwrite.unwrap_or(false),
        })),
    )
    .await?;
    Ok(InstallResult {
        ok: true,
        dir: value
            .get("dir")
            .and_then(|d| d.as_str())
            .unwrap_or("")
            .to_string(),
        name: value
            .get("name")
            .and_then(|n| n.as_str())
            .map(|s| s.to_string()),
    })
}

/// 本地上传安装：读本机 zip 作为**输入**，交给服务端校验/解压（用户原文件不动）。
/// target 为 None 时只做规则校验（前端先校验、通过后再弹位置选择）。
#[tauri::command]
pub async fn install_skill_from_zip(
    app: tauri::AppHandle,
    zip_path: String,
    target: Option<String>,
    overwrite: Option<bool>,
) -> Result<InstallResult, AppError> {
    let src = PathBuf::from(&zip_path);
    if !src.exists() {
        bail!("技能包文件不存在: {}", zip_path);
    }
    let bytes = std::fs::read(&src)
        .map_err(|e| AppError::msg(format!("读取技能包失败: {}", e)))?;
    if bytes.len() > MAX_SKILL_ZIP_BYTES {
        api_debug_log(|| {
            format!(
                "Skills ! install_skill_from_zip 过大 zip={} bytes={}",
                zip_path,
                bytes.len()
            )
        });
        return Err(AppError::msg("[skill:invalid] 技能包过大（最大 50MB）"));
    }
    use base64::Engine as _;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);

    let Some(target) = target else {
        let value = server_request(
            "POST",
            "/v1/skills/install-zip",
            Some(serde_json::json!({ "zip_base64": encoded, "validate_only": true })),
        )
        .await?;
        return Ok(InstallResult {
            ok: true,
            dir: String::new(),
            name: value
                .get("name")
                .and_then(|n| n.as_str())
                .map(|s| s.to_string()),
        });
    };

    api_debug_log(|| {
        format!(
            "Skills: install_skill_from_zip 校验通过 zip={} target={}",
            zip_path, target
        )
    });
    let value = server_request(
        "POST",
        "/v1/skills/install-zip",
        Some(serde_json::json!({
            "zip_base64": encoded,
            "scope": target,
            "workspace_id": active_workspace(&app),
            "overwrite": overwrite.unwrap_or(false),
        })),
    )
    .await?;
    Ok(InstallResult {
        ok: true,
        dir: value
            .get("dir")
            .and_then(|d| d.as_str())
            .unwrap_or("")
            .to_string(),
        name: value
            .get("name")
            .and_then(|n| n.as_str())
            .map(|s| s.to_string()),
    })
}

/// 卸载技能：删除服务端对应目录（system 内置技能不在此列，前端不显示卸载按钮）。
#[tauri::command]
pub async fn uninstall_skill(
    app: tauri::AppHandle,
    skill_name: String,
    target: String,
) -> Result<bool, AppError> {
    api_debug_log(|| {
        format!(
            "Skills: uninstall_skill name={} target={}",
            skill_name, target
        )
    });
    server_request(
        "POST",
        "/v1/skills/uninstall",
        Some(serde_json::json!({
            "name": skill_name,
            "scope": target,
            "workspace_id": active_workspace(&app),
        })),
    )
    .await?;
    Ok(true)
}

/// 扫描服务端已安装技能（「我的技能」数据源）。
/// target: "global" | "project" | None（全部）
#[tauri::command]
pub async fn list_installed_skills(
    app: tauri::AppHandle,
    target: Option<String>,
) -> Result<Vec<InstalledSkill>, AppError> {
    let workspace = active_workspace(&app);
    let mut path = format!("/v1/skills/installed?workspace_id={}", workspace);
    if let Some(scope) = target.as_deref() {
        if scope.is_empty() {
            bail!("无效的安装位置");
        }
        path.push_str("&scope=");
        path.push_str(scope);
    }
    let value = server_request("GET", &path, None).await?;
    let list: Vec<InstalledSkill> = serde_json::from_value(value)
        .map_err(|e| AppError::msg(format!("解析技能列表失败: {}", e)))?;
    api_debug_log(|| format!("Skills: list_installed_skills OK count={}", list.len()));
    Ok(list)
}
