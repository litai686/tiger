use std::path::PathBuf;
use crate::common::error::AppError;

#[cfg(any(target_os = "macos", target_os = "linux"))]
use tauri::Manager;

pub fn get_exe_dir() -> Result<PathBuf, AppError> {
    std::env::current_exe()
        ?
        .parent()
        .ok_or(AppError::msg("无法获取可执行文件目录"))
        .map(|p| p.to_path_buf())
}

pub fn get_data_dir(app: Option<&tauri::AppHandle>) -> Result<PathBuf, AppError> {
    // macOS / Linux：配置、日志都写用户数据目录。Linux 不能写可执行文件目录——
    // deb 装到 /usr/bin、AppImage 是只读挂载点，写进去必然失败
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    if let Some(app_handle) = app {
        if let Ok(app_data_dir) = app_handle.path().app_data_dir() {
            std::fs::create_dir_all(&app_data_dir).ok();
            return Ok(app_data_dir);
        }
    }
    let _ = app;
    get_exe_dir()
}
