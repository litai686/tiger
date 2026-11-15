// index.html 对应逻辑（硬件信息、全局更新）

use crate::common::*;
use crate::common::config;
use crate::common::utils::download::download_with_resume;
use crate::bail;

use tauri::Emitter;

// ===== 辅助函数 =====

/// 简单解析 semver 版本号 "x.y.z" 并比较
fn compare_versions(current: &str, remote: &str) -> std::cmp::Ordering {
    let parse_version = |v: &str| -> Vec<u32> {
        v.trim()
            .split('.')
            .filter_map(|s| s.parse::<u32>().ok())
            .collect()
    };

    let cur_parts = parse_version(current);
    let rem_parts = parse_version(remote);

    for i in 0..cur_parts.len().max(rem_parts.len()) {
        let cur = cur_parts.get(i).copied().unwrap_or(0);
        let rem = rem_parts.get(i).copied().unwrap_or(0);
        if cur < rem {
            return std::cmp::Ordering::Less;
        }
        if cur > rem {
            return std::cmp::Ordering::Greater;
        }
    }
    std::cmp::Ordering::Equal
}

// ===== Tauri Command =====

/// 远程更新清单地址：桌面端升级检测的唯一入口（各平台安装包地址与 content 升级日志链接都从这里下发）
pub(crate) const UPDATE_INFO_URL: &str = "https://tiger.kuda520.com/update.json";

/// 拉取远程更新清单 update.json（15s 超时）。
/// 供 check_update 与 Agent 版本检查共用。
pub(crate) async fn fetch_update_info() -> Result<UpdateInfo, AppError> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let response = client
        .get(UPDATE_INFO_URL)
        .send()
        .await
        .map_err(|e| format!("检查更新失败: {}", e))?;

    if !response.status().is_success() {
        bail!("服务器返回错误状态码: {}", response.status());
    }

    let text = response
        .text()
        .await
        .map_err(|e| format!("读取响应文本失败: {}", e))?;

    serde_json::from_str(&text).map_err(|e| AppError::msg(format!("解析更新信息失败: {}", e)))
}

/// 首页硬件信息：读取**服务端**主机规格（GET /v1/system/info）。
///
/// 桌面端只是远程 UI，用户看这块数字是为了判断「服务端这台机器能不能跑某个
/// 模型」，所以不能再采集本机硬件。未连接服务端时直接报错，由前端显示加载失败。
#[tauri::command]
pub async fn get_system_info(app: tauri::AppHandle) -> Result<SystemInfo, AppError> {
    // 页面首次打开时底部状态栏与首屏并行拉取，此时 Agent 会话可能尚未建立
    // （全局 active target 还没初始化）。这里按当前连接串补一次解析并落地目标，
    // 让首个请求就能成功，而不是等 Agent 页建链后靠下一轮轮询恢复。
    let target = match agent_http::active_target() {
        Some(target) => target,
        None => crate::common::server_mode::apply(&app)?,
    };
    let client = agent_http::build_client(&target, std::time::Duration::from_secs(3))
        .map_err(AppError::msg)?;
    let (status, body) = tokio::time::timeout(
        std::time::Duration::from_secs(8),
        agent_http::send(&client, "GET", "/v1/system/info", None),
    )
    .await
    .map_err(|_| AppError::msg("读取服务端硬件信息超时"))?
    .map_err(|e| AppError::msg(format!("读取服务端硬件信息失败: {}", e)))?;
    if !(200..300).contains(&status) {
        bail!("读取服务端硬件信息失败: HTTP {}（服务端版本可能过低，请升级服务端）", status);
    }
    serde_json::from_slice::<SystemInfo>(&body)
        .map_err(|e| AppError::msg(format!("解析服务端硬件信息失败: {}", e)))
}

#[tauri::command]
pub async fn check_update(app: tauri::AppHandle) -> Result<UpdateCheckResult, AppError> {
    let current_version = app.config().version.clone().unwrap_or_else(|| "0.0.0".to_string());

    let update_info = fetch_update_info().await?;

    let has_update = compare_versions(&current_version, &update_info.version) == std::cmp::Ordering::Less;

    let download_url;
    let changelog_url;

    #[cfg(target_os = "windows")]
    {
        download_url = update_info.windows.as_ref().map(|p| p.app_url.clone());
        changelog_url = update_info.windows.as_ref().map(|p| p.content.clone());
    }

    #[cfg(target_os = "macos")]
    {
        download_url = update_info.mac_os.as_ref().map(|p| p.app_url.clone());
        changelog_url = update_info.mac_os.as_ref().map(|p| p.content.clone());
    }

    #[cfg(target_os = "linux")]
    {
        // update.json 未提供 linux 字段时退化为「只提示版本、不显示下载按钮」（前端已处理空地址）
        download_url = update_info.linux.as_ref().map(|p| p.app_url.clone());
        changelog_url = update_info.linux.as_ref().map(|p| p.content.clone());
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        download_url = None;
        changelog_url = None;
    }

    Ok(UpdateCheckResult {
        has_update,
        remote_version: update_info.version,
        current_version,
        download_url,
        changelog_url,
    })
}

// ===== 应用自身更新（静默下载安装包 → 提示升级）=====

/// 更新包存放目录：安装包长期保留，
/// 用户「稍后再说」后重启应用仍能直接提示升级（无需重新下载）。
/// 统一放用户数据目录而非 exe 目录：Windows 装在 Program Files 下时那里不可写。
fn app_update_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, AppError> {
    use tauri::Manager;
    let dir = match app.path().app_data_dir() {
        Ok(data_dir) => data_dir.join("updates"),
        Err(_) => config::get_data_dir(Some(app))?.join("updates"),
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建更新目录失败: {}", e))?;
    Ok(dir)
}

/// 安装包落盘文件名：`Tiger-<版本>-<URL 文件名>`。
/// 必须带版本号——下载地址不带版本号时，若沿用同名文件会被断点续传逻辑
/// 误判为"已下载完成"，导致用户升级到的还是上一个版本。
fn app_update_file_name(url: &str, version: &str) -> String {
    let raw = url
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .rsplit('/')
        .next()
        .unwrap_or("");
    let cleaned: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-' || *c == '_')
        .collect();
    let cleaned = cleaned.trim_matches('.');

    // 版本号同样来自远端 update.json，必须走同一套白名单：Path::join 不做归一化，
    // 含路径分隔符或 '..' 的版本号会拼出更新目录之外的路径
    let version_filtered: String = version
        .trim()
        .trim_start_matches('v')
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-' || *c == '_')
        .collect();
    let version_filtered = version_filtered.trim_matches('.').to_string();
    let version = if version_filtered.is_empty() {
        "unknown".to_string()
    } else {
        version_filtered
    };

    if cleaned.is_empty() {
        format!("Tiger-{}-setup", version)
    } else {
        format!("Tiger-{}-{}", version, cleaned)
    }
}

/// Linux：AppImage / deb 需要可执行位才能被直接拉起。
/// 新下载完成与"上次已下载好"两条成功路径都要走一遍——若上次会话在 `.part`
/// 重命名与 chmod 之间被杀，之后就只剩早退路径，安装包永远补不上可执行位。
#[cfg(target_os = "linux")]
fn ensure_installer_executable(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = std::fs::metadata(path) {
        let mut perms = meta.permissions();
        perms.set_mode(0o755);
        let _ = std::fs::set_permissions(path, perms);
    }
}

#[cfg(not(target_os = "linux"))]
fn ensure_installer_executable(_path: &std::path::Path) {}

/// 静默下载应用安装包到本地（更新下载地址由 update.json 下发）。
/// 前端启动时后台调用：不弹窗、不阻塞界面，完成后由前端提示用户升级。
/// 已下载过（同名文件存在）时立即返回，实现"重启后无需重新下载直接提示"。
#[tauri::command]
pub async fn download_app_update(
    app: tauri::AppHandle,
    version: String,
    url: String,
) -> Result<String, AppError> {
    let url = url.trim().to_string();
    if !url.starts_with("http://") && !url.starts_with("https://") {
        bail!("更新下载地址无效: {}", url);
    }

    let dir = app_update_dir(&app)?;
    let file_name = app_update_file_name(&url, &version);
    let final_path = dir.join(&file_name);
    let part_path = dir.join(format!("{}.part", file_name));

    // 清掉其它版本的残留安装包（每个版本只留当前一个文件，避免磁盘越攒越多）
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path == final_path || path == part_path {
                continue;
            }
            if path.is_file() {
                let _ = std::fs::remove_file(&path);
            }
        }
    }

    let app_clone = app.clone();
    let emit = move |status: &str, progress: u8| {
        app_clone
            .emit(
                "app-update-progress",
                serde_json::json!({ "status": status, "progress": progress }),
            )
            .ok();
    };

    if final_path.exists() {
        ensure_installer_executable(&final_path);
        emit("done", 100);
        return Ok(final_path.to_string_lossy().to_string());
    }

    emit("downloading", 0);

    // 安装包体积较大且可能走慢速网络，超时放宽到 30 分钟
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(1800))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let app_progress = app.clone();
    download_with_resume(&client, &url, &final_path, &part_path, |progress, _downloaded, _total| {
        app_progress
            .emit(
                "app-update-progress",
                serde_json::json!({ "status": "downloading", "progress": progress }),
            )
            .ok();
    })
    .await?;

    ensure_installer_executable(&final_path);

    emit("done", 100);
    Ok(final_path.to_string_lossy().to_string())
}

/// 是否为 deb 包（Linux 分发形态之一）。
/// deb 不能直接执行（exec 会返回 ENOEXEC），必须交给包管理器提权安装。
/// 不加 cfg 限制是为了在任意平台的单测里都能验证扩展名判定。
#[cfg(any(target_os = "linux", test))]
fn is_deb_installer_path(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("deb"))
        .unwrap_or(false)
}

/// 拉起下载好的安装包，随后清理子进程并退出本进程——安装程序需要覆盖
    /// 正在运行的可执行文件，Tiger 必须先退出。（清理逻辑与托盘「退出」共用）
///
/// Linux 的 deb 例外：它由包管理器安装，必须先等出结果（失败时要把原因告诉
/// 用户，而不是先退出再让升级无声失败），故整体放在阻塞线程里执行。
#[tauri::command]
pub async fn install_app_update(app: tauri::AppHandle, path: String) -> Result<(), AppError> {
    let dir = app_update_dir(&app)?;
    let dir_real = std::fs::canonicalize(&dir).unwrap_or_else(|_| dir.clone());
    // 只允许运行更新目录内下载下来的安装包：路径由前端透传，不能变成任意可执行文件的启动器
    let installer = std::fs::canonicalize(&path)
        .map_err(|_| AppError::msg("安装包不存在或已被删除，请重新下载"))?;
    if !installer.starts_with(&dir_real) {
        bail!("安装包路径不合法: {}", path);
    }
    if !installer.is_file() {
        bail!("安装包不存在: {}", path);
    }

    let install_path = installer.clone();
    tauri::async_runtime::spawn_blocking(move || launch_installer(&install_path))
        .await
        .map_err(|e| AppError::msg(format!("安装任务异常: {}", e)))??;

    crate::cleanup_processes(&app);
    app.exit(0);
    Ok(())
}

#[cfg(target_os = "windows")]
fn launch_installer(path: &std::path::Path) -> Result<(), AppError> {
    use std::os::windows::process::CommandExt;
    // 新进程组 + 不挂控制台：否则 Tiger 一退出，安装向导可能被一并带走。
    // BREAKAWAY 让安装程序脱离 Tiger 所在的 Job（部分环境不允许，失败则退回普通启动）
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;

    let spawn = |flags: u32| {
        let mut cmd = std::process::Command::new(path);
        cmd.creation_flags(flags);
        cmd.spawn()
    };

    match spawn(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB) {
        Ok(_) => Ok(()),
        Err(_) => spawn(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
            .map(|_| ())
            .map_err(|e| AppError::msg(format!("启动安装程序失败: {}", e))),
    }
}

#[cfg(target_os = "macos")]
fn launch_installer(path: &std::path::Path) -> Result<(), AppError> {
    // DMG 交给系统挂载打开，用户在挂载窗口里把 Tiger 拖进「应用程序」完成覆盖
    let mut cmd = std::process::Command::new("open");
    cmd.arg(path);
    platform::spawn_detached(&mut cmd)
        .map(|_| ())
        .map_err(|e| AppError::msg(format!("打开安装包失败: {}", e)))
}

#[cfg(target_os = "linux")]
fn launch_installer(path: &std::path::Path) -> Result<(), AppError> {
    if is_deb_installer_path(path) {
        return install_deb_package(path);
    }

    // AppImage / .run 等自解压包：补可执行位后直接拉起
    ensure_installer_executable(path);
    // 当前进程本身就跑在 AppImage 里时（$APPIMAGE），必须先用新包覆盖该文件：
    // 直接跑下载目录里的新包只会再开一个实例，旧文件始终没被升级
    if let Some(current) = std::env::var_os("APPIMAGE").map(std::path::PathBuf::from) {
        if current.as_path() != path {
            replace_appimage(&current, path)?;
            return spawn_installer(&current);
        }
    }
    spawn_installer(path)
}

#[cfg(target_os = "linux")]
fn spawn_installer(path: &std::path::Path) -> Result<(), AppError> {
    let mut cmd = std::process::Command::new(path);
    platform::spawn_detached(&mut cmd)
        .map(|_| ())
        .map_err(|e| AppError::msg(format!("启动安装包失败: {}（可手动执行：{}）", e, path.display())))
}

/// 用新下载的 AppImage 覆盖当前正在运行的那个文件（临时文件 + rename，避免写坏原文件）。
/// AppImage 运行时它是 FUSE 挂载的只读文件，但所在目录通常可写，替换不影响正在运行的进程。
#[cfg(target_os = "linux")]
fn replace_appimage(current: &std::path::Path, new_file: &std::path::Path) -> Result<(), AppError> {
    use std::os::unix::fs::PermissionsExt;

    let Some(dir) = current.parent() else {
        bail!("无法定位当前 AppImage 所在目录: {}", current.display());
    };
    let staged = dir.join(format!(".Tiger-update-{}", std::process::id()));

    let copy = || -> std::io::Result<()> {
        std::fs::copy(new_file, &staged)?;
        let mut perms = std::fs::metadata(&staged)?.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&staged, perms)?;
        std::fs::rename(&staged, current)?;
        Ok(())
    };
    copy().map_err(|e| {
        let _ = std::fs::remove_file(&staged);
        AppError::msg(format!(
            "无法覆盖当前 AppImage（{}）：{}\n请手动用下载好的新版本替换该文件：{}",
            current.display(),
            e,
            new_file.display()
        ))
    })
}

/// deb 包：交给 apt 安装（能自动补依赖），用 pkexec 弹系统授权框提权——
/// Tiger 无 TTY，sudo 无法交互输入密码，只有 polkit 授权代理可用。
/// 必须等出结果：安装失败（授权取消、依赖冲突）时保持应用运行并把原因显示给用户，
/// 直接把文件当可执行文件拉起是行不通的（deb 不是可执行格式，exec 会 ENOEXEC）。
#[cfg(target_os = "linux")]
fn install_deb_package(path: &std::path::Path) -> Result<(), AppError> {
    let log_path = path.with_extension("install.log");
    let log = std::fs::File::create(&log_path)
        .map_err(|e| AppError::msg(format!("创建安装日志失败: {}", e)))?;
    let log_err = log
        .try_clone()
        .map_err(|e| AppError::msg(format!("创建安装日志失败: {}", e)))?;

    // stdout/stderr 重定向到文件而非管道：安装过程只等退出码，不读管道，
    // 用管道会因缓冲区写满把 apt 卡死
    // --disable-internal-agent：只认桌面会话的 polkit 授权代理（图形密码框），
    // 否则 pkexec 的内部文本代理会试图从 stdin 读密码——stdin 已置 null，会挂到超时
    let mut cmd = std::process::Command::new("pkexec");
    cmd.arg("--disable-internal-agent")
        .arg("env")
        .arg("DEBIAN_FRONTEND=noninteractive")
        .arg("apt-get")
        .arg("install")
        .arg("-y")
        .arg("--allow-downgrades")
        .arg("--no-install-recommends")
        .arg(path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::from(log))
        .stderr(std::process::Stdio::from(log_err));

    let mut child = platform::spawn_detached(&mut cmd).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::msg(format!(
                "系统缺少 pkexec（polkit），无法自动提权安装。\n请手动执行升级：\nsudo apt install \"{}\"",
                path.display()
            ))
        } else {
            AppError::msg(format!("启动安装程序失败: {}", e))
        }
    })?;

    // 等安装结束（上限 10 分钟，超时按失败处理，避免弹窗一直挂着）
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(600);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(e) => return Err(AppError::msg(format!("等待安装程序失败: {}", e))),
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    };

    let tail = read_log_tail(&log_path, 800);
    match status {
        Some(status) if status.success() => Ok(()),
        Some(status) => Err(AppError::msg(format!(
            "自动安装未能完成（安装程序退出码 {}，可能是授权被取消或系统未运行 polkit 授权代理）。\n请手动执行升级：\nsudo apt install \"{}\"\n\n{}",
            status.code().map(|c| c.to_string()).unwrap_or_else(|| "未知".to_string()),
            path.display(),
            tail
        ))),
        None => Err(AppError::msg(format!(
            "安装超时（超过 10 分钟）。请手动执行升级：\nsudo apt install \"{}\"\n\n{}",
            path.display(),
            tail
        ))),
    }
}

/// 读取日志文件末尾若干字符（安装失败时用于展示 apt 的真实原因）
#[cfg(target_os = "linux")]
fn read_log_tail(path: &std::path::Path, max_chars: usize) -> String {
    let Ok(text) = std::fs::read_to_string(path) else {
        return String::new();
    };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let chars: Vec<char> = trimmed.chars().collect();
    let start = chars.len().saturating_sub(max_chars);
    chars[start..].iter().collect()
}

#[cfg(test)]
mod tests {
    use super::{app_update_file_name, is_deb_installer_path};
    use std::path::Path;
    // 文件名必须带版本号：下载地址不带版本号时，沿用同名文件会被断点续传逻辑
    // 当成"已下载完成"，用户点升级装上的还是旧版本。
    #[test]
    fn file_name_contains_version() {
        let name = app_update_file_name("https://adm.tuduoduo.top/ADM_x64-setup.exe", "0.6.5");
        assert!(name.starts_with("Tiger-0.6.5-"), "got {}", name);
        assert!(name.ends_with("ADM_x64-setup.exe"), "got {}", name);
    }

    #[test]
    fn file_name_strips_query_and_unsafe_chars() {
        let name = app_update_file_name(
            "https://cdn.example.com/dl/ADM%20v1.2.3.dmg?token=abc#frag",
            "v1.2.3",
        );
        assert_eq!(name, "Tiger-1.2.3-ADM20v1.2.3.dmg");
    }

    #[test]
    fn file_name_falls_back_when_url_has_no_file_part() {
        let name = app_update_file_name("https://adm.tuduoduo.top/", "1.0.0");
        assert_eq!(name, "Tiger-1.0.0-setup");
    }

    // 版本号同样来自远端 update.json：含路径分隔符 / '..' 时必须被白名单吃掉，
    // 否则 dir.join 会拼出更新目录之外的路径（Path::join 不做归一化）
    #[test]
    fn file_name_neutralizes_path_like_version() {
        let name = app_update_file_name("https://adm.tuduoduo.top/a.exe", "../../etc/passwd");
        assert!(!name.contains('/') && !name.contains(".."), "got {}", name);
        assert_eq!(name, "Tiger-etcpasswd-a.exe");
    }

    #[test]
    fn file_name_falls_back_when_version_is_empty() {
        let name = app_update_file_name("https://adm.tuduoduo.top/a.exe", "v");
        assert_eq!(name, "Tiger-unknown-a.exe");
    }

    // Linux 分发的 deb 不能当可执行文件拉起（exec 会 ENOEXEC），必须走包管理器安装；
    // 落地文件名形如 `Tiger-0.7.5-ADM_0.7.5_amd64.deb`，扩展名判定不受前缀影响
    #[test]
    fn detects_deb_installer_by_extension() {
        assert!(is_deb_installer_path(Path::new("/tmp/updates/Tiger-0.7.5-ADM_0.7.5_amd64.deb")));
        assert!(is_deb_installer_path(Path::new("/tmp/updates/Tiger-0.7.5-setup.DEB")));
        assert!(!is_deb_installer_path(Path::new("/tmp/updates/Tiger-0.7.5-ADM_0.7.5_amd64.AppImage")));
        assert!(!is_deb_installer_path(Path::new("/tmp/updates/Tiger-0.7.5-setup")));
    }
}
