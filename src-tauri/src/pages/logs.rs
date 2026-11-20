// 服务端日志查看 / 下载
//
// 桌面端与服务端可能不在同一台机器（TCP + TLS 远程部署），客户端没有对服务端
// 日志文件的直接访问权，因此内容一律经服务端 HTTP API 取回：
//   GET /v1/logs                — 列出服务端日志文件（名称 / 大小 / 修改时间）
//   GET /v1/logs/{name}?tail=N  — 读取文本（N=0 表示整个文件）
//   GET /v1/logs/{name}?download=1 — 原样下载（Content-Disposition 附件）
//
// 本模块只做转发与保存，不解析日志内容；过滤 / 高亮留在前端。
// 注意：所有诊断输出都走 `api_debug_log!`（tigerAgent_debug.log），与客户端其他
// Rust 侧日志保持同一出口，不要另建日志文件。
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::bail;
use crate::common::agent_http;
use crate::common::error::AppError;
use crate::pages::agent::api_debug_log;

/// 列表 / 文本读取超时：日志最大 10MB，本地连接也是毫秒级。
const READ_TIMEOUT_SECS: u64 = 30;
/// 下载超时：远程链路 + 完整文件（含 panic 转储）留足余量。
const DOWNLOAD_TIMEOUT_SECS: u64 = 120;

/// 服务端日志文件条目（字段与 proto.LogFileInfo 对齐）。
#[derive(Serialize, Deserialize)]
pub struct ServerLogFile {
    pub name: String,
    pub size: i64,
    pub modified: String,
}

/// GET /v1/logs 的响应体（字段与 proto.LogFileList 对齐）。
#[derive(Serialize, Deserialize)]
pub struct ServerLogList {
    /// 服务端日志目录（仅用于展示；客户端不应假设本机可达）
    pub dir: String,
    pub files: Vec<ServerLogFile>,
}

/// DELETE /v1/logs 的响应体（字段与 proto.LogClearResult 对齐）。
#[derive(Serialize, Deserialize)]
pub struct ServerLogClearResult {
    /// 服务端日志目录（仅用于展示）
    pub dir: String,
    /// 被原地截断的文件（服务端仍在写入的 tigerAgent.log）
    #[serde(default)]
    pub truncated: Vec<String>,
    /// 被删除的文件（panic 转储、.prev、轮转文件）
    #[serde(default)]
    pub removed: Vec<String>,
}

/// 文件名校验：服务端已限制为裸文件名，这里再挡一次，避免前端传入 `../` 拼出
/// 越界路径（服务端 400 兜底，但错误信息对用户更直观）。
fn reject_unsafe_name(name: &str) -> Result<(), AppError> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        bail!("非法的日志文件名: {}", name);
    }
    Ok(())
}

fn server_error_message(bytes: &[u8], status: u16) -> String {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).unwrap_or(serde_json::Value::Null);
    value
        .get("message")
        .and_then(|m| m.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("请求失败 (HTTP {})", status))
}

/// 请求服务端日志接口，返回 (状态码, 原始字节)。非 2xx 的语义由调用方处理。
async fn request_log(method: &str, path: &str, timeout_secs: u64) -> Result<(u16, Vec<u8>), AppError> {
    let target = agent_http::active_target().ok_or_else(|| {
        AppError::msg("尚未连接服务端：请先在设置 → 服务端连接中完成配对")
    })?;
    let client = agent_http::build_client(&target, Duration::from_secs(5)).map_err(AppError::msg)?;
    tokio::time::timeout(
        Duration::from_secs(timeout_secs),
        agent_http::send(&client, method, path, None),
    )
    .await
    .map_err(|_| AppError::msg("请求服务端超时"))?
    .map_err(|e| AppError::msg(format!("请求服务端失败: {}", e)))
}

/// 列出服务端日志文件（tigerAgent.log / tigerAgent-panic.log[.prev]）。
#[tauri::command]
pub async fn fetch_server_logs() -> Result<ServerLogList, AppError> {
    let (status, bytes) = request_log("GET", "/v1/logs", READ_TIMEOUT_SECS).await?;
    if !(200..300).contains(&status) {
        let message = server_error_message(&bytes, status);
        api_debug_log(|| format!("Logs ! 拉取服务端日志列表失败: {}", message));
        bail!("{}", message);
    }
    serde_json::from_slice(&bytes).map_err(|e| AppError::msg(format!("解析日志列表失败: {}", e)))
}

/// 读取服务端日志文本；tail=0 表示整个文件（服务端另有大文件上限）。
#[tauri::command]
pub async fn fetch_server_log_text(name: String, tail: u32) -> Result<String, AppError> {
    reject_unsafe_name(&name)?;
    let (status, bytes) =
        request_log("GET", &format!("/v1/logs/{}?tail={}", name, tail), READ_TIMEOUT_SECS).await?;
    if !(200..300).contains(&status) {
        let message = server_error_message(&bytes, status);
        api_debug_log(|| format!("Logs ! 读取服务端日志 {} 失败: {}", name, message));
        bail!("{}", message);
    }
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

/// 下载服务端日志到本机：弹出保存对话框，原样落盘（不做 tail 截断）。
/// 返回保存后的本地路径，便于 UI 提示。
#[tauri::command]
pub async fn download_server_log(app: tauri::AppHandle, name: String) -> Result<String, AppError> {
    use tauri_plugin_dialog::DialogExt;

    reject_unsafe_name(&name)?;
    let (status, bytes) =
        request_log("GET", &format!("/v1/logs/{}?download=1", name), DOWNLOAD_TIMEOUT_SECS).await?;
    if !(200..300).contains(&status) {
        let message = server_error_message(&bytes, status);
        api_debug_log(|| format!("Logs ! 下载服务端日志 {} 失败: {}", name, message));
        bail!("{}", message);
    }

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(&name)
        .save_file(move |picked| {
            let _ = tx.send(picked);
        });
    let picked = rx
        .await
        .map_err(|_| AppError::msg("保存对话框失败"))?
        .ok_or_else(|| AppError::msg("用户取消了保存"))?;
    let path = picked
        .into_path()
        .map_err(|e| AppError::msg(format!("无法获取保存路径: {}", e)))?;
    std::fs::write(&path, &bytes)
        .map_err(|e| AppError::msg(format!("写入日志文件失败: {}", e)))?;

    api_debug_log(|| {
        format!(
            "Logs: 已下载服务端日志 {} ({} bytes) -> {}",
            name,
            bytes.len(),
            path.display()
        )
    });
    Ok(path.to_string_lossy().to_string())
}

/// 清空服务端日志：服务端原地截断正在写入的 tigerAgent.log，并删除 panic
/// 转储、`.prev` 与轮转文件；日志写入不需要重启。
#[tauri::command]
pub async fn clear_server_logs() -> Result<ServerLogClearResult, AppError> {
    let (status, bytes) = request_log("DELETE", "/v1/logs", READ_TIMEOUT_SECS).await?;
    if !(200..300).contains(&status) {
        let message = server_error_message(&bytes, status);
        api_debug_log(|| format!("Logs ! 清空服务端日志失败: {}", message));
        bail!("{}", message);
    }
    serde_json::from_slice(&bytes).map_err(|e| AppError::msg(format!("解析清空结果失败: {}", e)))
}
