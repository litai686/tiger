// Agent 页面后端逻辑：服务端连接（TCP + TLS，服务端由用户自行启动）与会话管理 + HTTP API 代理

use crate::app_state::{AppState, AgentServerSession};
use crate::common::agent_http::{self, TcpTarget, build_client, health_check};
use crate::common::config;
use crate::common::types::{Settings, WorkDirEntry};
use crate::common::error::AppError;
use crate::bail;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::Emitter;
use tauri::Manager;

// 读取配置文件中的 agent 工作目录（默认空）
fn load_agent_workdir(app: &tauri::AppHandle) -> String {
    let data_dir = match config::get_data_dir(Some(app)) {
        Ok(d) => d,
        Err(_) => return String::new(),
    };
    let config_path = data_dir.join("config.json");
    if let Ok(json) = std::fs::read_to_string(&config_path) {
        if let Ok(settings) = serde_json::from_str::<Settings>(&json) {
            return settings.agent_workdir;
        }
    }
    String::new()
}

// 原子写入工作目录到配置文件
fn save_agent_workdir(app: &tauri::AppHandle, workdir: &str) -> Result<(), AppError> {
    let state = app.state::<AppState>();
    let _lock = state.config_write_lock.lock().map_err(|e| e.to_string())?;
    let data_dir = config::get_data_dir(Some(app))?;
    let config_path = data_dir.join("config.json");

    let mut settings = if config_path.exists() {
        let json = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("读取配置文件失败: {}", e))?;
        serde_json::from_str::<Settings>(&json)
            .map_err(|e| format!("解析配置文件失败: {}", e))?
    } else {
        Settings::default()
    };

    settings.agent_workdir = workdir.to_string();

    let json = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("序列化配置失败: {}", e))?;
    // 直接写入目标文件，避免 macOS 上 rename 失败
    std::fs::write(&config_path, &json).map_err(|e| format!("写入配置文件失败: {}", e))?;
    Ok(())
}

// ===== tigerAgent.json 配置 =====

/// tigerAgent.json 的存放目录。
/// Windows：`%LOCALAPPDATA%\Agent`（与 Agent server 的 GlobalConfigData 同目录，
/// 合并优先级高于 `~/.config/tigerAgent/tigerAgent.json`，避免低优先级旧值覆盖 UI 写入）；
/// 其它平台：保持 `$HOME/.config/tigerAgent`（无 LOCALAPPDATA 概念）。
/// 首次切换到新目录时会自动把旧 `~/.config/tigerAgent/tigerAgent.json` 一次性迁移
/// （内容合并进新位置、备份到 .migrated.bak、旧位置写占位标记）。
fn agent_config_dir() -> Result<PathBuf, AppError> {
    let dir = if cfg!(target_os = "windows") {
        let local_app_data = std::env::var("LOCALAPPDATA")
            .ok()
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var("USERPROFILE")
                    .ok()
                    .map(|p| PathBuf::from(p).join("AppData").join("Local"))
            });
        match local_app_data {
            Some(p) => p.join("tigerAgent"),
            None => {
                return Err(AppError::msg("无法确定本地应用数据目录（LOCALAPPDATA），无法创建 Agent 配置目录"));
            }
        }
    } else {
        let home = if let Ok(p) = std::env::var("HOME") {
            PathBuf::from(p)
        } else {
            return Err(AppError::msg("无法确定用户主目录，无法创建 Agent 配置目录"));
        };
        home.join(".config").join("tigerAgent")
    };
    // 迁移只针对 Windows 的目录切换；其它平台新旧路径相同，迁移会把自己改名，必须跳过。
    #[cfg(target_os = "windows")]
    migrate_legacy_config(&dir);
    Ok(dir)
}

/// 把 overlay 中 base 缺失的键合并进 base（对象递归合并；标量/数组以 base 为准）。
/// 语义对齐 Agent server 的 JSON 深合并：新位置（高优先级）内容优先。
#[cfg(target_os = "windows")]
fn merge_json(base: &mut serde_json::Value, overlay: &serde_json::Value) {
    if let (serde_json::Value::Object(b), serde_json::Value::Object(o)) = (base, overlay) {
        for (k, v) in o {
            match b.get_mut(k) {
                Some(bv) => merge_json(bv, v),
                None => {
                    b.insert(k.clone(), v.clone());
                }
            }
        }
    }
}

/// 一次性迁移：把旧 `$HOME/.config/Agent/tigerAgent.json` 的内容合并进新目录下的
/// tigerAgent.json（新文件内容优先，旧文件缺失的键补入，如历史云端 provider），
/// 原内容先备份到 `tigerAgent.json.migrated.bak`（仅当尚无备份时），随后在旧位置
/// **覆盖写入占位标记** `{"migrated_to_localappdata":true}`（不再改名）。
///
/// 占位而非改名是必须的：Agent server 的 EnsureDefaultConfig 每次启动都检查
/// `~/.config/tigerAgent/tigerAgent.json`，文件不存在就重建默认 local 配置——若迁移把
/// 它改名，server 会重建默认、迁移又改名，形成循环（升级后首次启动即因此出现
/// "Created default local-model config" 日志与配置短暂退化）。占位文件使该检查永远
/// 通过，且占位是未知字段，JSON 合并时对生效配置零影响。
/// 幂等：旧文件不存在或已是占位则直接返回；失败只打日志，不影响主流程（下次调用会重试）。
#[cfg(target_os = "windows")]
fn migrate_legacy_config(new_dir: &std::path::Path) {
    const MIGRATED_MARKER: &str = "migrated_to_localappdata";
    let home = match std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        Ok(h) => PathBuf::from(h),
        Err(_) => return,
    };
    let legacy_path = home.join(".config").join("tigerAgent").join("tigerAgent.json");
    if !legacy_path.exists() {
        return;
    }
    let new_path = new_dir.join("tigerAgent.json");
    if new_path == legacy_path {
        // 新旧同路径（非 Windows 或 HOME 恰好等于数据目录的异常场景）：无需迁移
        return;
    }
    let legacy = match std::fs::read_to_string(&legacy_path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[Agent] 迁移旧配置：读取 {} 失败: {}", legacy_path.display(), e);
            return;
        }
    };
    let legacy_value: serde_json::Value = match serde_json::from_str(&legacy) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[Agent] 迁移旧配置：解析 {} 失败: {}", legacy_path.display(), e);
            return;
        }
    };
    // 已是占位：迁移已完成，跳过
    if legacy_value.get(MIGRATED_MARKER).and_then(|v| v.as_bool()) == Some(true) {
        return;
    }
    let result = (|| -> Result<(), AppError> {
        if new_path.exists() {
            let s = std::fs::read_to_string(&new_path)
                .map_err(|e| format!("读取 {} 失败: {}", new_path.display(), e))?;
            let mut new_value: serde_json::Value = serde_json::from_str(&s)
                .map_err(|e| format!("解析 {} 失败: {}", new_path.display(), e))?;
            merge_json(&mut new_value, &legacy_value);
            // 迁移在 agent_config_dir() 内部触发，此时不能走
            // update_agent_config（它会再调 agent_config_dir → 递归 + Mutex 重入）。
            // 直接用原子写：临时文件 + rename，不截断目标文件（写前照常备份旧内容）。
            write_json_atomic(&new_path, &new_value, true)?;
        } else {
            if let Some(parent) = new_path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("创建 {} 失败: {}", parent.display(), e))?;
            }
            std::fs::write(&new_path, &legacy)
                .map_err(|e| format!("写入 {} 失败: {}", new_path.display(), e))?;
        }
        // 备份原配置（仅当尚无备份；避免覆盖更早的真实备份）
        let backup = legacy_path.with_file_name("tigerAgent.json.migrated.bak");
        if !backup.exists() {
            std::fs::write(&backup, &legacy)
                .map_err(|e| format!("备份旧配置 {} 失败: {}", legacy_path.display(), e))?;
        }
        // 覆盖写占位，保证 EnsureDefaultConfig 不再重建默认配置
        std::fs::write(&legacy_path, format!("{{\"{}\": true}}\n", MIGRATED_MARKER))
            .map_err(|e| format!("写入占位 {} 失败: {}", legacy_path.display(), e))?;
        eprintln!("[Agent] 已迁移旧配置 {} → {}（旧位置写入占位）", legacy_path.display(), new_path.display());
        Ok(())
    })();
    if let Err(e) = result {
        eprintln!("[Agent] 迁移旧配置失败: {}", e);
    }
}

/// 进程内串行化对 tigerAgent.json 的「读-改-写」操作。
///
/// 只覆盖本进程：跨进程（与 Agent server 之间）的互斥由
/// [`acquire_config_lock`] 负责，两者在 [`update_agent_config`] 中组合使用。
/// 注意：std Mutex **不可重入** —— 调用方不得在持有本锁时再次进入。
static AGENT_CONFIG_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

// ============================================================================
// tigerAgent.json：跨进程互斥 + 原子落盘 + 统一写入入口
//
// 背景：本文件在 Windows 上与 Agent server（Go）的数据配置是同一个文件
// （%LOCALAPPDATA%/Agent/tigerAgent.json）。旧实现有三个致命缺陷：
//   1. std::fs::write 非原子（先截断），留下文件为 0 字节的窗口；
//   2. Go 侧读到空串时不报错，把空文档当新表，写回后只剩本次设置的字段；
//   3. 解析失败静默回退 build_agent_config()，整文件覆盖清空云端 provider。
// 三者叠加导致切换模型时 tigerAgent.json 被反复清空。
// ============================================================================

/// 与 Agent server（Go）共用同一把锁。
/// Go 侧 `ConfigStore.lockConfig` 用的是 `lock.File(path + ".lock")`，
/// 这里必须对**同一个文件**加锁才能做到跨进程互斥。
/// 锁范围与 Go 保持一致（0 .. u32::MAX），否则 Windows 上不会真正互斥。
fn agent_config_lock_path() -> Result<PathBuf, AppError> {
    Ok(agent_config_dir()?.join("tigerAgent.json.lock"))
}

/// 等待锁的最长时间。需大于 Go 侧的 configLockDeadline（5s）。
const CONFIG_LOCK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const CONFIG_LOCK_RETRY: std::time::Duration = std::time::Duration::from_millis(50);

/// 跨进程排他锁句柄，Drop 时自动解锁并关闭文件。
struct ConfigFileLock {
    file: std::fs::File,
}

#[cfg(windows)]
fn try_lock(file: &std::fs::File) -> Result<bool, AppError> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
    };
    use windows::Win32::System::IO::OVERLAPPED;

    // 锁范围与 Go 的 LockFileEx(0, MaxUint32, MaxUint32) 对齐，否则不互斥
    let mut ov = unsafe { std::mem::zeroed::<OVERLAPPED>() };
    let ok = unsafe {
        LockFileEx(
            HANDLE(file.as_raw_handle()),
            LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
            0,
            u32::MAX,
            u32::MAX,
            &mut ov,
        )
    };
    Ok(ok.is_ok())
}

#[cfg(unix)]
fn try_lock(file: &std::fs::File) -> Result<bool, AppError> {
    use std::os::unix::io::AsRawFd;
    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if rc == 0 {
        return Ok(true);
    }
    let e = std::io::Error::last_os_error();
    if e.raw_os_error() == Some(libc::EWOULDBLOCK) {
        return Ok(false);
    }
    Err(AppError::msg(format!("flock 失败: {}", e)))
}

#[cfg(windows)]
fn unlock(file: &std::fs::File) -> Result<(), AppError> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::UnlockFileEx;
    use windows::Win32::System::IO::OVERLAPPED;

    // UnlockFileEx 只按范围定位，offset 0 + 相同长度即可
    let mut ov = unsafe { std::mem::zeroed::<OVERLAPPED>() };
    unsafe { UnlockFileEx(HANDLE(file.as_raw_handle()), 0, u32::MAX, u32::MAX, &mut ov) }
        .map_err(|e| AppError::msg(format!("解锁 tigerAgent.json 失败: {}", e)))
}

#[cfg(unix)]
fn unlock(file: &std::fs::File) -> Result<(), AppError> {
    use std::os::unix::io::AsRawFd;
    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };
    if rc == 0 {
        Ok(())
    } else {
        Err(AppError::msg(format!(
            "解锁 tigerAgent.json 失败: {}",
            std::io::Error::last_os_error()
        )))
    }
}

impl Drop for ConfigFileLock {
    fn drop(&mut self) {
        let _ = unlock(&self.file);
    }
}

/// 获取跨进程排他锁，最多等待 [`CONFIG_LOCK_TIMEOUT`]。
fn acquire_config_lock() -> Result<ConfigFileLock, AppError> {
    let path = agent_config_lock_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {}", e))?;
    }
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false) // 锁文件只作 flock 载体，绝不能截断（可能有并发持有者）
        .open(&path)
        .map_err(|e| format!("打开锁文件失败: {}", e))?;

    let started = std::time::Instant::now();
    loop {
        if try_lock(&file)? {
            return Ok(ConfigFileLock { file });
        }
        if started.elapsed() > CONFIG_LOCK_TIMEOUT {
            return Err(AppError::msg("获取 tigerAgent.json 锁超时（10s）"));
        }
        std::thread::sleep(CONFIG_LOCK_RETRY);
    }
}

/// 原子落盘：写临时文件后 rename，**绝不在目标文件上截断**。
///
/// rename 是原子的，并发读者要么看到旧内容要么看到新内容，
/// 不可能看到空文件或半截 JSON —— 这正是旧实现的致命伤。
fn write_json_atomic(
    path: &std::path::Path,
    value: &serde_json::Value,
    keep_backup: bool,
) -> Result<(), AppError> {
    let json = serde_json::to_string_pretty(value)
        .map_err(|e| format!("序列化 Agent 配置失败: {}", e))?;

    let dir = path.parent().ok_or_else(|| AppError::msg("配置路径缺少父目录"))?;
    std::fs::create_dir_all(dir).map_err(|e| format!("创建配置目录失败: {}", e))?;

    // 写前备份：保留最近一份可用快照，便于人工回滚（失败不影响主流程）。
    // 从备份恢复时必须传 false —— 此时目标文件已损坏，复制会把唯一的好备份覆盖掉。
    if keep_backup {
        if let Ok(meta) = std::fs::metadata(path) {
            if meta.len() > 0 {
                // 原子复制：Agent server（Go）也在写同一个 .bak（同一把 flock，
                // 但读取方无锁），避免读者看到半截备份
                if let Err(e) = copy_file_atomic(path, &dir.join("tigerAgent.json.bak")) {
                    api_debug_log(|| format!("Config ! 写前备份失败: {}", e));
                }
            }
        }
    }

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = dir.join(format!("tigerAgent.json.{}.{}.tmp", std::process::id(), nanos));

    std::fs::write(&tmp, &json).map_err(|e| format!("写入临时配置失败: {}", e))?;
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(AppError::msg(format!("替换配置文件失败: {}", e)))
        }
    }
}

/// 对 tigerAgent.json 做一次完整的「加锁 → 读 → 改 → 原子写」。
///
/// 三层保护：
/// - 进程内串行：`AGENT_CONFIG_LOCK`
/// - 跨进程串行：flock `tigerAgent.json.lock`（与 Go server 同一把锁）
/// - 落盘原子：临时文件 + rename
///
/// 文件不存在时以 `{}` 起步；**文件存在但为空或 JSON 非法时一律返回错误**，
/// 绝不回退默认结构 —— 旧实现正是靠这个回退把用户的云端 provider 全清掉了。
///
/// `mutate` 必须是纯内存变换：内部不得再调用本函数（std Mutex 不可重入）。
fn update_agent_config<T>(
    mutate: impl FnOnce(&mut serde_json::Value) -> Result<T, AppError>,
) -> Result<T, AppError> {
    let _inproc = AGENT_CONFIG_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let _filelock = acquire_config_lock()?;

    let dir = agent_config_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {}", e))?;
    let path = dir.join("tigerAgent.json");

    let mut v = if path.exists() {
        let s = std::fs::read_to_string(&path)
            .map_err(|e| format!("读取 tigerAgent.json 失败: {}", e))?;
        if s.trim().is_empty() {
            let msg = "tigerAgent.json 为空，拒绝写入（可能有并发写正在截断文件）";
            notify_config_corrupt(msg);
            return Err(AppError::msg(msg));
        }
        serde_json::from_str::<serde_json::Value>(&s).map_err(|e| {
            let msg = format!("解析 tigerAgent.json 失败: {}", e);
            notify_config_corrupt(&msg);
            AppError::msg(msg)
        })?
    } else {
        serde_json::json!({})
    };

    let out = mutate(&mut v)?;
    write_json_atomic(&path, &v, true)?;
    // 改动后校验：落盘内容必须仍是合法 JSON（防御并发写 / 磁盘异常造成的损坏）。
    // 失败不自动回滚，统一交给损坏恢复流程：弹窗提示 → 用户确认 → 从备份恢复。
    if let Err(e) = read_config_json(&path) {
        let msg = format!("写入后校验失败: {}", e);
        notify_config_corrupt(&msg);
        return Err(AppError::msg(msg));
    }
    Ok(out)
}

// ===== tigerAgent.json 备份与损坏恢复 =====
// 目标：首次启动即保留一份可用备份；每次改动前自动备份（见 write_json_atomic）；
// 检测到损坏时弹原生提示，用户确认后自动从备份恢复并触发服务端重载。

/// 恢复流程使用的 AppHandle（setup 阶段写入；未初始化时所有提示静默跳过）
static CONFIG_RECOVERY_APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();
/// 恢复提示是否正在展示（并发检测只弹一个对话框）
static CONFIG_PROMPT_ACTIVE: AtomicBool = AtomicBool::new(false);
/// 用户本次会话选择「暂不恢复」（不再重复弹窗骚扰）
static CONFIG_PROMPT_DECLINED: AtomicBool = AtomicBool::new(false);

/// tigerAgent.json 主文件与备份文件的完整路径
fn agent_config_file_paths() -> Result<(PathBuf, PathBuf), AppError> {
    let dir = agent_config_dir()?;
    Ok((dir.join("tigerAgent.json"), dir.join("tigerAgent.json.bak")))
}

/// 读取并校验一份配置：非空且必须是合法 JSON
fn read_config_json(path: &std::path::Path) -> Result<serde_json::Value, String> {
    let s = std::fs::read_to_string(path)
        .map_err(|e| format!("读取 {} 失败: {}", path.display(), e))?;
    if s.trim().is_empty() {
        return Err(format!("{} 为空", path.display()));
    }
    serde_json::from_str::<serde_json::Value>(&s)
        .map_err(|e| format!("解析 {} 失败: {}", path.display(), e))
}

/// 读取可用备份；不存在 / 为空 / 非法 JSON 一律视为不可用
fn read_valid_backup() -> Result<serde_json::Value, String> {
    let (_, bak) = agent_config_file_paths().map_err(|e| e.to_string())?;
    if !bak.exists() {
        return Err(format!("未找到备份文件 {}", bak.display()));
    }
    read_config_json(&bak)
}

/// 原子复制文件（先写临时文件再 rename），避免留下半截备份
fn copy_file_atomic(src: &std::path::Path, dst: &std::path::Path) -> Result<(), AppError> {
    let dir = dst.parent().ok_or_else(|| AppError::msg("备份路径缺少父目录"))?;
    std::fs::create_dir_all(dir).map_err(|e| format!("创建配置目录失败: {}", e))?;
    let name = dst
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "tigerAgent.json.bak".to_string());
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = dir.join(format!("{}.{}.{}.tmp", name, std::process::id(), nanos));
    std::fs::copy(src, &tmp).map_err(|e| format!("复制备份失败: {}", e))?;
    match std::fs::rename(&tmp, dst) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(AppError::msg(format!("替换备份失败: {}", e)))
        }
    }
}

/// 首次启动备份：主文件有效、且备份缺失或已损坏时，用当前配置创建 .bak。
/// 已有有效备份时不覆盖 —— 它是上一份可用快照，损坏恢复依赖它。
fn ensure_agent_config_backup() {
    let (main, bak) = match agent_config_file_paths() {
        Ok(p) => p,
        Err(_) => return,
    };
    if !main.exists() || read_config_json(&main).is_err() {
        return; // 主文件缺失/已损坏：保留现有备份供恢复使用
    }
    if bak.exists() && read_config_json(&bak).is_ok() {
        return;
    }
    match copy_file_atomic(&main, &bak) {
        Ok(()) => api_debug_log(|| "Config: 已创建 tigerAgent.json 首次启动备份".to_string()),
        Err(e) => api_debug_log(|| format!("Config ! 创建 tigerAgent.json 备份失败: {}", e)),
    }
}

/// 检测主配置是否损坏；损坏时走统一的恢复提示（正常时静默）
fn check_agent_config_corruption() {
    let (main, _) = match agent_config_file_paths() {
        Ok(p) => p,
        Err(_) => return,
    };
    if !main.exists() {
        return;
    }
    if let Err(e) = read_config_json(&main) {
        notify_config_corrupt(&e);
    }
}

/// 启动时初始化配置备份与损坏恢复：
/// 1) 首次启动备份（主文件有效且备份缺失/损坏时创建 .bak）；
/// 2) 延时等主窗口显示后检测主文件，损坏则弹恢复提示。
pub fn init_agent_config_recovery(app: &tauri::AppHandle) {
    let _ = CONFIG_RECOVERY_APP.set(app.clone());
    tauri::async_runtime::spawn(async move {
        ensure_agent_config_backup();
        // 稍等主窗口渲染完成再弹窗，避免对话框早于界面出现
        tokio::time::sleep(Duration::from_millis(1200)).await;
        check_agent_config_corruption();
    });
}

/// 检测到 tigerAgent.json 损坏时弹出原生提示（每次会话最多一次）：
/// - 备份可用：询问是否恢复；确认后自动恢复并触发服务端重载，再 emit
///   `agent-config-restored` 通知前端（服务未起来时前端会重跑 init）；
/// - 备份不可用：仅提示文件路径，引导手动处理，不自动改动文件。
fn notify_config_corrupt(detail: &str) {
    let app = match CONFIG_RECOVERY_APP.get() {
        Some(a) => a.clone(),
        None => return, // setup 之前的早期检测：由启动检查负责提示
    };
    if CONFIG_PROMPT_DECLINED.load(Ordering::Relaxed) {
        return;
    }
    if CONFIG_PROMPT_ACTIVE.swap(true, Ordering::SeqCst) {
        return; // 已有提示在展示
    }

    api_debug_log(|| format!("Config ! tigerAgent.json 异常: {}", detail));
    let main_path = agent_config_file_paths()
        .map(|(m, _)| m.display().to_string())
        .unwrap_or_default();

    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    match read_valid_backup() {
        Ok(_) => {
            app.dialog()
                .message(format!(
                    "检测到 Agent 配置文件异常，无法读取：\n{}\n\n文件：{}\n\n是否从备份恢复？恢复后会自动重新加载服务配置。",
                    detail, main_path
                ))
                .title("Agent 配置文件异常")
                .kind(MessageDialogKind::Error)
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "恢复备份".to_string(),
                    "暂不恢复".to_string(),
                ))
                .show(move |confirmed| {
                    CONFIG_PROMPT_ACTIVE.store(false, Ordering::SeqCst);
                    if !confirmed {
                        CONFIG_PROMPT_DECLINED.store(true, Ordering::SeqCst);
                        api_debug_log(|| "Config: 用户选择暂不恢复".to_string());
                        return;
                    }
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        match restore_agent_config_from_backup(&app) {
                            Ok(()) => {
                                api_debug_log(|| "Config: 已从备份恢复 tigerAgent.json，触发服务端重载".to_string());
                                let _ = app.emit("agent-config-restored", serde_json::json!({ "ok": true }));
                            }
                            Err(e) => {
                                api_debug_log(|| format!("Config ! 从备份恢复失败: {}", e));
                                let _ = app.emit(
                                    "agent-config-restored",
                                    serde_json::json!({ "ok": false, "error": e.to_string() }),
                                );
                            }
                        }
                    });
                });
        }
        Err(reason) => {
            app.dialog()
                .message(format!(
                    "检测到 Agent 配置文件异常，无法读取：\n{}\n\n备份不可用：{}\n\n请手动检查或删除该文件后重启 Tiger（删除会丢失其中保存的云端模型配置）：\n{}",
                    detail, reason, main_path
                ))
                .title("Agent 配置文件异常")
                .kind(MessageDialogKind::Error)
                .buttons(MessageDialogButtons::Ok)
                .show(move |_| {
                    CONFIG_PROMPT_ACTIVE.store(false, Ordering::SeqCst);
                    CONFIG_PROMPT_DECLINED.store(true, Ordering::SeqCst);
                });
        }
    }
}

/// 从备份恢复 tigerAgent.json（原子写），并触发服务端从磁盘全量重载。
/// 不走 update_agent_config：当前主文件已损坏，其写前备份会把唯一的好备份覆盖掉。
fn restore_agent_config_from_backup(app: &tauri::AppHandle) -> Result<(), AppError> {
    let (main, _) = agent_config_file_paths()?;
    // 与常规写入共用同一把进程内/跨进程锁，避免与并发写互相踩踏；
    // 先加锁再读备份：Go/Rust 都会在写前重写 .bak，无锁读可能读到半截文件
    let _inproc = AGENT_CONFIG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _filelock = acquire_config_lock()?;
    let value = read_valid_backup().map_err(AppError::msg)?;
    write_json_atomic(&main, &value, false)?;
    request_server_config_reload(app);
    Ok(())
}

/// 取当前激活 workspace id；无激活 tab（或为空）时返回 None。
pub(crate) fn active_workspace_id(app: &tauri::AppHandle) -> Option<String> {
    let state = app.state::<AppState>();
    let active = state.active_workspace_id.lock().map(|g| g.clone()).unwrap_or(None);
    active.filter(|id| !id.is_empty())
}

/// 构建指向当前服务端目标的共享 client（复用连接池；未配置服务端时返回 None）。
fn agent_local_client() -> Option<agent_http::AgentHttpClient> {
    let target = agent_http::active_target()?;
    agent_http::shared_client(&target, Duration::from_secs(5)).ok()
}

/// POST /config/set 写一个无害标量，触发服务端写盘并从磁盘全量重载配置
/// （服务端只在启动时读配置，SetConfigField 是唯一的热重载入口）。
/// `tag` 只用于日志前缀（`Config` / `Tools` / `SyncCaps`）。失败仅记日志并返回 false。
async fn post_config_reload(
    client: &agent_http::AgentHttpClient,
    workspace_id: &str,
    tag: &str,
) -> bool {
    let set_body = serde_json::json!({ "scope": 0, "key": "providers.local.name", "value": "Local" });
    match tokio::time::timeout(
        Duration::from_secs(10),
        agent_http::send(client, "POST", &format!("/v1/workspaces/{}/config/set", workspace_id), Some(set_body)),
    )
    .await
    {
        Ok(Ok((st, _))) if (200..300).contains(&st) => {
            api_debug_log(|| format!("{}: /config/set 热重载完成", tag));
            true
        }
        Ok(Ok((st, _))) => {
            api_debug_log(|| format!("{} ! /config/set HTTP {}", tag, st));
            false
        }
        Ok(Err(e)) => {
            api_debug_log(|| format!("{} ! /config/set 失败: {}", tag, e));
            false
        }
        Err(_) => {
            api_debug_log(|| format!("{} ! /config/set 超时", tag));
            false
        }
    }
}

/// POST /agent/update 重建 coordinator 内的 agent（工具集与模型配置随之刷新）。
/// 配置重载本身只换配置对象，工具集是 buildTools 时构建的，因此需要它新设置才即时生效；
/// agent 未 init 时报错属正常（init 时自然读到新配置）。失败仅记日志并返回 false。
async fn post_agent_update(
    client: &agent_http::AgentHttpClient,
    workspace_id: &str,
    tag: &str,
) -> bool {
    let update_url = format!("/v1/workspaces/{}/agent/update", workspace_id);
    match tokio::time::timeout(
        Duration::from_secs(10),
        agent_http::send(client, "POST", &update_url, Some(serde_json::json!({}))),
    )
    .await
    {
        Ok(Ok((st, _))) if (200..300).contains(&st) => {
            api_debug_log(|| format!("{}: /agent/update 完成", tag));
            true
        }
        Ok(Ok((st, _))) => {
            api_debug_log(|| format!("{} ! /agent/update HTTP {}", tag, st));
            false
        }
        Ok(Err(e)) => {
            api_debug_log(|| format!("{} ! /agent/update 失败: {}", tag, e));
            false
        }
        Err(_) => {
            api_debug_log(|| format!("{} ! /agent/update 超时", tag));
            false
        }
    }
}

/// 请求 Agent server 从磁盘全量重载配置（POST /config/set 写一个无害标量触发）。
/// 服务未运行 / 无活跃工作区时静默跳过 —— 下次启动会自然读到新配置。
/// 失败仅记日志：重载不生效只是沿用旧配置，不影响主流程。
fn request_server_config_reload(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let ws = match active_workspace_id(&app) {
            Some(ws) => ws,
            None => {
                api_debug_log(|| "Config: 无活跃工作区，跳过服务端配置重载".to_string());
                return;
            }
        };
        let client = match agent_local_client() {
            Some(c) => c,
            None => return,
        };
        post_config_reload(&client, &ws, "Config").await;
    });
}

// ===== 服务端设置（桌面端不再写本机 tigerAgent.json）=====
//
// 远程部署下桌面端与 Agent server 不在同一台机器：写本机 tigerAgent.json 再让
// 服务端"从磁盘重载"，服务端只会读到它自己那份旧配置，代理 / vision / 工具开关
// 全部静默失效。所有影响 Agent 行为的配置一律 POST /v1/settings。

/// 内置多模态模型：Agent 的图片后端池向外部只暴露一个显示模型（服务端 DisplayModelName）。
const BUILTIN_VISION_PROVIDER: &str = "tigerAgent";
const BUILTIN_VISION_MODEL: &str = "agent-models";

/// 读取服务端脱敏设置视图（GET /v1/settings）。
async fn fetch_server_settings() -> Result<serde_json::Value, AppError> {
    let client = agent_local_client().ok_or_else(|| AppError::msg("未连接服务端"))?;
    let (status, body) = tokio::time::timeout(
        Duration::from_secs(10),
        agent_http::send(&client, "GET", "/v1/settings", None),
    )
    .await
    .map_err(|_| AppError::msg("读取设置超时：服务端无响应"))?
    .map_err(|e| AppError::msg(format!("读取设置失败: {}", e)))?;
    if !(200..300).contains(&status) {
        bail!("读取设置失败: HTTP {}（服务端版本可能过低，请升级服务端）", status);
    }
    serde_json::from_slice(&body).map_err(|e| AppError::msg(format!("解析设置响应失败: {}", e)))
}

/// 把设置补丁 POST 到服务端（POST /v1/settings），返回落盘后的视图。
async fn send_server_settings(patch: serde_json::Value) -> Result<serde_json::Value, AppError> {
    let client = agent_local_client()
        .ok_or_else(|| AppError::msg("未连接服务端：请先在「服务端连接」中完成配置"))?;
    let (status, body) = tokio::time::timeout(
        Duration::from_secs(15),
        agent_http::send(&client, "POST", "/v1/settings", Some(patch)),
    )
    .await
    .map_err(|_| AppError::msg("保存设置超时：服务端无响应"))?
    .map_err(|e| AppError::msg(format!("保存设置失败: {}", e)))?;
    if !(200..300).contains(&status) {
        let message = serde_json::from_slice::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(|s| s.to_string()))
            .unwrap_or_else(|| format!("HTTP {}", status));
        bail!("保存设置失败: {}", message);
    }
    serde_json::from_slice(&body).map_err(|e| AppError::msg(format!("解析设置响应失败: {}", e)))
}

/// 前端显式保存服务端设置（设置 → 网络代理等）：错误直接回传 UI，不再静默。
#[tauri::command]
pub async fn apply_server_settings(
    app: tauri::AppHandle,
    patch: serde_json::Value,
) -> Result<serde_json::Value, AppError> {
    let view = send_server_settings(patch).await?;
    rebuild_agent_after_settings(&app).await;
    Ok(view)
}

/// 读取服务端设置视图（前端展示服务端当前值用）。
#[tauri::command]
pub async fn get_server_settings() -> Result<serde_json::Value, AppError> {
    fetch_server_settings().await
}

/// bash_allow_all / project_memory_sync / vision 都在 agent 构造期读取，
/// 配置落盘后重建一次，避免「保存成功但仍按旧开关运行」。
async fn rebuild_agent_after_settings(app: &tauri::AppHandle) {
    let (Some(ws), Some(client)) = (active_workspace_id(app), agent_local_client()) else {
        return;
    };
    post_agent_update(&client, &ws, "Settings").await;
}

/// 把本地 config.json 里的 Agent 设置（代理 / 多模态模型 / 两个开关）推送到服务端。
/// 保存本地偏好时顺带调用；失败只记日志（对应面板本身用 apply_server_settings
/// 保存时会拿到明确错误）。
///
/// 分三次推送：服务端对 agent_vision_model 做 supports_images 校验并整批拒绝，
/// 合成一个 patch 时 vision 校验失败会把代理 / 工具开关一起丢掉，用户看到
/// “保存成功但没生效”。
pub fn push_agent_settings(app: &tauri::AppHandle, settings: &crate::common::types::Settings) {
    let (provider, model) = match settings.agent_vision_model.split_once('/') {
        Some((p, m)) if !p.is_empty() && !m.is_empty() => (p.to_string(), m.to_string()),
        _ => (BUILTIN_VISION_PROVIDER.to_string(), BUILTIN_VISION_MODEL.to_string()),
    };
    let patches: [(&str, serde_json::Value); 3] = [
        (
            "agent_proxy",
            serde_json::json!({
                "agent_proxy": { "enabled": settings.agent_proxy.enabled, "url": settings.agent_proxy.url },
            }),
        ),
        (
            "agent_vision_model",
            serde_json::json!({
                "agent_vision_model": { "provider": provider, "model": model },
            }),
        ),
        (
            "options",
            serde_json::json!({
                "options": {
                    "bash_allow_all": settings.agent_allow_all_tools,
                    "project_memory_sync": settings.agent_project_memory_sync.unwrap_or(true),
                },
            }),
        ),
    ];
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut applied = false;
        for (name, patch) in patches {
            match send_server_settings(patch).await {
                Ok(_) => applied = true,
                Err(e) => api_debug_log(|| format!("Settings ! 推送 {} 失败: {}", name, e)),
            }
        }
        if applied {
            api_debug_log(|| "Settings: 已推送到服务端".to_string());
            rebuild_agent_after_settings(&app).await;
        }
    });
}

/// 把 agent_vision_model 写入 tigerAgent.json 顶层（缺省回退内置 agent-models）。
/// 校验目标模型在 providers 中声明 supports_images=true，否则回退内置。
/// 返回是否真的发生了变更（供调用方决定是否触发服务端重载）。
///
/// 生产路径已改走服务端 POST /v1/settings，这里只被下方的配置迁移回归用例使用。
#[allow(dead_code)]
fn write_agent_vision_model(value: &str) -> Result<bool, AppError> {
    let (provider, model) = match value.split_once('/') {
        Some((p, m)) if !p.is_empty() && !m.is_empty() => (p.to_string(), m.to_string()),
        _ => (BUILTIN_VISION_PROVIDER.to_string(), BUILTIN_VISION_MODEL.to_string()),
    };
    update_agent_config(move |config| {
        // 校验：模型必须在某个 provider 的 models 中声明 supports_images=true，否则回退内置
        let (final_provider, final_model) = if model_supports_images_in_config(&*config, &provider, &model) {
            (provider.clone(), model.clone())
        } else {
            (BUILTIN_VISION_PROVIDER.to_string(), BUILTIN_VISION_MODEL.to_string())
        };

        let final_target = serde_json::json!({ "provider": final_provider, "model": final_model });
        if config.get("agent_vision_model") == Some(&final_target) {
            return Ok(false);
        }
        config["agent_vision_model"] = final_target;
        Ok(true)
    })
}

/// 检查指定 provider/model 是否在 tigerAgent.json 的 providers 中声明 supports_images=true。
/// Agent 是内置 provider（模型 agent-models），不在 providers 键中，需特殊处理。
///
/// 生产路径已改走服务端 POST /v1/settings，这里只被下方的配置迁移回归用例使用。
#[allow(dead_code)]
fn model_supports_images_in_config(config: &serde_json::Value, provider: &str, model: &str) -> bool {
    // Agent 是内置 provider，其模型（agent-models）支持图片
    if provider == BUILTIN_VISION_PROVIDER {
        return model == BUILTIN_VISION_MODEL;
    }
    if let Some(providers) = config.get("providers").and_then(|p| p.as_object()) {
        for (key, pc) in providers {
            if key != provider {
                continue;
            }
            if let Some(models) = pc.as_object().and_then(|p| p.get("models").and_then(|m| m.as_array())) {
                return models.iter().any(|m| {
                    m.as_object()
                        .and_then(|mo| {
                            mo.get("id").and_then(|id| id.as_str()).map(|id| {
                                id == model && mo.get("supports_images").and_then(|s| s.as_bool()).unwrap_or(false)
                            })
                        })
                        .unwrap_or(false)
                });
            }
        }
    }
    false
}

// ===== 一次性迁移：本机旧 tigerAgent.json → 服务端 =====
//
// 桌面端历史上把 provider / MCP / 代理等写在本机 tigerAgent.json。改成服务端
// 存储后，首次连接时给用户一次显式导入机会；导入完成后本机文件打标记、只读。

/// 读取本机 tigerAgent.json（只读）。缺失/空/解析失败都返回 None，不阻断启动。
fn read_local_agent_config() -> Result<Option<serde_json::Value>, AppError> {
    let dir = agent_config_dir()?;
    let path = dir.join("tigerAgent.json");
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| AppError::msg(format!("读取本机 tigerAgent.json 失败: {}", e)))?;
    if raw.trim().is_empty() {
        return Ok(None);
    }
    match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(value) => Ok(Some(value)),
        Err(e) => {
            api_debug_log(|| format!("Migrate: 本机 tigerAgent.json 解析失败: {}", e));
            Ok(None)
        }
    }
}

/// 配置迁移摘要：前端据此决定是否展示「导入本机旧配置」。
#[tauri::command]
pub async fn local_agent_config_diff() -> Result<serde_json::Value, AppError> {
    let Some(config) = read_local_agent_config()? else {
        return Ok(serde_json::json!({ "available": false }));
    };
    if config
        .get("__migrated_to_server")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return Ok(serde_json::json!({ "available": false }));
    }
    let providers = config
        .get("providers")
        .and_then(|p| p.as_object())
        .map(|map| map.keys().filter(|k| k.as_str() != "local").count())
        .unwrap_or(0);
    let mcp = config
        .get("mcp")
        .and_then(|m| m.as_object())
        .map(|map| map.len())
        .unwrap_or(0);
    let has_proxy = config.get("agent_proxy").is_some();
    let has_vision = config.get("agent_vision_model").is_some();
    let has_flags = config
        .get("options")
        .and_then(|o| o.as_object())
        .map(|opts| opts.contains_key("bash_allow_all") || opts.contains_key("project_memory_sync"))
        .unwrap_or(false);
    let available = providers > 0 || mcp > 0 || has_proxy || has_vision || has_flags;
    Ok(serde_json::json!({
        "available": available,
        "providers": providers,
        "mcp": mcp,
        "agent_proxy": has_proxy,
        "agent_vision_model": has_vision,
        "options": has_flags,
    }))
}

/// 把本机旧配置中的服务端相关字段一次性推送到服务端（POST /v1/settings），
/// 成功后在本机文件写入 `__migrated_to_server`，此后本机文件不再作为配置来源。
/// 工作目录不迁移：本机路径与服务端路径通常不是一套，导入必然校验失败。
#[tauri::command]
pub async fn import_local_agent_config() -> Result<serde_json::Value, AppError> {
    let Some(config) = read_local_agent_config()? else {
        bail!("本机没有可迁移的 tigerAgent.json");
    };
    let mut patch = serde_json::Map::new();

    if let Some(proxy) = config.get("agent_proxy") {
        patch.insert("agent_proxy".to_string(), proxy.clone());
    }
    if let Some(vision) = config.get("agent_vision_model") {
        let has_provider = vision.get("provider").and_then(|v| v.as_str()).is_some();
        let has_model = vision.get("model").and_then(|v| v.as_str()).is_some();
        if has_provider && has_model {
            patch.insert("agent_vision_model".to_string(), vision.clone());
        }
    }
    if let Some(options) = config.get("options").and_then(|o| o.as_object()) {
        let mut flags = serde_json::Map::new();
        for key in ["bash_allow_all", "project_memory_sync"] {
            if let Some(value) = options.get(key) {
                flags.insert(key.to_string(), value.clone());
            }
        }
        if !flags.is_empty() {
            patch.insert("options".to_string(), serde_json::Value::Object(flags));
        }
    }
    if let Some(providers) = config.get("providers").and_then(|p| p.as_object()) {
        let filtered: serde_json::Map<String, serde_json::Value> = providers
            .iter()
            .filter(|(key, _)| key.as_str() != "local")
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        if !filtered.is_empty() {
            patch.insert("providers".to_string(), serde_json::Value::Object(filtered));
        }
    }
    if let Some(mcp) = config.get("mcp").and_then(|m| m.as_object()) {
        if !mcp.is_empty() {
            patch.insert("mcp".to_string(), serde_json::Value::Object(mcp.clone()));
        }
    }
    if patch.is_empty() {
        bail!("本机配置中没有需要迁移的内容");
    }

    let view = send_server_settings(serde_json::Value::Object(patch)).await?;

    // 打标记：迁移完成后本机文件只读（保留供人工回滚）。
    let marked = update_agent_config(|config| {
        if let Some(root) = config.as_object_mut() {
            root.insert("__migrated_to_server".to_string(), serde_json::json!(true));
        }
        Ok(())
    });
    if let Err(e) = marked {
        api_debug_log(|| format!("Migrate ! 标记本机配置失败: {}", e));
    }
    api_debug_log(|| "Migrate: 本机配置已导入服务端".to_string());
    Ok(view)
}

// ===== 添加云端模型 Provider =====

/// 把一个云端模型名称转成 tigerAgent.json providers 下的 JSON key（仅保留 ASCII 字母数字，转小写）。
/// 例如 "Xiaomi MiMo" -> "xiaomimimo"。空名称回退为 "cloud"。
fn slugify_provider_key(name: &str) -> String {
    let mut s: String = name
        .chars()
        .filter_map(|c| {
            if c.is_ascii_alphanumeric() {
                Some(c.to_ascii_lowercase())
            } else {
                None
            }
        })
        .collect();
    if s.is_empty() {
        s = "cloud".to_string();
    }
    s
}

/// 把一个云端模型名称转成 model id：转小写，空格/下划线/连字符替换为 '-'，
/// 保留点号（'.'）以与名称保持一致（例如 "MiMo v2.5" -> "mimo-v2.5"），
/// 去掉其它标点，去重首尾连字符。空名称回退为 "model"。
fn slugify_model_id(name: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() || c == '.' {
            out.push(c.to_ascii_lowercase());
            prev_dash = false;
        } else if (c.is_whitespace() || c == '-' || c == '_') && !out.is_empty() && !prev_dash {
            out.push('-');
            prev_dash = true;
        }
        // 其它标点（如中文、括号等）直接忽略
    }
    while out.ends_with('-') || out.ends_with('.') {
        out.pop();
    }
    if out.is_empty() {
        out = "model".to_string();
    }
    out
}

/// 前端提交的新增云端模型参数
#[derive(Deserialize)]
pub struct CloudProviderInput {
    /// 模型名称（同时作为 provider 的展示名与 model 的 name，原样写入、区分大小写）
    pub name: String,
    /// API base_url，例如 https://api.xiaomimimo.com/v1
    pub base_url: String,
    /// API Key
    pub api_key: String,
    /// 上下文大小（tokens）。例如 256000（即 256K）
    pub context_window: u32,
    /// 用户填写的模型ID（必填，仅去首尾空白后原样写入、区分大小写）
    #[serde(default)]
    pub model_id: Option<String>,
    /// 是否支持图片输入（视觉模型），默认 false
    #[serde(default)]
    pub supports_images: bool,
    /// 是否开启思考模式（thinking mode）。为 true 时写入
    /// models[0].can_reason / reasoning_levels / default_reasoning_effort，
    /// 服务端会发送 reasoning_effort 并强制遵守 reasoning_content 回传规则；默认 false
    #[serde(default)]
    pub can_reason: bool,
}

/// 提取用户填写的模型ID：仅去首尾空白，不做任何大小写/字符转换（严格按用户填写写入）。
/// 为空时报错，不再静默从名称派生小写 id（历史派生逻辑曾把 MiniMax 等厂商的
/// 大小写敏感模型ID小写化，导致请求 400）。
fn require_model_id(model_id: &Option<String>) -> Result<String, AppError> {
    match model_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => Ok(s.to_string()),
        None => bail!("模型ID不能为空"),
    }
}

/// 新增一个云端模型 Provider 到 tigerAgent.json 的 `providers` 分支下。
///
/// - 文件已存在则解析并尽量保留其它字段；不存在则用完整默认结构。
/// - 以模型名称派生 provider key；模型ID与名称严格按用户填写写入（区分大小写），
///   插入（或覆盖同名）`providers[key]`。
/// - 写入采用原子方式（临时文件 + rename）。
///
/// 返回新增的 provider key，供前端提示。
#[tauri::command]
pub async fn add_cloud_provider(
    _app: tauri::AppHandle,
    input: CloudProviderInput,
) -> Result<serde_json::Value, AppError> {
    // 1) 派生 provider key（仅作 JSON 内部键）；模型ID/名称原样写入，区分大小写
    let key = slugify_provider_key(&input.name);
    let model_id = require_model_id(&input.model_id)?;

    // 开启思考模式时补充推理档位元数据，服务端 effectiveReasoningEffort
    // 才能解析出具体档位（与内置远程池模型保持一致）
    let (can_reason, reasoning_levels, default_reasoning_effort) = if input.can_reason {
        (
            serde_json::json!(true),
            serde_json::json!(["low", "medium", "high"]),
            serde_json::json!("medium"),
        )
    } else {
        (serde_json::json!(false), serde_json::Value::Null, serde_json::Value::Null)
    };

    let provider = serde_json::json!({
        "name": input.name,
        "base_url": input.base_url,
        "type": "openai-compat",
        "api_key": input.api_key,
        "models": [
            {
                "id": model_id,
                "name": input.name,
                "ctx_size": input.context_window,
                "context_window": input.context_window,
                "supports_images": input.supports_images,
                "can_reason": can_reason,
                "reasoning_levels": reasoning_levels,
                "default_reasoning_effort": default_reasoning_effort
            }
        ]
    });

    // 3) 落到服务端（桌面端不再写本机 tigerAgent.json）
    let mut providers = serde_json::Map::new();
    providers.insert(key.clone(), provider);
    send_server_settings(serde_json::json!({ "providers": providers })).await?;

    Ok(serde_json::json!({ "key": key, "success": true }))
}

/// 模型管理弹窗中展示的 provider 视图（脱敏无关，api_key 一并返回以便编辑回填）
#[derive(Serialize)]
pub struct CloudProviderView {
    pub key: String,
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    /// 服务端是否已保存 API key（api_key 恒为空串，留空编辑 = 保留原值）
    pub has_key: bool,
    pub context_window: u32,
    /// models[0].id，供前端调用服务端 `/config/model` 切换模型时使用
    pub model_id: String,
    /// models[0].supports_images，是否支持图片输入
    pub supports_images: bool,
    /// models[0].can_reason，是否开启思考模式
    pub can_reason: bool,
}

/// 列出服务端设置中已添加的全部云端模型 Provider（排除自动管理的 `local`
/// 与服务端内置的 `tigerAgent`）。返回每项的关键信息，供前端列表展示与编辑回填。
#[tauri::command]
pub async fn list_cloud_providers(
    _app: tauri::AppHandle,
) -> Result<Vec<CloudProviderView>, AppError> {
    let view = fetch_server_settings().await?;
    Ok(cloud_providers_from_settings(&view))
}

/// 把 GET /v1/settings 的 providers 数组映射成前端视图。
/// api_key 始终为空：服务端只回传掩码，编辑时留空即保留原 key。
fn cloud_providers_from_settings(view: &serde_json::Value) -> Vec<CloudProviderView> {
    let mut out: Vec<CloudProviderView> = vec![];
    let Some(list) = view.get("providers").and_then(|p| p.as_array()) else {
        return out;
    };
    for provider in list {
        let Some(key) = provider.get("key").and_then(|k| k.as_str()) else {
            continue;
        };
        // 跳过自动生成的本地 provider（非用户添加）
        if key == "local" {
            continue;
        }
        // 跳过服务端内置 provider（tigerAgent/agent-models）：没有 base_url/api_key，
        // 由服务端后端池提供，只需经 /providers 快照进入模型下拉供选择，
        // 不属于用户可编辑/删除的云端模型列表（误列会让发送前的 Base URL 校验误报）
        if key == BUILTIN_VISION_PROVIDER {
            continue;
        }
        let name = provider
            .get("name")
            .and_then(|n| n.as_str())
            .unwrap_or(key)
            .to_string();
        let first_model = provider
            .get("models")
            .and_then(|m| m.as_array())
            .and_then(|m| m.first());
        out.push(CloudProviderView {
            key: key.to_string(),
            name: name.clone(),
            base_url: provider
                .get("base_url")
                .and_then(|b| b.as_str())
                .unwrap_or("")
                .to_string(),
            api_key: String::new(),
            has_key: provider.get("has_key").and_then(|v| v.as_bool()).unwrap_or(false),
            context_window: first_model
                .and_then(|m| m.get("context_window"))
                .and_then(|c| c.as_u64())
                .unwrap_or(0) as u32,
            model_id: first_model
                .and_then(|m| m.get("id"))
                .and_then(|i| i.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| slugify_model_id(&name)),
            supports_images: first_model
                .and_then(|m| m.get("supports_images"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            can_reason: first_model
                .and_then(|m| m.get("can_reason"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
        });
    }
    out.sort_by(|a, b| a.key.cmp(&b.key));
    out
}

/// 从全局 `recent_models` 中剔除指向指定 provider 的历史条目，返回剔除条数。
///
/// 该字段是 TUI/桌面端「最近使用」的数据源，只在切换模型时由服务端追加，删除
/// provider 不会级联清理，留着会在配置里长期残留已失效的模型。列表被清空时直接
/// 删掉字段，与服务端 `omitempty` 的写回语义一致（避免留下 `recent_models: []`）。
#[allow(dead_code)]
fn prune_recent_models_for_provider(config: &mut serde_json::Value, provider_key: &str) -> usize {
    let mut removed = 0;
    let mut emptied = false;
    if let Some(list) = config
        .get_mut("recent_models")
        .and_then(|v| v.as_array_mut())
    {
        let before = list.len();
        list.retain(|item| item.get("provider").and_then(|p| p.as_str()) != Some(provider_key));
        removed = before - list.len();
        emptied = list.is_empty();
    }
    if emptied {
        if let Some(root) = config.as_object_mut() {
            root.remove("recent_models");
        }
    }
    removed
}

/// 从 `providers` 分支移除指定 key，并顺带清掉 `recent_models` 中指向它的历史
/// 条目，返回被剔除的最近使用条数。
///
/// 生产路径已改走服务端 `POST /v1/settings`（`remove_providers`），这里只被下方的
/// 配置迁移回归用例使用。
#[allow(dead_code)]
fn remove_provider_with_recent_models(
    config: &mut serde_json::Value,
    key: &str,
) -> Result<usize, AppError> {
    let providers = config
        .get_mut("providers")
        .and_then(|p| p.as_object_mut())
        .ok_or_else(|| AppError::msg("tigerAgent.json 结构异常：缺少 providers"))?;

    if providers.remove(key).is_none() {
        return Err(AppError::msg(format!("未找到 provider: {}", key)));
    }

    Ok(prune_recent_models_for_provider(config, key))
}

/// 删除指定 key 的云端模型 Provider。
/// 按 key 定位并从 tigerAgent.json 的 providers 分支中移除，原子写入；同一次写入里
/// 顺带清掉 `recent_models` 中指向该 provider 的历史条目。
#[tauri::command]
pub async fn delete_cloud_provider(
    _app: tauri::AppHandle,
    key: String,
) -> Result<serde_json::Value, AppError> {
    send_server_settings(serde_json::json!({ "remove_providers": [key] })).await?;
    Ok(serde_json::json!({ "key": key, "success": true, "removed_recent": 0 }))
}

/// 更新指定 key 的云端模型 Provider（按 key 定位，替换其全部参数）。
/// 模型ID与名称严格按用户填写写入（区分大小写）；保留同一 key 以免产生孤儿条目。
#[tauri::command]
pub async fn update_cloud_provider(
    _app: tauri::AppHandle,
    key: String,
    input: CloudProviderInput,
) -> Result<serde_json::Value, AppError> {
    let model_id = require_model_id(&input.model_id)?;
    // 开启思考模式时补充推理档位元数据，服务端 effectiveReasoningEffort
    // 才能解析出具体档位（与内置远程池模型保持一致）
    let (can_reason, reasoning_levels, default_reasoning_effort) = if input.can_reason {
        (
            serde_json::json!(true),
            serde_json::json!(["low", "medium", "high"]),
            serde_json::json!("medium"),
        )
    } else {
        (serde_json::json!(false), serde_json::Value::Null, serde_json::Value::Null)
    };
    let new_provider = serde_json::json!({
        "name": input.name,
        "base_url": input.base_url,
        "type": "openai-compat",
        "api_key": input.api_key,
        "models": [
            {
                "id": model_id,
                "name": input.name,
                "ctx_size": input.context_window,
                "context_window": input.context_window,
                "supports_images": input.supports_images,
                "can_reason": can_reason,
                "reasoning_levels": reasoning_levels,
                "default_reasoning_effort": default_reasoning_effort
            }
        ]
    });

    // 落到服务端（api_key 为空时服务端保留原值，便于「不重填 key」的编辑）
    let mut providers = serde_json::Map::new();
    providers.insert(key.clone(), new_provider);
    send_server_settings(serde_json::json!({ "providers": providers })).await?;

    Ok(serde_json::json!({ "key": key, "success": true }))
}

// ===== MCP 服务配置（tigerAgent.json 顶层 `mcp` 映射）=====
// 配置格式与 Go 端 config.MCPConfig 对齐：
// {
//   "mcp": {
//     "filesystem": { "type": "stdio", "command": "npx", "args": ["-y", "..."], "env": { "K": "V" } },
//     "remote":     { "type": "http",  "url": "https://...", "headers": { "K": "V" } }
//   }
// }
// 注意：Agent server 只在启动时初始化 MCP 客户端，新增/修改后需重启 server
// 才会建立连接（/config/set 只触发配置内存重载，不重建 MCP 会话）。

/// MCP 服务配置视图（同时作为前端提交结构，字段名与 tigerAgent.json 对齐）
#[derive(Serialize, Deserialize, Default)]
pub struct McpServerView {
    /// 服务名称（mcp 映射的 key）
    pub name: String,
    /// 传输类型：stdio / http / sse（缺省 stdio）
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// 环境变量（stdio）
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub url: String,
    /// 请求头（http/sse）
    #[serde(default)]
    pub headers: std::collections::BTreeMap<String, String>,
    /// 连接超时（秒），0 表示使用服务端默认值
    #[serde(default)]
    pub timeout: u32,
    #[serde(default)]
    pub disabled: bool,
}

/// MCP 配置的已知字段：更新时先剔除再由新值回填，其余未知字段
/// （enabled_tools / disabled_tools 等）原样保留，避免编辑弹窗丢数据。
#[allow(dead_code)]
const MCP_KNOWN_KEYS: [&str; 8] = ["type", "command", "args", "env", "url", "headers", "timeout", "disabled"];

/// 校验并归一化前端提交的 MCP 配置，返回 (名称, 类型)
fn validate_mcp_input(input: &McpServerView) -> Result<(String, String), AppError> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        bail!("MCP 名称不能为空");
    }
    if name.chars().count() > 64 {
        bail!("MCP 名称过长（最多 64 字符）");
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
    {
        bail!("MCP 名称只能包含字母、数字、下划线、连字符和点");
    }

    let kind = {
        let k = input.kind.trim().to_ascii_lowercase();
        if k.is_empty() { "stdio".to_string() } else { k }
    };
    if !matches!(kind.as_str(), "stdio" | "http" | "sse") {
        bail!("MCP 类型必须是 stdio / http / sse");
    }
    if kind == "stdio" {
        if input.command.trim().is_empty() {
            bail!("stdio 类型必须填写命令");
        }
    } else {
        let url = input.url.trim();
        if url.is_empty() {
            bail!("{} 类型必须填写 URL", kind);
        }
        if !url.starts_with("http://") && !url.starts_with("https://") {
            bail!("URL 必须以 http:// 或 https:// 开头");
        }
    }
    if input.timeout > 3600 {
        bail!("超时不能超过 3600 秒");
    }
    Ok((name, kind))
}

/// 把前端提交的配置转成写入 tigerAgent.json 的 JSON 对象（空字段省略，保持文件简洁）
fn mcp_config_value(input: &McpServerView, kind: &str) -> serde_json::Value {
    let mut obj = serde_json::Map::new();
    obj.insert("type".to_string(), serde_json::json!(kind));
    if kind == "stdio" {
        obj.insert("command".to_string(), serde_json::json!(input.command.trim()));
        let args: Vec<String> = input
            .args
            .iter()
            .map(|a| a.trim().to_string())
            .filter(|a| !a.is_empty())
            .collect();
        if !args.is_empty() {
            obj.insert("args".to_string(), serde_json::json!(args));
        }
        if !input.env.is_empty() {
            obj.insert("env".to_string(), serde_json::json!(input.env));
        }
    } else {
        obj.insert("url".to_string(), serde_json::json!(input.url.trim()));
        if !input.headers.is_empty() {
            obj.insert("headers".to_string(), serde_json::json!(input.headers));
        }
    }
    if input.timeout > 0 {
        obj.insert("timeout".to_string(), serde_json::json!(input.timeout));
    }
    if input.disabled {
        obj.insert("disabled".to_string(), serde_json::json!(true));
    }
    serde_json::Value::Object(obj)
}

/// 更新时合并到旧配置：已知字段用新值覆盖，未知字段保留
#[allow(dead_code)]
fn merge_mcp_config(existing: &serde_json::Value, new_value: serde_json::Value) -> serde_json::Value {
    let mut merged = existing.as_object().cloned().unwrap_or_default();
    for key in MCP_KNOWN_KEYS {
        merged.remove(key);
    }
    if let serde_json::Value::Object(new_obj) = new_value {
        for (k, v) in new_obj {
            merged.insert(k, v);
        }
    }
    serde_json::Value::Object(merged)
}

/// 从 tigerAgent.json 根值解析 mcp 映射为视图列表（按名称排序）。
///
/// 生产路径已改走服务端 `GET /v1/settings`（`mcp` 为数组），这里只被配置迁移
/// 回归用例使用。
#[allow(dead_code)]
fn mcp_servers_from_value(root: &serde_json::Value) -> Vec<McpServerView> {
    let mut out: Vec<McpServerView> = vec![];
    if let Some(mcp) = root.get("mcp").and_then(|m| m.as_object()) {
        for (name, cfg) in mcp {
            let mut view = McpServerView {
                name: name.clone(),
                kind: cfg.get("type").and_then(|t| t.as_str()).unwrap_or("stdio").to_string(),
                command: cfg.get("command").and_then(|c| c.as_str()).unwrap_or("").to_string(),
                url: cfg.get("url").and_then(|u| u.as_str()).unwrap_or("").to_string(),
                timeout: cfg.get("timeout").and_then(|t| t.as_u64()).unwrap_or(0) as u32,
                disabled: cfg.get("disabled").and_then(|d| d.as_bool()).unwrap_or(false),
                ..Default::default()
            };
            if let Some(args) = cfg.get("args").and_then(|a| a.as_array()) {
                view.args = args.iter().filter_map(|a| a.as_str().map(|s| s.to_string())).collect();
            }
            if let Some(env) = cfg.get("env").and_then(|e| e.as_object()) {
                view.env = env.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect();
            }
            if let Some(headers) = cfg.get("headers").and_then(|h| h.as_object()) {
                view.headers = headers.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect();
            }
            out.push(view);
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// 列出服务端已配置的 MCP 服务（GET /v1/settings）。
/// 服务端只回传 env/headers 的键（值已脱敏为空串）；提交时留空即保留原值。
#[tauri::command]
pub async fn list_mcp_servers(_app: tauri::AppHandle) -> Result<Vec<McpServerView>, AppError> {
    let view = fetch_server_settings().await?;
    Ok(mcp_servers_from_settings(&view))
}

fn mcp_servers_from_settings(view: &serde_json::Value) -> Vec<McpServerView> {
    let mut out: Vec<McpServerView> = vec![];
    let Some(list) = view.get("mcp").and_then(|m| m.as_array()) else {
        return out;
    };
    for cfg in list {
        let name = cfg.get("name").and_then(|n| n.as_str()).unwrap_or("");
        if name.is_empty() {
            continue;
        }
        let mut item = McpServerView {
            name: name.to_string(),
            kind: cfg.get("type").and_then(|t| t.as_str()).unwrap_or("stdio").to_string(),
            command: cfg.get("command").and_then(|c| c.as_str()).unwrap_or("").to_string(),
            url: cfg.get("url").and_then(|u| u.as_str()).unwrap_or("").to_string(),
            timeout: cfg.get("timeout").and_then(|t| t.as_u64()).unwrap_or(0) as u32,
            disabled: cfg.get("disabled").and_then(|d| d.as_bool()).unwrap_or(false),
            ..Default::default()
        };
        if let Some(args) = cfg.get("args").and_then(|a| a.as_array()) {
            item.args = args.iter().filter_map(|a| a.as_str().map(|s| s.to_string())).collect();
        }
        if let Some(env) = cfg.get("env").and_then(|e| e.as_object()) {
            item.env = env.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect();
        }
        if let Some(headers) = cfg.get("headers").and_then(|h| h.as_object()) {
            item.headers = headers.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect();
        }
        out.push(item);
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// 新增 MCP 服务的核心逻辑（便于单测），返回归一化后的名称。
///
/// 生产路径已改走服务端 `POST /v1/settings`，这里只被配置迁移回归用例使用。
#[allow(dead_code)]
fn add_mcp_server_core(input: &McpServerView) -> Result<String, AppError> {
    let (name, kind) = validate_mcp_input(input)?;
    let value = mcp_config_value(input, &kind);
    let name_for_write = name.clone();
    update_agent_config(move |config| {
        if !config.get("mcp").is_some_and(|v| v.is_object()) {
            config["mcp"] = serde_json::json!({});
        }
        let mcp = config["mcp"]
            .as_object_mut()
            .ok_or_else(|| AppError::msg("tigerAgent.json 结构异常：mcp 不是对象"))?;
        if mcp.contains_key(&name_for_write) {
            return Err(AppError::msg(format!("MCP「{}」已存在", name_for_write)));
        }
        mcp.insert(name_for_write, value);
        Ok(())
    })?;
    Ok(name)
}

/// 新增 MCP 服务（写入服务端 mcp.<name>）
#[tauri::command]
pub async fn add_mcp_server(_app: tauri::AppHandle, input: McpServerView) -> Result<serde_json::Value, AppError> {
    let (name, kind) = validate_mcp_input(&input)?;
    let view = fetch_server_settings().await?;
    let exists = view
        .get("mcp")
        .and_then(|m| m.as_array())
        .map(|list| {
            list.iter().any(|item| {
                item.get("name").and_then(|n| n.as_str()) == Some(name.as_str())
            })
        })
        .unwrap_or(false);
    if exists {
        bail!("MCP「{}」已存在", name);
    }
    let mut mcp = serde_json::Map::new();
    mcp.insert(name.clone(), mcp_config_value(&input, &kind));
    send_server_settings(serde_json::json!({ "mcp": mcp })).await?;
    Ok(serde_json::json!({ "name": name, "success": true }))
}

/// 修改 MCP 服务的核心逻辑（便于单测）：original_name 定位旧条目，名称可改。
///
/// 生产路径已改走服务端 `POST /v1/settings`，这里只被配置迁移回归用例使用。
#[allow(dead_code)]
fn update_mcp_server_core(original_name: &str, input: &McpServerView) -> Result<String, AppError> {
    let original = original_name.trim().to_string();
    if original.is_empty() {
        bail!("缺少原始 MCP 名称");
    }
    let (name, kind) = validate_mcp_input(input)?;
    let new_value = mcp_config_value(input, &kind);
    let name_for_write = name.clone();
    update_agent_config(move |config| {
        let mcp = config
            .get_mut("mcp")
            .and_then(|m| m.as_object_mut())
            .ok_or_else(|| AppError::msg("tigerAgent.json 结构异常：缺少 mcp"))?;
        let existing = mcp
            .get(&original)
            .cloned()
            .ok_or_else(|| AppError::msg(format!("未找到 MCP「{}」", original)))?;
        if name_for_write != original {
            if mcp.contains_key(&name_for_write) {
                return Err(AppError::msg(format!("MCP「{}」已存在", name_for_write)));
            }
            mcp.remove(&original);
        }
        mcp.insert(name_for_write, merge_mcp_config(&existing, new_value));
        Ok(())
    })?;
    Ok(name)
}

/// 修改 MCP 服务（名称变更时迁移 key，未知字段由服务端保留）
#[tauri::command]
pub async fn update_mcp_server(
    _app: tauri::AppHandle,
    original_name: String,
    input: McpServerView,
) -> Result<serde_json::Value, AppError> {
    let original = original_name.trim().to_string();
    if original.is_empty() {
        bail!("缺少原始 MCP 名称");
    }
    let (name, kind) = validate_mcp_input(&input)?;
    let mut patch = serde_json::json!({ "mcp": { name.clone(): mcp_config_value(&input, &kind) } });
    if name != original {
        patch["remove_mcp"] = serde_json::json!([original]);
    }
    send_server_settings(patch).await?;
    Ok(serde_json::json!({ "name": name, "success": true }))
}

/// 删除 MCP 服务的核心逻辑（便于单测）。
///
/// 生产路径已改走服务端 `POST /v1/settings`（`remove_mcp`），这里只被配置迁移
/// 回归用例使用。
#[allow(dead_code)]
fn delete_mcp_server_core(name: &str) -> Result<(), AppError> {
    let name = name.trim().to_string();
    if name.is_empty() {
        bail!("缺少 MCP 名称");
    }
    let name_for_write = name.clone();
    update_agent_config(move |config| {
        let mcp = config
            .get_mut("mcp")
            .and_then(|m| m.as_object_mut())
            .ok_or_else(|| AppError::msg("tigerAgent.json 结构异常：缺少 mcp"))?;
        if mcp.remove(&name_for_write).is_none() {
            return Err(AppError::msg(format!("未找到 MCP「{}」", name_for_write)));
        }
        Ok(())
    })?;
    Ok(())
}

/// 删除 MCP 服务
#[tauri::command]
pub async fn delete_mcp_server(_app: tauri::AppHandle, name: String) -> Result<serde_json::Value, AppError> {
    let name = name.trim().to_string();
    if name.is_empty() {
        bail!("缺少 MCP 名称");
    }
    send_server_settings(serde_json::json!({ "remove_mcp": [name] })).await?;
    Ok(serde_json::json!({ "name": name, "success": true }))
}

// ===== Tauri Command =====

/// 返回当前操作系统标识：windows / macos / linux 等
/// 用于进入 Agent 页前做平台判断（Windows / macOS / Linux 均支持）
#[tauri::command]
pub fn get_platform_os() -> String {
    std::env::consts::OS.to_string()
}

// ===== 服务端版本读取 =====

/// 获取远端服务端版本（`GET /v1/version`）。
/// 桌面端不再管理服务端进程，版本只能从用户自行启动的服务端查询；
/// 未配置或连不上时返回 Ok(None)（设置页只做展示，不阻塞其它操作）。
#[tauri::command]
pub async fn get_server_version(app: tauri::AppHandle) -> Result<Option<String>, AppError> {
    let Ok(target) = crate::common::server_mode::resolve(&app) else {
        return Ok(None);
    };
    let client = build_client(&target, Duration::from_secs(5))
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;
    let (status, bytes) = tokio::time::timeout(
        Duration::from_secs(10),
        agent_http::send(&client, "GET", "/v1/version", None),
    )
    .await
    .map_err(|_| "获取服务端版本超时".to_string())?
    .map_err(|e| format!("获取服务端版本失败: {}", e))?;
    if !(200..300).contains(&status) {
        bail!("获取服务端版本失败: HTTP {}", status);
    }
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or_default();
    Ok(body.get("version").and_then(|v| v.as_str()).map(|s| s.to_string()))
}

/// 获取当前系统架构（主要用于 macOS Intel/ARM 区分）
#[tauri::command]
pub fn get_platform_arch() -> String {
    std::env::consts::ARCH.to_string()
}

/// 探测云端模型的 OpenAI 兼容 `/models` 接口，返回模型 ID 列表。
///
/// 必须走 Rust 侧而不是前端 fetch：WebView 页面源是 `http://tauri.localhost`，
/// 多数服务商不返回 CORS 头，前端直连会被浏览器拦下并误报成“地址或密钥不正确”
/// （与 `fetch_skill_store` 同理）。返回空列表表示接口通了但没解析到模型。
#[tauri::command]
pub async fn probe_models_endpoint(
    base_url: String,
    api_key: Option<String>,
) -> Result<Vec<String>, AppError> {
    let base = base_url.trim().trim_end_matches('/').to_string();
    if base.is_empty() {
        bail!("API 地址为空");
    }
    let url = format!("{}/models", base);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let mut req = client.get(&url);
    let key = api_key.unwrap_or_default();
    if !key.trim().is_empty() {
        req = req.bearer_auth(key.trim());
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("请求 {} 失败: {}", url, e))?;
    let status = resp.status();
    if !status.is_success() {
        bail!("{} 返回 HTTP {}", url, status.as_u16());
    }
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析 {} 响应失败: {}", url, e))?;

    // OpenAI 兼容格式为 {"data":[{"id":...}]}；少数服务商直接返回数组
    let items = if let Some(arr) = body.as_array() {
        arr.clone()
    } else if let Some(arr) = body.get("data").and_then(|d| d.as_array()) {
        arr.clone()
    } else {
        bail!("{} 响应不是 OpenAI 兼容的模型列表", url);
    };

    let mut ids = Vec::new();
    for item in items {
        let id = match item {
            serde_json::Value::String(s) => s,
            other => other
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        };
        if !id.is_empty() {
            ids.push(id);
        }
    }
    Ok(ids)
}

/// 平台默认工作目录：
/// - Windows：软件安装目录（Tiger.exe 所在目录）
/// - macOS / Linux：用户主目录（$HOME）
/// - 兜底：exe 所在目录
fn platform_default_workdir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Ok(dir) = config::get_exe_dir() {
            return dir;
        }
        // exe 目录获取失败时退回用户主目录
    }
    dirs::home_dir().unwrap_or_else(|| {
        config::get_exe_dir().unwrap_or_else(|_| PathBuf::from("."))
    })
}

/// 工作目录为空时初始化默认工作目录（幂等）：
/// - Windows：软件安装目录
/// - macOS / Linux：用户主目录
/// 同步写入工作目录列表（默认项）与旧字段 agent_workdir，返回当前生效的工作目录。
fn ensure_default_workdir(app: &tauri::AppHandle) -> String {
    let existing = load_agent_workdir(app);
    if !existing.is_empty() {
        return existing;
    }
    // 旧字段为空但列表里有目录：以默认项补齐旧字段，不覆盖用户已有列表
    let dirs = load_workdirs(app);
    if !dirs.is_empty() {
        let list_default = dirs
            .iter()
            .find(|d| d.is_default)
            .or_else(|| dirs.first())
            .map(|d| d.path.clone())
            .unwrap_or_default();
        if !list_default.is_empty() {
            let _ = save_agent_workdir(app, &list_default);
            return list_default;
        }
    }
    let default_path = platform_default_workdir().to_string_lossy().to_string();
    let _ = save_workdirs_internal(
        app,
        &[WorkDirEntry { path: default_path.clone(), is_default: true }],
    );
    default_path
}

/// 获取已配置的 agent 工作目录；为空时自动初始化平台默认工作目录
#[tauri::command]
pub async fn get_agent_workdir(app: tauri::AppHandle) -> Result<String, AppError> {
    Ok(ensure_default_workdir(&app))
}

/// 保存 agent 工作目录到配置文件
#[tauri::command]
pub async fn set_agent_workdir(app: tauri::AppHandle, workdir: String) -> Result<(), AppError> {
    save_agent_workdir(&app, workdir.trim())
}

/// 读取工作目录列表，并在首次加载时从旧 agent_workdir 迁移
fn load_workdirs(app: &tauri::AppHandle) -> Vec<WorkDirEntry> {
    let data_dir = match config::get_data_dir(Some(app)) {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    let config_path = data_dir.join("config.json");
    let json = match std::fs::read_to_string(&config_path) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let settings = match serde_json::from_str::<Settings>(&json) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    // Migration: if agent_workdirs is empty but agent_workdir is set,
    // migrate the single workdir into the array.
    if settings.agent_workdirs.is_empty() && !settings.agent_workdir.is_empty() {
        let migrated = vec![WorkDirEntry {
            path: settings.agent_workdir.clone(),
            is_default: true,
        }];
        // Persist the migrated state.
        let _ = save_workdirs_internal(app, &migrated);
        return migrated;
    }

    settings.agent_workdirs
}

/// Write workdirs to config.json (read-modify-write to preserve other fields)
fn save_workdirs_internal(app: &tauri::AppHandle, dirs: &[WorkDirEntry]) -> Result<(), AppError> {
    let state = app.state::<AppState>();
    let _lock = state.config_write_lock.lock().map_err(|e| e.to_string())?;
    let data_dir = config::get_data_dir(Some(app))?;
    let config_path = data_dir.join("config.json");

    let mut settings = if config_path.exists() {
        let json = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("读取配置文件失败: {}", e))?;
        serde_json::from_str::<Settings>(&json)
            .map_err(|e| format!("解析配置文件失败: {}", e))?
    } else {
        Settings::default()
    };

    settings.agent_workdirs = dirs.to_vec();
    // Sync the legacy agent_workdir to the default entry for backward compat.
    let default_path = dirs.iter()
        .find(|d| d.is_default)
        .or_else(|| dirs.first())
        .map(|d| d.path.clone())
        .unwrap_or_default();
    settings.agent_workdir = default_path;

    let json = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("序列化配置失败: {}", e))?;
    std::fs::write(&config_path, &json).map_err(|e| format!("写入配置文件失败: {}", e))?;
    Ok(())
}

/// 把工作目录列表推到服务端（服务端校验路径存在且是目录）。
async fn push_workdirs(dirs: &[WorkDirEntry]) -> Result<(), AppError> {
    let payload: Vec<serde_json::Value> = dirs
        .iter()
        .map(|d| serde_json::json!({ "path": d.path, "is_default": d.is_default }))
        .collect();
    send_server_settings(serde_json::json!({ "work_directories": payload })).await?;
    Ok(())
}

/// 从 GET /v1/settings 视图读取服务端工作目录列表。
fn workdirs_from_settings(view: &serde_json::Value) -> Vec<WorkDirEntry> {
    let mut out = Vec::new();
    if let Some(list) = view.get("work_directories").and_then(|v| v.as_array()) {
        for item in list {
            let Some(path) = item.get("path").and_then(|p| p.as_str()) else {
                continue;
            };
            out.push(WorkDirEntry {
                path: path.to_string(),
                is_default: item.get("is_default").and_then(|d| d.as_bool()).unwrap_or(false),
            });
        }
    }
    out
}

/// 从服务端 `/v1/settings` 视图选择建 workspace 的路径：
/// `is_default` 优先，否则取第一项；没有配置（或路径为空）返回 None，
/// 调用方回退到 `"."`（服务端自身的 cwd）。
fn default_server_workdir(view: &serde_json::Value) -> Option<String> {
    let dirs = workdirs_from_settings(view);
    dirs.iter()
        .find(|d| d.is_default)
        .or_else(|| dirs.first())
        .map(|d| d.path.trim().to_string())
        .filter(|p| !p.is_empty())
}

/// 获取工作目录列表：已连服务端时以**服务端**存储为准（路径按服务端视角解释，
/// 本地只存一份展示缓存；服务端列表为空就是空，不能拿本机旧缓存顶替）。
/// 未连接服务端时才回退本机 config.json 缓存（仅供 UI 展示，不参与建工作区）。
#[tauri::command]
pub async fn get_workdirs(app: tauri::AppHandle) -> Result<Vec<WorkDirEntry>, AppError> {
    if agent_local_client().is_some() {
        match fetch_server_settings().await {
            Ok(view) => {
                let dirs = workdirs_from_settings(&view);
                let _ = save_workdirs_internal(&app, &dirs);
                return Ok(dirs);
            }
            Err(e) => {
                api_debug_log(|| format!("Workdirs: 读取服务端工作目录失败，回退本地缓存: {}", e));
            }
        }
    } else {
        ensure_default_workdir(&app);
    }
    Ok(load_workdirs(&app))
}

/// 添加工作目录（去重），若列表为空则设为默认；先由服务端校验路径再落盘。
#[tauri::command]
pub async fn add_workdir(app: tauri::AppHandle, path: String) -> Result<Vec<WorkDirEntry>, AppError> {
    let mut dirs = load_workdirs(&app);
    let path = path.trim().to_string();
    if path.is_empty() {
        bail!("工作目录不能为空");
    }
    if dirs.iter().any(|d| d.path == path) {
        return Ok(dirs); // Already exists
    }
    let is_first = dirs.is_empty();
    dirs.push(WorkDirEntry { path, is_default: is_first });
    push_workdirs(&dirs).await?;
    save_workdirs_internal(&app, &dirs)?;
    Ok(dirs)
}

/// 移除工作目录；若移除的是默认项则将剩余第一项设为默认
#[tauri::command]
pub async fn remove_workdir(app: tauri::AppHandle, path: String) -> Result<Vec<WorkDirEntry>, AppError> {
    let mut dirs = load_workdirs(&app);
    let path = path.trim().to_string();
    let removed_default = dirs.iter().find(|d| d.path == path).map(|d| d.is_default).unwrap_or(false);
    dirs.retain(|d| d.path != path);
    if removed_default && !dirs.is_empty() {
        dirs[0].is_default = true;
    }
    push_workdirs(&dirs).await?;
    save_workdirs_internal(&app, &dirs)?;
    Ok(dirs)
}

/// 设置默认工作目录
#[tauri::command]
pub async fn set_default_workdir(app: tauri::AppHandle, path: String) -> Result<Vec<WorkDirEntry>, AppError> {
    let mut dirs = load_workdirs(&app);
    let path = path.trim().to_string();
    for d in &mut dirs {
        d.is_default = d.path == path;
    }
    push_workdirs(&dirs).await?;
    save_workdirs_internal(&app, &dirs)?;
    Ok(dirs)
}

/// 验证工作目录列表：在**服务端**检查每个路径是否存在，删除不存在的并返回被删除的路径。
/// 服务端不可达时退回本机检查（仅用于本地缓存清理，不改变"路径按服务端解释"的语义）。
#[tauri::command]
/// 校验工作目录：**只以服务端为准**（工作目录路径属于服务端主机，本机
/// `is_dir` 判断在远程部署下必然误报）。返回已从列表移除的路径；服务端不可达时
/// 不做任何删除，返回空列表。
pub async fn validate_workdirs(app: tauri::AppHandle) -> Result<Vec<String>, AppError> {
    let dirs = load_workdirs(&app);
    let paths: Vec<String> = dirs.iter().map(|d| d.path.clone()).collect();

    let Some(mut missing) = validate_paths_on_server(&paths).await else {
        return Ok(Vec::new());
    };
    missing.sort();

    if missing.is_empty() {
        return Ok(missing);
    }
    let mut kept = dirs;
    let mut removed_default = false;
    kept.retain(|d| {
        if missing.contains(&d.path) {
            if d.is_default {
                removed_default = true;
            }
            false
        } else {
            true
        }
    });
    if removed_default && !kept.is_empty() {
        kept[0].is_default = true;
    }
    let _ = push_workdirs(&kept).await;
    save_workdirs_internal(&app, &kept)?;
    Ok(missing)
}

/// 调用 POST /v1/fs/validate，返回**不存在**的路径。服务端不可达时返回 None。
async fn validate_paths_on_server(paths: &[String]) -> Option<Vec<String>> {
    if paths.is_empty() {
        return Some(Vec::new());
    }
    let client = agent_local_client()?;
    let (status, body) = tokio::time::timeout(
        Duration::from_secs(10),
        agent_http::send(
            &client,
            "POST",
            "/v1/fs/validate",
            Some(serde_json::json!({ "paths": paths })),
        ),
    )
    .await
    .ok()?
    .ok()?;
    if !(200..300).contains(&status) {
        return None;
    }
    let value: serde_json::Value = serde_json::from_slice(&body).ok()?;
    let mut missing = Vec::new();
    if let Some(results) = value.get("results").and_then(|r| r.as_array()) {
        for item in results {
            let exists = item.get("exists").and_then(|v| v.as_bool()).unwrap_or(false);
            let is_dir = item.get("is_dir").and_then(|v| v.as_bool()).unwrap_or(false);
            if !exists || !is_dir {
                if let Some(path) = item.get("path").and_then(|p| p.as_str()) {
                    missing.push(path.to_string());
                }
            }
        }
    }
    Some(missing)
}

// ===== 服务端连接（TCP + TLS）=====

/// 服务端连接信息（连接成功并对某个 workspace 建好会话后返回）
#[derive(Serialize)]
pub struct AgentServerInfo {
    /// 服务端地址展示串（tcp://host:port）
    pub host: String,
    pub workspace_id: String,
    /// 建链时实际使用的服务端 workspace 路径（"." 表示服务端 cwd）
    pub workspace_path: String,
    pub client_id: String,
}

/// 服务端连接状态
#[derive(Serialize)]
pub struct AgentServerStatus {
    /// 是否已有可用的 workspace 会话（连接 + 会话都已建立）
    pub running: bool,
    pub host: Option<String>,
    pub workspace_id: Option<String>,
    /// 当前激活 workspace 的 client_id（页面 remount 时前端需用它同步 S.clientId，
    /// 否则 current-session 等接口会因 client_id 不匹配返回 404）
    pub client_id: Option<String>,
}

/// 当前服务端目标；未配置时给出配置引导。
/// 服务端由用户自行启动并手动配置，桌面端只做客户端，不再托管任何服务端进程。
fn require_target() -> Result<TcpTarget, AppError> {
    agent_http::active_target().ok_or_else(|| {
        AppError::msg(
            "尚未连接服务端：请在设置 → 服务端连接中粘贴服务端连接串，并自行启动 tigerAgent --host tcp://0.0.0.0:<端口>",
        )
    })
}

/// 内部函数：断开所有 workspace 会话（停止 SSE 转发任务）。
/// 服务端进程由用户自行管理，这里既不杀进程也不碰服务端状态。
fn teardown_agent_sessions(state: &tauri::State<'_, AppState>) -> Result<(), AppError> {
    {
        let mut sessions = state.agent_sessions.lock().map_err(|e| e.to_string())?;
        for (_, sess) in sessions.iter() {
            sess.sse_stop.store(true, Ordering::Relaxed);
            if let Some(task) = &sess.sse_task { task.abort(); }
        }
        sessions.clear();
    }
    *state.active_workspace_id.lock().map_err(|e| e.to_string())? = None;
    // 断开后服务端可能已重启：丢掉共享连接池，避免下次请求复用死连接。
    agent_http::reset_shared_client();
    Ok(())
}

// 兜底：前端未传时本地生成（不应发生，但避免空字符串导致服务端校验失败）
fn generate_client_id(client_id: String) -> String {
    if client_id.is_empty() {
        format!(
            "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
            rand::random::<u32>(),
            rand::random::<u16>(),
            rand::random::<u16>(),
            rand::random::<u16>(),
            rand::random::<u64>() & 0xFFFFFFFFFFFF
        )
    } else {
        client_id
    }
}

/// 连接用户自行启动的服务端（TCP + TLS 1.3 + 服务端 SPKI pin + Bearer token），
/// 建立 / 复用 workspace 会话并开始 SSE 转发。
///
/// 与旧实现的关键差异：**不再拉起、探测或终止本地 Agent 进程**。连接串（地址、
/// 服务端指纹、token）来自设置页（缺一项就解析失败），连不上就直接报错并
/// 引导用户检查配置 / 启动服务，避免"桌面端偷偷起服务"这种不可见状态。
#[tauri::command]
pub async fn start_agent_server(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    client_id: String,
) -> Result<AgentServerInfo, AppError> {
    // 连接流程单飞锁：并发调用只允许一个在建连，
    // 后到者等待完成后直接复用已建好的会话。
    let _start_guard = state.agent_start_lock.lock().await;

    // 只有连接串可解析（地址 + 指纹 + token 齐全）才能解析出目标；
    // 解析结果同时写入全局 active target，供后续所有请求复用。
    let target = crate::common::server_mode::apply(&app)?;

    // 已有活会话直接复用（同一进程内重复进入 Agent 页触发）
    {
        let active = state.active_workspace_id.lock().map(|g| g.clone()).unwrap_or(None);
        if let Some(ws_id) = active {
            if let Ok(sessions) = state.agent_sessions.lock() {
                if let Some(sess) = sessions.get(&ws_id) {
                    return Ok(AgentServerInfo {
                        host: target.display(),
                        workspace_id: ws_id,
                        workspace_path: sess.workspace_path.clone(),
                        client_id: sess.client_id.clone(),
                    });
                }
            }
        }
    }
    teardown_agent_sessions(&state)?;

    // 探活：连不上就明确说明「服务端没启动 / 地址不可达 / 指纹或 token 不一致」，
    // 不再像本地模式那样尝试拉起进程。
    let probe = build_client(&target, Duration::from_secs(5))
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;
    if let Err(e) = health_check(&probe).await {
        bail!(
            "无法连接服务端（{}）：{}；请确认服务端已启动（tigerAgent --host tcp://0.0.0.0:<端口>）、地址可达、连接串里的指纹与 token 与当前服务端一致",
            target.display(),
            e
        );
    }
    eprintln!("[Agent] 已连接服务端 {}", target.display());

    // 使用前端传入的 client_id，确保 SSE 流、POST /v1/workspaces、
    // current-session 全用同一个 client_id（Go 服务端要求 current-session
    // 的 client_id 已挂活跃 SSE 流，否则返回 404 client not attached）。
    let client_id = generate_client_id(client_id);

    // 工作目录以服务端为准：Phase A 里的本机默认目录只用于离线展示，跨机器/跨 OS
    // 时它在服务端通常不存在，不能拿来建 workspace。先读服务端 settings.work_directories
    // （is_default 优先），没有配置或读取失败时回退到 "."（服务端自身 cwd）。
    let requested_workdir = match fetch_server_settings().await {
        Ok(view) => default_server_workdir(&view),
        Err(e) => {
            eprintln!("[Agent] 读取服务端工作目录失败，改用服务端当前目录: {}", e);
            None
        }
    }
    .unwrap_or_else(|| ".".to_string());

    // 服务端配置的目录可能已被删除：只有「服务端侧该路径不存在 / 不是目录」才回退到
    // "."（服务端 cwd），避免服务端配置过期时桌面端永久停在“无法连接”。
    // 超时、连接中断、HTTP 5xx 等瞬时/环境错误必须原样上报：否则会在用户不知情时把
    // 工作区建到服务端 cwd，Agent 实际改的目录和用户以为的完全是两个地方。
    let (workspace_id, workspace_path) =
        match create_workspace_on_server(&target, &client_id, &requested_workdir).await {
            Ok(v) => v,
            Err(e) if requested_workdir != "." => {
                let path_gone = matches!(
                    validate_paths_on_server(std::slice::from_ref(&requested_workdir)).await,
                    Some(missing) if !missing.is_empty()
                );
                if !path_gone {
                    return Err(e);
                }
                eprintln!(
                    "[Agent] 服务端工作目录 {} 已不存在（{}），回退到服务端当前目录",
                    requested_workdir, e
                );
                create_workspace_on_server(&target, &client_id, ".")
                    .await
                    .map_err(|fallback_err| {
                        AppError::msg(format!(
                            "使用服务端工作目录 {} 创建工作区失败（{}）；回退到服务端当前目录也失败: {}",
                            requested_workdir, e, fallback_err
                        ))
                    })?
            }
            Err(e) => return Err(e),
        };

    let sse_stop = Arc::new(AtomicBool::new(false));

    let app2 = app.clone();
    let ws_id = workspace_id.clone();
    let cid = client_id.clone();
    let sse_stop2 = sse_stop.clone();
    let t2 = target.clone();
    let sse_task = tokio::spawn(async move {
        let _ = forward_sse_events(&app2, &t2, &ws_id, &cid, sse_stop2).await;
    });

    // 注册 workspace 会话
    {
        let mut sessions = state.agent_sessions.lock().map_err(|e| e.to_string())?;
        sessions.insert(workspace_id.clone(), AgentServerSession {
            sse_stop: sse_stop.clone(),
            sse_task: Some(sse_task),
            workspace_id: workspace_id.clone(),
            workspace_path: workspace_path.clone(),
            client_id: client_id.clone(),
        });
    }
    // 设为激活 workspace
    *state.active_workspace_id.lock().map_err(|e| e.to_string())? = Some(workspace_id.clone());

    let host = target.display();
    app.emit("agent-server-ready",
        serde_json::json!({ "host": host, "workspace_id": &workspace_id, "workspace_path": &workspace_path })).ok();

    Ok(AgentServerInfo { host, workspace_id, workspace_path, client_id })
}

/// 连续建连失败达到该次数才通知前端（3s 一次 ≈ 15s），避免瞬时抖动就弹错。
const SSE_FAILURE_NOTIFY_THRESHOLD: u32 = 5;

async fn forward_sse_events(
    app: &tauri::AppHandle, target: &TcpTarget, workspace_id: &str, client_id: &str, stop: Arc<AtomicBool>,
) -> Result<(), AppError> {
    let path = format!("/v1/workspaces/{}/events?client_id={}", workspace_id, client_id);
    println!("[agent] forward_sse_events URL: {}", path);
    // SSE 是无限期长连接：只能限制建连耗时，绝不能给流本身设总超时（同原注释：
    // workspace 靠 SSE 流引用计数存活，最后一条流断开会立即 teardown workspace，
    // 触发 server 自身退出 —— "连接一断，服务即死"）。
    let client = build_client(target, Duration::from_secs(5))
        .map_err(|e| format!("创建 SSE 客户端失败: {}", e))?;

    // 服务端由用户自行启动：桌面端无法探测它的进程状态，只能按重试结果判断
    // “连接已断开”，所以连续失败达阈值时通知前端提示用户去检查服务端。
    let mut failures = 0u32;
    loop {
        if stop.load(Ordering::Relaxed) { return Ok(()); }
        let (status, body) = match agent_http::stream_get(&client, &path).await {
            Ok(r) => r,
            Err(e) => {
                if stop.load(Ordering::Relaxed) { return Ok(()); }
                failures += 1;
                println!("[agent] forward_sse_events 连接失败({}): {}", failures, e);
                api_debug_log(|| format!("SSE ! 连接失败({}): {}", failures, e));
                if failures == SSE_FAILURE_NOTIFY_THRESHOLD {
                    let _ = app.emit(
                        "agent-connection-lost",
                        serde_json::json!({ "target": target.display() }),
                    );
                }
                tokio::time::sleep(Duration::from_secs(3)).await; continue;
            }
        };
        if !(200..300).contains(&status) {
            failures += 1;
            println!("[agent] forward_sse_events HTTP {} (失败 {})", status, failures);
            if failures == SSE_FAILURE_NOTIFY_THRESHOLD {
                let _ = app.emit(
                    "agent-connection-lost",
                    serde_json::json!({ "target": target.display(), "status": status }),
                );
            }
            tokio::time::sleep(Duration::from_secs(3)).await; continue;
        }
        failures = 0;
        println!("[agent] forward_sse_events SSE 已连接 workspace: {}", workspace_id);
        api_debug_log(|| format!("SSE = 已连接 workspace={} client={}", workspace_id, client_id));

        use futures_util::StreamExt;
        use http_body_util::BodyExt;
        let mut stream = body.into_data_stream();
        let mut buffer = String::new();

        while let Some(chunk_result) = stream.next().await {
            if stop.load(Ordering::Relaxed) { return Ok(()); }
            let chunk = match chunk_result { Ok(c) => c, Err(_) => break };
            buffer.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(pos) = buffer.find("\n\n") {
                let event_text = buffer[..pos].to_string();
                // 原地前移残留数据：旧写法每个事件都重建一次 String，一个 chunk 里
                // 有 N 个事件就是 N 次全量复制（O(n²)），大块输出时拖慢事件转发。
                buffer.drain(..pos + 2);
                let mut event_type = String::new();
                let mut event_data = String::new();
                for line in event_text.lines() {
                    if let Some(d) = line.strip_prefix("event: ") { event_type = d.to_string(); }
                    else if let Some(d) = line.strip_prefix("data: ") { event_data = d.to_string(); }
                }
                if !event_data.is_empty() {
                    let mut payload: serde_json::Value = serde_json::from_str(&event_data)
                        .unwrap_or(serde_json::json!({ "raw": event_data }));
                    // 子 Agent 事件只记日志不转发，避免 SSE 带宽浪费和日志洪泛。
                    let is_sub_agent = is_sub_agent_event(&payload);
                    // 只写关键事件；流式增量/快照等噪音返回 None 不落盘。
                    if is_sub_agent {
                        // 子 Agent 事件只记关键节点（run_complete/agent_event/error），不记流式噪音
                        let ev_type = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        if ev_type == "run_complete" || ev_type == "agent_event" {
                            api_debug_log(|| summarize_sse_event(&payload).unwrap_or_default());
                        }
                    } else {
                        api_debug_log(|| summarize_sse_event(&payload).unwrap_or_default());
                        // run_complete 的 payload 携带整轮文本（text 字段），会话上下文增长后
                        // 可能很大；Tauri IPC 对大 payload 偶发投递失败（表现：前端收不到
                        // run_complete → UI 卡"运行中"，需手动点停止），转发前截断防御。
                        // 用 payload 内部 type 判断（event: 行个别实现可能缺失），与
                        // summarize_sse_event 的判定保持一致。
                        if payload.get("type").and_then(|v| v.as_str()) == Some("run_complete") {
                            if let Some(v) = payload.pointer_mut("/payload/payload/text") {
                                if let Some(s) = v.as_str() {
                                    let total = s.chars().count();
                                    if total > 200_000 {
                                        let head: String = s.chars().take(200_000).collect();
                                        *v = serde_json::json!(format!("{}...[正文过长已截断 {} 字符]", head, total - 200_000));
                                        api_debug_log(|| format!("SSE ! run_complete text 超长截断 len={}", total));
                                    }
                                }
                            }
                        }
                        let evt = serde_json::json!({ "type": event_type, "data": payload, "workspace_id": workspace_id });
                        if let Err(e) = app.emit("agent-sse-event", evt) {
                            api_debug_log(|| format!("SSE ! emit 失败 type={} err={}", event_type, e));
                        }
                    }
                }
            }
        }
        // 流断开后立即重连：Agent 在最后一条 SSE 流断开的瞬间就会 teardown workspace，
        // 任何等待都在扩大 server 自杀的竞争窗口
        if !stop.load(Ordering::Relaxed) {
            println!("[agent] forward_sse_events 流断开，立即重连");
            api_debug_log(|| "SSE ! 流断开，立即重连".to_string());
        }
    }
}

// ===== 调试模式：Agent API 交互日志（运行时开关，正式发布版也可用）=====
//
// 由设置里的“调试模式”开关控制（Settings.debug_logging，持久化到
// config.json）：启动时恢复、前端实时切换。关闭时 log_enabled 为 false，
// api_debug_log 一次 atomic load 即返回，无任何开销也不产生文件。

static LOG_ENABLED: AtomicBool = AtomicBool::new(false);

// 日志文件句柄：None = 尚未打开 / 打开失败。开关打开时截断重建，
// 为“每次重启软件自动清空上次日志”：重启后首次 enable 时 File::create 截断。
static LOG_FILE: std::sync::OnceLock<std::sync::Mutex<Option<std::fs::File>>> = std::sync::OnceLock::new();

fn log_file_cell() -> &'static std::sync::Mutex<Option<std::fs::File>> {
    LOG_FILE.get_or_init(|| std::sync::Mutex::new(None))
}

/// 调试日志文件路径：app 数据目录（与 config.json 同处）下的 tigerAgent_debug.log。
/// 不用 exe 同目录：正式安装下 Windows 的 Program Files 不可写、macOS 会污染
/// .app 签名；app 数据目录始终可写且不影响安装包完整性。
fn api_debug_log_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = config::get_data_dir(Some(app)).ok()?;
    Some(dir.join("tigerAgent_debug.log"))
}

/// 开启调试日志：首次开启（含重启后）截断重建日志文件（清空上次），
/// 已处于开启态时幂等返回（不重复截断）——否则调试期间每次保存设置
/// 都会把本会话已积累的日志清空（排查中断时往往会顺手改模型/参数）。
/// 返回日志文件路径供前端展示。
fn enable_api_debug_log(app: &tauri::AppHandle) -> Option<PathBuf> {
    let path = api_debug_log_path(app)?;
    if LOG_ENABLED.load(Ordering::Relaxed) {
        return Some(path); // 已开启：保持追加，不重复截断
    }
    let file = std::fs::File::create(&path).ok()?; // 截断：从关到开 / 重启后首次全新
    if let Ok(mut cell) = log_file_cell().lock() {
        *cell = Some(file);
    }
    LOG_ENABLED.store(true, Ordering::Relaxed);
    println!("[agent] 调试日志已开启: {}", path.display());
    Some(path)
}

/// 关闭调试日志：置位关关、释放句柄并删除日志文件，避免过期日志残留
/// （否则“打开日志目录”会定位到一份不再更新的旧日志，容易误读）。
fn disable_api_debug_log(app: &tauri::AppHandle) {
    LOG_ENABLED.store(false, Ordering::Relaxed);
    if let Ok(mut cell) = log_file_cell().lock() {
        *cell = None;
    }
    if let Some(path) = api_debug_log_path(app) {
        let _ = std::fs::remove_file(&path);
    }
}

/// 单行日志内容去换行 + 截断。
fn api_log_snippet(s: &str, max: usize) -> String {
    let flat = s.replace('\n', " ↵ ");
    flat.chars().take(max).collect()
}

/// 将 JSON Value 中包含敏感关键词的 key（api_key/secret/password/token）的值替换为 "***"，
/// 用于 HTTP 请求体日志脱敏，避免 API Key 等凭据明文写入 tigerAgent_debug.log。
fn mask_sensitive_json(value: &serde_json::Value) -> String {
    let mut v = value.clone();
    mask_sensitive_in_place(&mut v);
    api_log_snippet(&v.to_string(), 800)
}
fn mask_sensitive_in_place(value: &mut serde_json::Value) {
    const SENSITIVE: &[&str] = &["api_key", "apikey", "secret", "password", "token"];
    match value {
        serde_json::Value::Object(map) => {
            // 1) 字段名本身含敏感词 → 直接遮蔽其值
            let keys_to_mask: Vec<String> = map.keys()
                .filter(|k| {
                    let lower = k.to_lowercase();
                    SENSITIVE.iter().any(|sk| lower.contains(sk))
                })
                .cloned()
                .collect();
            for k in keys_to_mask {
                if let Some(v) = map.get_mut(&k) {
                    if !matches!(v, serde_json::Value::Null | serde_json::Value::Bool(_)) {
                        *v = serde_json::Value::String("***".to_string());
                    }
                }
            }
            // 2) config/set 场景：key 字段值含敏感词时，遮蔽同对象的 value 字段
            //    body = {"scope":0,"key":"providers.xxx.api_key","value":"sk-..."}
            let key_is_sensitive = map.get("key")
                .and_then(|v| v.as_str())
                .map(|s| {
                    let lower = s.to_lowercase();
                    SENSITIVE.iter().any(|sk| lower.contains(sk))
                })
                .unwrap_or(false);
            if key_is_sensitive {
                if let Some(v) = map.get_mut("value") {
                    if !matches!(v, serde_json::Value::Null | serde_json::Value::Bool(_)) {
                        *v = serde_json::Value::String("***".to_string());
                    }
                }
            }
            for (_, v) in map.iter_mut() {
                mask_sensitive_in_place(v);
            }
        }
        serde_json::Value::Array(arr) => {
            for v in arr.iter_mut() {
                mask_sensitive_in_place(v);
            }
        }
        _ => {}
    }
}

/// 写一条 Agent API 交互日志。开关关闭时一次 atomic load 即返回（闭包
/// 不执行，无格式化开销）。与 devtools 控制台的 [agent] API / SSE 日志对应：
/// 所有前端请求都经 agent_http_request 代理、所有 SSE 事件都经
/// forward_sse_events 转发，在这两处落盘即可完整复盘对话中断问题。
/// 行格式：`{epoch_ms} {HH:MM:SS.mmm 本地时间} {内容}`。
/// pub(crate)：供 skills.rs 等其他页面模块复用同一日志通道。
pub(crate) fn api_debug_log<F: FnOnce() -> String>(line: F) {
    if !LOG_ENABLED.load(Ordering::Relaxed) {
        return;
    }
    use std::io::Write;
    if let Ok(mut cell) = log_file_cell().lock() {
        if let Some(f) = cell.as_mut() {
            let content = line();
            // 空内容（如 summarize_sse_event 对噪音事件返回 None）不写，
            // 避免产生只有时间戳的空行。
            if content.is_empty() { return; }
            let ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let _ = writeln!(
                f, "{} {} {}",
                ms, chrono::Local::now().format("%H:%M:%S%.3f"),
                content
            );
        }
    }
}

/// 判断是否子 Agent（agent 工具嵌套调用）的 SSE 事件：其 session_id 为
/// 复合格式 `{parentMsgId}$${toolCallId}`（tool call id 前缀随 provider 不同，
/// 如 OpenAI `call_`、Qwen `chatcmpl-tool-`），前端不处理，不应转发。
/// 注意：只能看 session_id 字段，不能对整个事件 JSON 做 contains("$$")——
/// tool 消息正文（如 shell 的 `$$` 变量）可能含该字符，会导致误判丢弃。
fn is_sub_agent_event(payload: &serde_json::Value) -> bool {
    payload
        .pointer("/payload/payload/session_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .contains("$$")
}

/// 把一条 SSE 事件精简为一行可排查摘要；返回 None 表示这类事件是噪音
/// （流式 message updated 增量、session token 快照等），不写日志。
/// 只保留能定位“对话为何中断/卡住”的关键节点：运行收尾、错误、权限、
/// 消息创建节奏、连接生命周期。SSE data 结构：
/// `{ type: <事件类型>, payload: { type: created|updated|deleted, payload: {..} } }`。
fn summarize_sse_event(payload: &serde_json::Value) -> Option<String> {
    let ev = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let inner = payload.pointer("/payload/type").and_then(|v| v.as_str()).unwrap_or("");
    let data = payload.pointer("/payload/payload");
    // 取 data 下的字符串字段（数字/布尔转成字面量），缺失返回空串。
    let field = |k: &str| -> String {
        match data.and_then(|d| d.get(k)) {
            Some(serde_json::Value::String(s)) => s.clone(),
            Some(v) => v.to_string(),
            None => String::new(),
        }
    };
    match ev {
        // 运行收尾：最关键的一条。error 非空 = 服务端报错中断；
        // cancelled = 被取消；两者皆空 = 正常收尾（叙述性 stop / 完成）。
        "run_complete" => {
            let err = field("error");
            let has_err = !err.is_empty() && err != "null";
            let flag = if has_err { "! run_complete" } else { "< run_complete" };
            let empty = field("empty_output");
            let empty_s = if empty.is_empty() { "false" } else { empty.as_str() };
            Some(format!(
                "{} run_id={} session={} error={} cancelled={} msg_id={} empty_output={}",
                flag, field("run_id"), field("session_id"), err, field("cancelled"), field("message_id"), empty_s
            ))
        }
        // Agent 事件：错误 / 摘要（summarize）。
        "agent_event" => {
            let err = field("error");
            let has_err = !err.is_empty() && err != "null";
            let flag = if has_err { "! agent_event" } else { "< agent_event" };
            Some(format!("{} type={} session={} error={}", flag, field("type"), field("session_id"), err))
        }
        // 消息节奏：只记 created（新建 user/assistant/tool 消息），跳过 updated
        // 的流式增量（一轮上百条 thinking 是主噪音）。能看出“这轮到底产出了
        // 哪些消息”——全程只一条 assistant 无 tool = 叙述性 stop。
        "message" => {
            if inner == "created" {
                Some(format!("< message created role={} id={}", field("role"), field("id")))
            } else if inner == "deleted" {
                Some(format!("< message deleted id={}", field("id")))
            } else {
                None
            }
        }
        // 权限请求 / 结果：Plan/Yolo 下一般直通，出现即值得记。
        "permission_request" => Some(format!("< permission_request tool={} session={}", field("tool_name"), field("session_id"))),
        "permission_notification" => Some(format!("< permission_notification granted={}", field("granted"))),
        // session 快照（context_tokens/is_busy 每次 token 变化都推）、file/
        // mcp/skills 等杂项：噪音，跳过。解析失败的原始事件仍记一行以便发现异常。
        "session" => None,
        "" if payload.get("raw").is_some() => Some(format!("< raw {}", api_log_snippet(payload.get("raw").and_then(|v| v.as_str()).unwrap_or(""), 200))),
        _ => None,
    }
}

#[tauri::command]
pub async fn stop_agent_server(state: tauri::State<'_, AppState>) -> Result<(), AppError> {
    // 与建连共用同一把锁，避免建连尚未登记 session 时 stop 无效。
    // 只断开连接（停 SSE / 清会话），不会去结束用户自行启动的服务端进程。
    let _start_guard = state.agent_start_lock.lock().await;
    teardown_agent_sessions(&state)
}

#[tauri::command]
pub async fn get_agent_server_status(state: tauri::State<'_, AppState>) -> Result<AgentServerStatus, AppError> {
    let active = state.active_workspace_id.lock().map(|g| g.clone()).unwrap_or(None);
    let client_id = if let Some(ws_id) = active.as_ref() {
        let sessions = state.agent_sessions.lock().map_err(|e| e.to_string())?;
        sessions.get(ws_id).map(|s| s.client_id.clone())
    } else {
        None
    };
    // running 只代表「本进程已建好 workspace 会话」，不再代表本地服务进程存活
    let running = client_id.is_some();
    Ok(AgentServerStatus {
        running,
        host: agent_http::active_target().map(|t| t.display()),
        workspace_id: active,
        client_id,
    })
}

#[tauri::command]
pub async fn agent_http_request(
    _state: tauri::State<'_, AppState>, method: String, path: String, body: Option<serde_json::Value>,
) -> Result<serde_json::Value, AppError> {
    let target = require_target()?;
    let started = std::time::Instant::now();
    // 只读 GET 多为高频轮询（每轮 run 后刷 /agent /sessions /messages），是主噪音：
    // 成功时不记，只在出错时留痕；改状态的操作（发消息/切模式/权限）才记请求行。
    let is_get = method.eq_ignore_ascii_case("GET");
    if !is_get {
        api_debug_log(|| format!(
            "HTTP > {} {}{}",
            method.to_uppercase(), path,
            body.as_ref().map(|b| format!(" body={}", mask_sensitive_json(b))).unwrap_or_default()
        ));
    }
    // 共享客户端复用 keep-alive 连接：否则每次输入都要重新做 TCP + TLS 握手。
    let client = agent_http::shared_client(&target, Duration::from_secs(5))
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;
    // 180s：与 Agent 服务端图片直调识别的整体超时（describeOverallTimeout）
    // 保持一致——识别在 HTTP 超时前返回或降级，避免“前端报错、后台继续跑”。
    let (status, bytes) = tokio::time::timeout(
        Duration::from_secs(180),
        agent_http::send(&client, &method, &path, body),
    )
    .await
    .map_err(|_| "HTTP 请求超时".to_string())?
    .map_err(|e| {
        // 网络失败一律留痕（含 GET）：连不上 server 是中断的关键线索。
        api_debug_log(|| format!("HTTP ! {} {} 请求失败({}ms): {}", method.to_uppercase(), path, started.elapsed().as_millis(), e));
        format!("HTTP 请求失败: {}", e)
    })?;

    // 2xx 一律视为成功：201 Created、202 Accepted（/agent 发送消息无 body；
    // 异步 job 接口带 job JSON，前端要靠 job_id 轮询进度）、204 No Content（删除等）。
    // 之前只认 200/202/204，201 的成功响应体被当错误抛给前端；202 曾一律丢成
    // `{}`，异步安装等调用永远报 "missing job_id"。现在除 204 外都解析 body，
    // 空 body / 解析失败回落空对象，兼容 fire-and-forget 调用方。
    if (200..300).contains(&status) {
        let result = if status == 204 {
            serde_json::json!({})
        } else {
            serde_json::from_slice(&bytes).unwrap_or(serde_json::json!({}))
        };
        // 成功响应不 dump body（GET /messages 等会打一大坡）；只记非 GET 的一行状态+耗时。
        if !is_get {
            api_debug_log(|| format!("HTTP < {} {} {} ({}ms)", status, method.to_uppercase(), path, started.elapsed().as_millis()));
        }
        return Ok(result);
    }

    // 其它状态码（4xx/5xx）：读取响应体作为错误抛出。
    // 此前会把错误 JSON 当成功结果返回，前端 Array.isArray 判定失败后静默降级为
    // 空列表/空聊天（表现为“列表加载不出来”且控制台无任何报错）
    let text = String::from_utf8_lossy(&bytes).to_string();
    let snippet: String = text.chars().take(300).collect();
    api_debug_log(|| format!(
        "HTTP ! {} {} {} ({}ms) err={}",
        status, method.to_uppercase(), path, started.elapsed().as_millis(),
        api_log_snippet(&snippet, 300)
    ));
    bail!("HTTP {} {} {}: {}", status, method.to_uppercase(), path, snippet);
}


#[tauri::command]
pub async fn agent_subscribe_events(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    workspace_id: String,
    client_id: String,
) -> Result<(), AppError> {
    let mut sessions = state.agent_sessions.lock().map_err(|e| e.to_string())?;
    let sess = sessions.get_mut(&workspace_id).ok_or("workspace session not found")?;

    // 同 workspace 重复订阅（页面挂载/断线重连）：若已有活 SSE 转发任务，直接复用。
    // 绝不能 abort 活任务——abort 产生零流间隙，服务端 streams 计数归零立即
    // teardown 该 workspace；若它是最后一个 workspace，整个 server 自杀退出
    // （表现为 "Agent 服务异常退出" + 反复重启循环）。
    // forward_sse_events 自带断线自愈循环，无需重建。
    if let Some(task) = &sess.sse_task {
        if !task.is_finished() {
            return Ok(());
        }
    }
    sess.sse_stop.store(true, Ordering::Relaxed);
    let _ = sess.sse_task.take();

    // 创建新的停止标志并更新 session
    let new_sse_stop = Arc::new(AtomicBool::new(false));
    sess.sse_stop = new_sse_stop.clone();

    // 服务端目标由设置页配置，未配置时无法重建 SSE
    let target = match agent_http::active_target() {
        Some(t) => t,
        None => {
            return Err(AppError::msg(
                "尚未连接服务端：请先在设置 → 服务端连接中完成配置",
            ))
        }
    };

    // 启动新的 SSE 转发任务
    let app2 = app.clone();
    sess.sse_task = Some(tokio::spawn(async move {
        let _ = forward_sse_events(&app2, &target, &workspace_id, &client_id, new_sse_stop).await;
    }));

    Ok(())
}


pub fn kill_agent_session(state: &AppState) {
    // 只断开本进程的会话/流；用户自行启动的服务端进程不受影响
    if let Ok(mut sessions) = state.agent_sessions.lock() {
        for (_, sess) in sessions.iter() {
            sess.sse_stop.store(true, Ordering::Relaxed);
            if let Some(task) = &sess.sse_task { task.abort(); }
        }
        sessions.clear();
    }
}

// ===== 新增：多 workspace 管理命令 =====

/// 在服务端创建/复用 workspace，返回 `(workspace_id, workspace_path)`。
/// `path` 必须按服务端视角解释；非 2xx 直接返回错误，由调用方决定是否回退。
async fn create_workspace_on_server(
    target: &TcpTarget,
    client_id: &str,
    path: &str,
) -> Result<(String, String), AppError> {
    let client = build_client(target, Duration::from_secs(5))
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let (status, bytes) = tokio::time::timeout(
        Duration::from_secs(10),
        agent_http::send(
            &client,
            "POST",
            "/v1/workspaces",
            Some(serde_json::json!({ "path": path, "client_id": client_id })),
        ),
    )
    .await
    .map_err(|_| "创建工作区超时".to_string())?
    .map_err(|e| format!("创建工作区失败: {}", e))?;
    if !(200..300).contains(&status) {
        return Err(AppError::msg(format!(
            "创建工作区失败: HTTP {}（路径：{}）",
            status, path
        )));
    }

    let body: serde_json::Value =
        serde_json::from_slice(&bytes).unwrap_or(serde_json::json!({}));
    let workspace_id = body
        .get("id")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| "default".to_string());
    let workspace_path = body
        .get("path")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| path.to_string());
    Ok((workspace_id, workspace_path))
}

/// 在已运行的 Agent server 上创建新 workspace 并启动独立 SSE 转发。
/// 不影响已有 workspace 的运行。
#[tauri::command]
pub async fn create_workspace(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    path: String,
    client_id: String,
) -> Result<AgentServerInfo, AppError> {
    // 持有建连锁：避免与 start_agent_server 并发时目标尚未解析导致连接失败
    let _guard = state.agent_start_lock.lock().await;
    let target = require_target()?;

    // 使用前端传入的 client_id（同 start_agent_server）
    let client_id = generate_client_id(client_id);

    let (workspace_id, workspace_path) =
        create_workspace_on_server(&target, &client_id, &path).await?;

    // 检查是否已有该 workspace 的活 SSE 转发任务。切回已存在的 path 时
    // Go 端按 path 去重返回同一 workspace_id，若这里无条件 spawn 新任务
    // 会产生僵尸任务：同一 workspace 多条 SSE 流 → 事件重复投递、
    // 前端 run_complete 重复处理导致会话"卡住"。有活任务直接复用。
    {
        let sessions = state.agent_sessions.lock().map_err(|e| e.to_string())?;
        if let Some(existing) = sessions.get(&workspace_id) {
            if let Some(task) = &existing.sse_task {
                if !task.is_finished() {
                    // 已有活任务，直接复用（保持原有 client_id，SSE 流不变）
                    return Ok(AgentServerInfo {
                        host: target.display(),
                        workspace_id: workspace_id.clone(),
                        workspace_path: existing.workspace_path.clone(),
                        client_id: existing.client_id.clone(),
                    });
                }
            }
        }
    }

    // 走到这里说明该 workspace 无活 SSE 任务（首次创建或旧任务已死）：
    // 启动该 workspace 的独立 SSE 转发
    let sse_stop = Arc::new(AtomicBool::new(false));
    let app2 = app.clone();
    let ws_id = workspace_id.clone();
    let cid = client_id.clone();
    let sse_stop2 = sse_stop.clone();
    let t2 = target.clone();
    let sse_task = tokio::spawn(async move {
        let _ = forward_sse_events(&app2, &t2, &ws_id, &cid, sse_stop2).await;
    });

    // 注册会话
    {
        let mut sessions = state.agent_sessions.lock().map_err(|e| e.to_string())?;
        sessions.insert(workspace_id.clone(), AgentServerSession {
            sse_stop: sse_stop.clone(),
            sse_task: Some(sse_task),
            workspace_id: workspace_id.clone(),
            workspace_path: workspace_path.clone(),
            client_id: client_id.clone(),
        });
    }

    let host = target.display();
    Ok(AgentServerInfo { host, workspace_id, workspace_path, client_id })
}

/// 切换当前激活的 workspace（不停止旧 workspace 的 SSE）。
#[tauri::command]
pub async fn switch_workspace(
    state: tauri::State<'_, AppState>,
    workspace_id: String,
) -> Result<(), AppError> {
    let sessions = state.agent_sessions.lock().map_err(|e| e.to_string())?;
    if !sessions.contains_key(&workspace_id) {
        bail!("workspace {} 不存在", workspace_id);
    }
    drop(sessions);
    *state.active_workspace_id.lock().map_err(|e| e.to_string())? = Some(workspace_id);
    Ok(())
}

/// query 参数百分号编码：非 URL 保留字符（含 `/`）一律 %XX，
/// 服务端 r.URL.Query() 解码后得到原始相对路径。
fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}

/// 下载工作区文件到本机（项目管理视图「下载」按钮与文件树右键「下载到本地」）：
/// 经服务端 GET /v1/workspaces/{id}/files/raw 流式取原始字节（二进制安全、
/// 无大小上限，与 files/content 的 1MB 文本预览互补），先弹保存对话框再传输，
/// 期间按整百分比（无 Content-Length 时每 256KB）发 `workspace-download-progress`
/// 事件供按钮显示进度。返回保存后的本地路径，便于 UI 提示。
#[tauri::command]
pub async fn download_workspace_file(
    app: tauri::AppHandle,
    workspace_id: String,
    path: String,
) -> Result<String, AppError> {
    use http_body_util::BodyExt;
    use tauri_plugin_dialog::DialogExt;

    if workspace_id.is_empty() || path.trim().is_empty() {
        bail!("缺少 workspace 或文件路径");
    }
    let target = require_target()?;
    let client = build_client(&target, Duration::from_secs(5))
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;
    let url = format!(
        "/v1/workspaces/{}/files/raw?path={}",
        workspace_id,
        percent_encode(&path)
    );

    // 先弹保存对话框再开始传输：用户取消时不必白白下载整个文件。
    let default_name = path.rsplit('/').next().unwrap_or("file").to_string();
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(&default_name)
        .save_file(move |picked| {
            let _ = tx.send(picked);
        });
    let picked = rx
        .await
        .map_err(|_| AppError::msg("保存对话框失败"))?
        .ok_or_else(|| AppError::msg("用户取消了保存"))?;
    let save_path = picked
        .into_path()
        .map_err(|e| AppError::msg(format!("无法获取保存路径: {}", e)))?;

    // 300s：远程链路 + 大文件留足余量（与服务端日志下载同量级）。
    let (status, headers, mut body) = tokio::time::timeout(
        Duration::from_secs(300),
        agent_http::stream_get_with_headers(&client, &url),
    )
    .await
    .map_err(|_| "下载文件超时".to_string())?
    .map_err(|e| format!("请求服务端失败: {}", e))?;
    if !(200..300).contains(&status) {
        let bytes = body
            .collect()
            .await
            .map_err(|e| format!("读取响应失败: {}", e))?
            .to_bytes()
            .to_vec();
        let value: serde_json::Value =
            serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        let message = value
            .get("message")
            .and_then(|m| m.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("请求失败 (HTTP {})", status));
        api_debug_log(|| format!("Projects ! 下载工作区文件 {} 失败: {}", path, message));
        bail!("{}", message);
    }
    let total: u64 = headers
        .get(hyper::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    let app2 = app.clone();
    let ws_id = workspace_id.clone();
    let path2 = path.clone();
    let read = async {
        let mut data: Vec<u8> = Vec::new();
        let mut received: u64 = 0;
        let mut last_pct: u64 = 0;
        let mut last_emit: u64 = 0;
        while let Some(frame) = body.frame().await {
            let frame = frame.map_err(|e| format!("读取响应失败: {}", e))?;
            if let Ok(chunk) = frame.into_data() {
                received += chunk.len() as u64;
                data.extend_from_slice(&chunk);
                let pct = if total > 0 { received * 100 / total } else { 0 };
                if (total > 0 && pct != last_pct)
                    || (total == 0 && received - last_emit >= 262_144)
                {
                    last_pct = pct;
                    last_emit = received;
                    let _ = app2.emit(
                        "workspace-download-progress",
                        serde_json::json!({
                            "workspace_id": ws_id,
                            "path": path2,
                            "received": received,
                            "total": total,
                        }),
                    );
                }
            }
        }
        Ok::<Vec<u8>, String>(data)
    };
    let bytes = tokio::time::timeout(Duration::from_secs(300), read)
        .await
        .map_err(|_| "下载文件超时".to_string())?
        .map_err(|e| format!("下载文件失败: {}", e))?;

    std::fs::write(&save_path, &bytes).map_err(|e| format!("写入文件失败: {}", e))?;

    api_debug_log(|| {
        format!(
            "Projects: 已下载工作区文件 {} ({} bytes) -> {}",
            path,
            bytes.len(),
            save_path.display()
        )
    });
    Ok(save_path.to_string_lossy().to_string())
}

// ===== 日志管理 =====

/// 启动时根据持久化设置恢复调试日志开关（config.json 的 debug_logging）。
/// 开启时截断重建日志文件 —— 实现“每次重启软件自动清空上次日志”。
/// 在 setup 阶段调用，早于任何 Agent 交互。
pub fn init_debug_logging(app: &tauri::AppHandle) {
    let data_dir = match config::get_data_dir(Some(app)) {
        Ok(d) => d,
        Err(_) => return,
    };
    let config_path = data_dir.join("config.json");
    let enabled = std::fs::read_to_string(&config_path)
        .ok()
        .and_then(|json| serde_json::from_str::<Settings>(&json).ok())
        .map(|s| s.debug_logging)
        .unwrap_or(false);
    if enabled {
        enable_api_debug_log(app);
    }
}

/// 设置调试日志开关（前端实时切换）。开启时首次截断重建日志文件（清空上次），
/// 返回日志文件绝对路径；关闭时释放句柄并删除旧日志、返回空串。
/// 运行时开关与编译 profile 无关，正式发布版同样生效。
#[tauri::command]
pub async fn set_debug_logging(app: tauri::AppHandle, enabled: bool) -> Result<String, AppError> {
    if enabled {
        match enable_api_debug_log(&app) {
            Some(path) => Ok(path.to_string_lossy().to_string()),
            None => bail!("无法创建调试日志文件"),
        }
    } else {
        disable_api_debug_log(&app);
        Ok(String::new())
    }
}

/// 前端调试日志写入：让 JS 端把关键事件写到 tigerAgent_debug.log，
/// 与 Rust 端的 api_debug_log 统一格式、统一文件。
/// 仅在 debug_logging 开启时写入（与 api_debug_log 同一个开关）。
#[tauri::command]
pub async fn agent_debug_log(_app: tauri::AppHandle, line: String) -> Result<(), AppError> {
    api_debug_log(|| format!("UI: {}", line));
    Ok(())
}

/// 在系统文件管理器中打开调试日志所在位置（app 数据目录）。
/// 日志文件已存在时定位并高亮该文件；尚未生成时（未开过调试）
/// 打开其所在目录。
#[tauri::command]
pub async fn open_debug_log_dir(app: tauri::AppHandle) -> Result<(), AppError> {
    use tauri_plugin_opener::OpenerExt;
    let path = api_debug_log_path(&app).ok_or("无法确定调试日志路径")?;
    if path.exists() {
        // 文件存在：在文件管理器中定位并高亮
        app.opener()
            .reveal_item_in_dir(&path)
            .map_err(|e| format!("打开日志目录失败: {}", e))?;
    } else {
        // 文件不存在（未开过调试）：打开所在目录
        let dir = path.parent().ok_or("无法确定日志目录")?;
        app.opener()
            .open_path(dir.to_string_lossy().to_string(), None::<&str>)
            .map_err(|e| format!("打开目录失败: {}", e))?;
    }
    Ok(())
}

/// 读取粘贴/拖入的文件内容，供前端作为附件发送（图片走浏览器剪贴板直读，
/// 文本等文件剪贴板只带路径，需在此读取真实内容）。
/// 返回文件名与 base64 编码内容；MIME 由前端按扩展名推断（与选择器逻辑一致）。
#[tauri::command]
pub async fn read_attachment_file(path: String) -> Result<serde_json::Value, AppError> {
    use base64::Engine;
    let p = PathBuf::from(&path);
    let meta = std::fs::metadata(&p).map_err(|e| format!("读取文件失败: {}", e))?;
    if !meta.is_file() {
        bail!("不是文件: {}", p.display());
    }
    const MAX_ATTACH_SIZE: u64 = 20 * 1024 * 1024;
    if meta.len() > MAX_ATTACH_SIZE {
        bail!("文件过大: {} (最大 20MB)", p.display());
    }
    let data = std::fs::read(&p).map_err(|e| format!("读取文件失败: {}", e))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    Ok(serde_json::json!({ "name": name, "base64": b64 }))
}

/// 判断路径是否为目录。粘贴"复制的文件夹"时前端据此把目录路径作为文本插入
/// 输入框（而不是报"暂不支持该格式"），方便告知模型文件所在目录。
#[tauri::command]
pub fn is_directory(path: String) -> bool {
    std::fs::metadata(&path).map(|m| m.is_dir()).unwrap_or(false)
}



/// 读取系统剪贴板中的文件路径列表（Windows 资源管理器复制文件时为 CF_HDROP 格式；
/// macOS Finder 复制文件时为 NSPasteboard 的 NSFilenamesPboardType / public.file-url）。
/// 返回空数组表示剪贴板无文件（复制的是文本/图片等）。WKWebView 不把 Finder 复制的
/// 文件暴露给网页 DataTransfer，故在 Rust 侧直读剪贴板。
#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn read_clipboard_files() -> Result<Vec<String>, String> {
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EnumClipboardFormats, GetClipboardData, OpenClipboard,
    };
    use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};
    use windows::Win32::System::Ole::CF_HDROP;
    use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};

    let mut paths: Vec<String> = Vec::new();
    unsafe {
        if OpenClipboard(None).is_err() {
            return Ok(paths);
        }
        // 枚举剪贴板格式，定位 CF_HDROP（文件列表）
        let mut fmt: u32 = 0;
        loop {
            let next = EnumClipboardFormats(fmt);
            if next == 0 {
                break;
            }
            fmt = next;
            if fmt == CF_HDROP.0 as u32 {
                if let Ok(handle) = GetClipboardData(CF_HDROP.0 as u32) {
                    if !handle.0.is_null() {
                        let ptr = GlobalLock(HGLOBAL(handle.0));
                        if !ptr.is_null() {
                            let hdrop = HDROP(ptr);
                            let count = DragQueryFileW(hdrop, u32::MAX, None);
                            for i in 0..count {
                                let len = DragQueryFileW(hdrop, i, None);
                                if len == 0 {
                                    continue;
                                }
                                let mut buf = vec![0u16; (len + 1) as usize];
                                DragQueryFileW(hdrop, i, Some(&mut buf));
                                let s = String::from_utf16_lossy(&buf[..len as usize]);
                                if !s.is_empty() {
                                    paths.push(s);
                                }
                            }
                            let _ = GlobalUnlock(HGLOBAL(handle.0));
                        }
                    }
                }
                break;
            }
        }
        let _ = CloseClipboard();
    }
    Ok(paths)
}

/// `file:///Users/a%20b.txt` → `/Users/a b.txt`。
///
/// NSPasteboard 的 `public.file-url` 是百分号编码的 URL：Finder 复制的文件名含空格 /
/// 中文时，直接剥掉 `file://` 前缀会留下 `%20` 一类的路径，后续按路径读文件必然失败。
#[cfg(any(target_os = "macos", test))]
fn decode_file_url(url: &str) -> String {
    let raw = url.strip_prefix("file://").unwrap_or(url);
    let raw = raw.strip_prefix("localhost").unwrap_or(raw);
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(target_os = "macos")]
#[tauri::command]
#[allow(deprecated)] // NSFilenamesPboardType 已废弃但仍是最权威的多文件来源
pub async fn read_clipboard_files() -> Result<Vec<String>, String> {
    use objc2_app_kit::{NSPasteboard, NSFilenamesPboardType, NSPasteboardTypeFileURL};
    use objc2_foundation::{NSArray, NSString};

    let mut paths: Vec<String> = Vec::new();
    let pb = NSPasteboard::generalPasteboard();

    unsafe {
        // Finder/AppKit 复制文件：NSFilenamesPboardType 为权威类型（路径字符串数组）
        if let Some(plist) = pb.propertyListForType(NSFilenamesPboardType) {
            if let Ok(arr) = plist.downcast::<NSArray>() {
                for s in arr.iter() {
                    if let Some(str) = s.downcast_ref::<NSString>() {
                        let p = str.to_string();
                        if !p.is_empty() {
                            paths.push(p);
                        }
                    }
                }
                if !paths.is_empty() {
                    return Ok(paths);
                }
            }
        }

        // 兜底：逐条读取 public.file-url（file:///path → /path；多选文件时每个文件一个 item）
        if let Some(items) = pb.pasteboardItems() {
            for item in items.iter() {
                if let Some(s) = item.stringForType(NSPasteboardTypeFileURL) {
                    let path = decode_file_url(&s.to_string());
                    if !path.is_empty() && !paths.contains(&path) {
                        paths.push(path);
                    }
                }
            }
        }
    }
    Ok(paths)
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
#[tauri::command]
pub async fn read_clipboard_files() -> Result<Vec<String>, String> {
    Ok(Vec::new())
}

// ===== 系统剪贴板文本读写（网页 API 的回退通道） =====
// 桌面端复制/粘贴菜单原本只用 navigator.clipboard，在 Linux（WebKitGTK）上必然失败：
// Clipboard::readText 需宿主发放 WebKitClipboardPermissionRequest（WebKitGTK 2.42 起，
// Tauri/wry 未处理 → 默认拒绝），Promise 以 NotAllowedError 收尾；写入则要求处于用户
// 手势内。失败被前端 catch 吞掉后表现为「右键复制/粘贴没反应」。这里提供原生实现。
// 注意：Linux 上剪贴板内容由持有者进程按需提供，arboard 实例一析构内容即消失，
// 必须用进程级静态实例承载，不能每次调用新建。
static CLIPBOARD: std::sync::OnceLock<std::sync::Mutex<arboard::Clipboard>> =
    std::sync::OnceLock::new();

fn clipboard_instance() -> Result<&'static std::sync::Mutex<arboard::Clipboard>, String> {
    if let Some(cb) = CLIPBOARD.get() {
        return Ok(cb);
    }
    let cb = arboard::Clipboard::new().map_err(|e| format!("初始化系统剪贴板失败: {}", e))?;
    // 并发首次调用可能被其它线程抢先注册：丢弃本地实例即可（内容归属先注册者）
    let _ = CLIPBOARD.set(std::sync::Mutex::new(cb));
    CLIPBOARD
        .get()
        .ok_or_else(|| "初始化系统剪贴板失败".to_string())
}

fn clipboard_read_text_blocking() -> Result<String, String> {
    let cell = clipboard_instance()?;
    let mut guard = cell.lock().map_err(|_| "系统剪贴板被占用".to_string())?;
    guard
        .get_text()
        .map_err(|e| format!("读取剪贴板失败: {}", e))
}

fn clipboard_write_text_blocking(text: String) -> Result<(), String> {
    let cell = clipboard_instance()?;
    let mut guard = cell.lock().map_err(|_| "系统剪贴板被占用".to_string())?;
    guard
        .set_text(text)
        .map_err(|e| format!("写入剪贴板失败: {}", e))
}

/// 读取系统剪贴板文本
#[tauri::command]
pub async fn clipboard_read_text() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(clipboard_read_text_blocking)
        .await
        .map_err(|e| format!("读取剪贴板失败: {}", e))?
}

/// 写入系统剪贴板文本
#[tauri::command]
pub async fn clipboard_write_text(text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || clipboard_write_text_blocking(text))
        .await
        .map_err(|e| format!("写入剪贴板失败: {}", e))?
}

// ---------------------------------------------------------------------------
// 回归测试：tigerAgent.json 被并发写清空的修复
//
// 背景：本文件在 Windows 上与 Agent server（Go）的数据配置是同一个文件。
// 旧实现用非原子的 std::fs::write 先截断文件，并在读取/解析失败时静默回退
// build_agent_config() 整文件覆盖，导致切换模型时 agent_proxy /
// agent_vision_model / options / 全部云端 provider 被清空。
//
// 修复后必须成立的两条不变量：
//   1. 任何写入都只打补丁，已有字段一字不动；
//   2. 文件为空或 JSON 非法时拒绝写入，绝不当成空文档覆盖。
//
// 实现说明：这些用例通过 LOCALAPPDATA 把配置目录重定向到临时目录，而环境变量
// 是进程全局的，因此用 TEST_SERIAL_LOCK 强制用例串行（cargo test 默认多线程并行）。
// ---------------------------------------------------------------------------
#[cfg(test)]
mod agent_config_tests {
    use super::*;

    /// 强制用例串行：环境变量是进程全局的，并行会互相踩配置目录。
    static TEST_SERIAL_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// 持有串行锁的临时配置目录；drop 时释放锁（目录本身不自动删除，便于失败排查）。
    ///
    /// `dir` 是 **配置目录本身**（即 `.../Agent`），与 `agent_config_dir()`
    /// 的返回值一致，测试里可直接 `t.dir.join("tigerAgent.json")`。
    struct TestDir {
        dir: PathBuf,
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    fn temp_config_dir(tag: &str) -> TestDir {
        let guard = TEST_SERIAL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let base = std::env::temp_dir().join(format!(
            "agent_cfg_test_{}_{}_{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&base);
        // agent_config_dir()：Windows 为 LOCALAPPDATA/tigerAgent，其它平台为 HOME/.config/tigerAgent，
        // 两个环境变量都重定向到临时目录，保证测试在任意平台都不触碰真实用户配置。
        #[cfg(target_os = "windows")]
        let dir = base.join("tigerAgent");
        #[cfg(not(target_os = "windows"))]
        let dir = {
            std::env::set_var("HOME", &base);
            base.join(".config").join("tigerAgent")
        };
        std::fs::create_dir_all(&dir).expect("创建临时配置目录失败");
        std::env::set_var("LOCALAPPDATA", &base);
        TestDir { dir, _guard: guard }
    }

    const SAMPLE: &str = r#"{
  "agent_proxy": { "enabled": true, "url": "http://127.0.0.1:10809" },
  "options": { "tui": { "compact_mode": true } },
  "providers": {
    "local": { "name": "Local" },
    "mycloud": { "api_key": "sk-test", "base_url": "https://example.invalid/v1" }
  }
}"#;

    /// 不变量 1：写入只打补丁，已有字段一字不动。
    #[test]
    fn update_preserves_every_unrelated_field() {
        let t = temp_config_dir("preserve");
        let path = t.dir.join("tigerAgent.json");
        std::fs::write(&path, SAMPLE).expect("写入样本配置");

        update_agent_config(|v| {
            v["agent_vision_model"] = serde_json::json!({ "provider": "p", "model": "m" });
            Ok::<(), AppError>(())
        })
        .expect("写入应成功");

        let out: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("读回配置"))
                .expect("落盘后必须是合法 JSON");

        assert_eq!(
            out["agent_proxy"]["url"], "http://127.0.0.1:10809",
            "agent_proxy 必须原样保留"
        );
        assert_eq!(
            out["options"]["tui"]["compact_mode"],
            serde_json::json!(true),
            "options.tui 必须原样保留"
        );
        assert_eq!(
            out["providers"]["mycloud"]["api_key"], "sk-test",
            "云端 provider 必须原样保留 —— 旧实现正是把这里清空了"
        );
        assert_eq!(
            out["providers"]["local"]["name"], "Local",
            "local provider 必须保留"
        );
        assert_eq!(
            out["agent_vision_model"]["model"], "m",
            "新字段必须写入"
        );
    }

    // ---- delete_cloud_provider：顺带清理 recent_models ----

    const DELETE_SAMPLE: &str = r#"{
  "model": { "provider": "local", "model": "localModel" },
  "recent_models": [
    { "model": "deepseek-v4.1-flash", "provider": "deepseekv41flash" },
    { "model": "agent-models", "provider": "tigerAgent" },
    { "model": "qwen3.8-flash", "provider": "qwen38flash" },
    { "model": "sensenova-6.8-flash-lite", "provider": "sensenova68flashlite" }
  ],
  "providers": {
    "local": { "name": "Local" },
    "qwen38flash": { "name": "Qwen" }
  }
}"#;

    fn read_config(path: &std::path::Path) -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(path).expect("读回配置"))
            .expect("落盘后必须是合法 JSON")
    }

    /// 删除 provider 时顺带剔除指向它的「最近使用」条目，其余条目与字段原样保留。
    #[test]
    fn delete_provider_prunes_matching_recent_models() {
        let t = temp_config_dir("delete_prune");
        let path = t.dir.join("tigerAgent.json");
        std::fs::write(&path, DELETE_SAMPLE).expect("写入样本配置");

        let removed =
            update_agent_config(|v| remove_provider_with_recent_models(v, "qwen38flash"))
                .expect("删除应成功");
        assert_eq!(removed, 1, "应剔除 1 条指向该 provider 的历史记录");

        let raw = std::fs::read_to_string(&path).expect("读回配置");
        assert!(
            !raw.contains("qwen38flash"),
            "已删 provider 不得残留在配置任何位置"
        );
        let out = read_config(&path);
        assert_eq!(out["providers"]["local"]["name"], "Local", "其它 provider 必须保留");
        assert_eq!(
            out["recent_models"].as_array().expect("列表应仍在").len(),
            3,
            "其余「最近使用」条目必须保留（顺序不变）"
        );
        assert_eq!(out["recent_models"][0]["provider"], "deepseekv41flash");
        assert_eq!(out["model"]["model"], "localModel", "无关字段必须原样保留");
    }

    /// 剔除后列表为空：直接移除字段，避免留下 `recent_models: []`
    /// （服务端 omitempty 的写回语义是字段缺失）。
    #[test]
    fn delete_provider_drops_empty_recent_models_field() {
        let t = temp_config_dir("delete_prune_empty");
        let path = t.dir.join("tigerAgent.json");
        std::fs::write(
            &path,
            r#"{
  "recent_models": [ { "model": "qwen3.8-flash", "provider": "qwen38flash" } ],
  "providers": { "qwen38flash": { "name": "Qwen" } }
}"#,
        )
        .expect("写入样本配置");

        let removed =
            update_agent_config(|v| remove_provider_with_recent_models(v, "qwen38flash"))
                .expect("删除应成功");
        assert_eq!(removed, 1);

        let out = read_config(&path);
        assert!(out.get("recent_models").is_none(), "空列表必须整体移除字段");
    }

    /// provider 不存在：报错并放弃整次写入（文件内容一字不动）。
    #[test]
    fn delete_unknown_provider_leaves_file_untouched() {
        let t = temp_config_dir("delete_missing");
        let path = t.dir.join("tigerAgent.json");
        std::fs::write(&path, DELETE_SAMPLE).expect("写入样本配置");

        let err = update_agent_config(|v| remove_provider_with_recent_models(v, "nope"))
            .expect_err("删除不存在的 provider 必须失败");
        assert!(err.to_string().contains("未找到 provider"), "错误信息应指明原因");
        assert_eq!(std::fs::read_to_string(&path).expect("读回配置"), DELETE_SAMPLE);
    }

    // ---- write_agent_vision_model：supports_images 校验 ----

    const VISION_SAMPLE: &str = r#"{
  "providers": {
    "local": {
      "name": "Local",
      "models": [ { "id": "localModel", "name": "Local Model", "supports_images": true } ]
    },
    "visioncloud": {
      "name": "Vision Cloud",
      "base_url": "https://example.invalid/v1",
      "models": [ { "id": "gpt-4o", "name": "GPT-4o", "supports_images": true } ]
    },
    "textcloud": {
      "name": "Text Cloud",
      "base_url": "https://example.invalid/v1",
      "models": [
        { "id": "gpt-4o", "name": "GPT-4o", "supports_images": false },
        { "id": "deepseek", "name": "DeepSeek" }
      ]
    }
  }
}"#;

    fn read_vision_model(path: &std::path::Path) -> serde_json::Value {
        let out: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).expect("读回配置"))
                .expect("落盘后必须是合法 JSON");
        out["agent_vision_model"].clone()
    }

    fn assert_builtin_vision(v: &serde_json::Value) {
        assert_eq!(
            v,
            &serde_json::json!({ "provider": "tigerAgent", "model": "agent-models" }),
            "应回退为内置 tigerAgent/agent-models"
        );
    }

    /// 模型在 providers 中声明 supports_images=true：原样保留，返回 changed=true。
    #[test]
    fn vision_model_kept_when_supports_images_true() {
        let t = temp_config_dir("vision_kept");
        let path = t.dir.join("tigerAgent.json");
        std::fs::write(&path, VISION_SAMPLE).expect("写入样本配置");

        let changed = write_agent_vision_model("visioncloud/gpt-4o").expect("写入应成功");
        assert!(changed, "首次写入应报告变更");
        assert_eq!(
            read_vision_model(&path),
            serde_json::json!({ "provider": "visioncloud", "model": "gpt-4o" })
        );
    }

    /// 内置 Agent 特判：agent-models 永远有效。
    #[test]
    fn vision_model_builtin_kept() {
        let t = temp_config_dir("vision_builtin");
        let path = t.dir.join("tigerAgent.json");
        std::fs::write(&path, VISION_SAMPLE).expect("写入样本配置");

        assert!(write_agent_vision_model("tigerAgent/agent-models").expect("写入应成功"));
        assert_eq!(
            read_vision_model(&path),
            serde_json::json!({ "provider": "tigerAgent", "model": "agent-models" })
        );
    }

    /// 本地模型 local/localModel 且 supports_images=true：保留（不回退内置）。
    #[test]
    fn vision_model_local_kept_when_supports_images() {
        let t = temp_config_dir("vision_local");
        let path = t.dir.join("tigerAgent.json");
        std::fs::write(&path, VISION_SAMPLE).expect("写入样本配置");

        assert!(write_agent_vision_model("local/localModel").expect("写入应成功"));
        assert_eq!(
            read_vision_model(&path),
            serde_json::json!({ "provider": "local", "model": "localModel" })
        );
    }

    /// provider 不存在：回退内置并报告变更。
    #[test]
    fn vision_model_falls_back_when_provider_missing() {
        let t = temp_config_dir("vision_noprov");
        let path = t.dir.join("tigerAgent.json");
        std::fs::write(&path, VISION_SAMPLE).expect("写入样本配置");

        let changed = write_agent_vision_model("nope/gpt-4o").expect("写入应成功");
        assert!(changed, "校验失败改为内置应报告变更");
        assert_builtin_vision(&read_vision_model(&path));
    }

    /// supports_images=false 或字段缺失：同样回退内置。
    #[test]
    fn vision_model_falls_back_when_supports_images_not_true() {
        let t = temp_config_dir("vision_noimg");
        let path = t.dir.join("tigerAgent.json");
        std::fs::write(&path, VISION_SAMPLE).expect("写入样本配置");

        assert!(
            write_agent_vision_model("textcloud/gpt-4o").expect("写入应成功"),
            "supports_images=false 应回退内置"
        );
        assert_builtin_vision(&read_vision_model(&path));

        // 缺 supports_images 字段的模型：独立目录验证同样回退并报告变更
        let t2 = temp_config_dir("vision_noimg2");
        let path2 = t2.dir.join("tigerAgent.json");
        std::fs::write(&path2, VISION_SAMPLE).expect("写入样本配置");
        assert!(
            write_agent_vision_model("textcloud/deepseek").expect("写入应成功"),
            "缺 supports_images 字段应回退内置"
        );
        assert_builtin_vision(&read_vision_model(&path2));
    }

    /// 值未变化（目标已是当前值）：返回 false，调用方跳过服务端重载。
    #[test]
    fn vision_model_no_change_returns_false() {
        let t = temp_config_dir("vision_unchanged");
        let path = t.dir.join("tigerAgent.json");
        std::fs::write(&path, VISION_SAMPLE).expect("写入样本配置");

        assert!(write_agent_vision_model("visioncloud/gpt-4o").expect("首次写入应成功"));
        let changed = write_agent_vision_model("visioncloud/gpt-4o").expect("二次写入应成功");
        assert!(!changed, "值未变化必须返回 false，避免不必要的服务端重载");
    }

    /// 非法值（无 provider/model 分隔）回退内置。
    #[test]
    fn vision_model_bad_value_falls_back_to_builtin() {
        for bad in ["", "no-slash", "/model", "provider/"] {
            let t = temp_config_dir("vision_badval");
            let path = t.dir.join("tigerAgent.json");
            std::fs::write(&path, VISION_SAMPLE).expect("写入样本配置");
            let changed = write_agent_vision_model(bad).expect("写入应成功");
            assert!(changed, "非法值 {:?} 应回退内置并报告变更", bad);
            assert_builtin_vision(&read_vision_model(&path));
        }
    }

    /// 不变量 2：空文件拒绝写入，且不破坏原文件。
    #[test]
    fn update_rejects_empty_config_file() {
        let t = temp_config_dir("empty");
        let path = t.dir.join("tigerAgent.json");
        std::fs::write(&path, "").expect("写入空文件");

        let err = update_agent_config(|v| {
            v["agent_proxy"] = serde_json::json!(true);
            Ok::<(), AppError>(())
        });
        assert!(
            err.is_err(),
            "空文件必须拒绝写入：否则会被写成只含单个字段的残片，整份配置丢失"
        );

        assert_eq!(
            std::fs::read_to_string(&path).expect("读回"),
            "",
            "写入失败时不得改动原文件"
        );
    }

    /// 不变量 2：非法 JSON（截断到一半）同样拒绝写入。
    #[test]
    fn update_rejects_truncated_config_file() {
        let t = temp_config_dir("truncated");
        let path = t.dir.join("tigerAgent.json");
        std::fs::write(&path, r#"{"providers": {"local": {"nam"#).expect("写入半截文件");

        assert!(
            update_agent_config(|v| {
                v["agent_proxy"] = serde_json::json!(true);
                Ok::<(), AppError>(())
            })
            .is_err(),
            "半截 JSON 必须拒绝写入"
        );
    }

    /// 连续写入：每次落盘后都必须是合法且完整的 JSON，不得出现空文件。
    /// 这是对原子写（tmp + rename）的直接验证。
    #[test]
    fn repeated_writes_always_leave_valid_complete_json() {
        let t = temp_config_dir("repeat");
        let path = t.dir.join("tigerAgent.json");
        std::fs::write(&path, SAMPLE).expect("写入样本配置");

        for i in 0..50 {
            update_agent_config(move |v| {
                v["options"]["tui"]["compact_mode"] = serde_json::json!(i % 2 == 0);
                Ok::<(), AppError>(())
            })
            .expect("写入应成功");

            // 每次写完立刻读回：必须合法，且云端 provider 始终存在
            let raw = std::fs::read_to_string(&path).expect("读回配置");
            assert!(!raw.trim().is_empty(), "第 {} 次写后文件为空", i);
            let out: serde_json::Value = serde_json::from_str(&raw)
                .unwrap_or_else(|e| panic!("第 {} 次写后 JSON 非法: {}", i, e));
            assert_eq!(
                out["providers"]["mycloud"]["api_key"], "sk-test",
                "第 {} 次写后云端 provider 丢失",
                i
            );
        }
    }

    /// 原子写只在同目录留临时文件，成功后必须清理干净。
    #[test]
    fn atomic_write_leaves_no_temp_files() {
        let t = temp_config_dir("notmp");
        let path = t.dir.join("tigerAgent.json");
        std::fs::write(&path, SAMPLE).expect("写入样本配置");

        update_agent_config(|v| {
            v["agent_proxy"]["url"] = serde_json::json!("http://127.0.0.1:1/v1");
            Ok::<(), AppError>(())
        })
        .expect("写入应成功");

        let leftovers: Vec<_> = std::fs::read_dir(&t.dir)
            .expect("列出目录")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "残留临时文件: {:?}", leftovers);
    }

    // ---- MCP 配置（add / update / delete / list） ----

    fn mcp_default() -> McpServerView {
        McpServerView {
            name: "m1".to_string(),
            kind: "stdio".to_string(),
            command: "npx".to_string(),
            args: vec!["-y".to_string(), "@modelcontextprotocol/server-filesystem".to_string()],
            ..Default::default()
        }
    }

    /// 新增：写入 mcp.<name>，不动其它字段；同名重复新增报错。
    #[test]
    fn mcp_add_writes_entry_and_rejects_duplicates() {
        let t = temp_config_dir("mcp_add");
        let path = t.dir.join("tigerAgent.json");
        std::fs::write(&path, SAMPLE).expect("写入样本配置");

        let name = add_mcp_server_core(&mcp_default()).expect("新增应成功");
        assert_eq!(name, "m1");

        let out: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("读回配置"))
                .expect("合法 JSON");
        assert_eq!(out["mcp"]["m1"]["command"], "npx");
        assert_eq!(out["mcp"]["m1"]["args"][1], "@modelcontextprotocol/server-filesystem");
        assert_eq!(
            out["providers"]["mycloud"]["api_key"], "sk-test",
            "新增 MCP 不得影响其它字段"
        );

        assert!(add_mcp_server_core(&mcp_default()).is_err(), "同名重复新增必须报错");

        let listed = mcp_servers_from_value(&out);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].command, "npx");
        assert_eq!(listed[0].kind, "stdio");
    }

    /// 更新：名称可改（迁移 key），未编辑字段（enabled_tools）保留，空字段省略。
    #[test]
    fn mcp_update_renames_and_preserves_unknown_fields() {
        let t = temp_config_dir("mcp_update");
        let path = t.dir.join("tigerAgent.json");
        std::fs::write(
            &path,
            r#"{"mcp":{"old":{"type":"stdio","command":"npx","args":["a"],"enabled_tools":["t1"]}}}"#,
        )
        .expect("写入样本配置");

        let input = McpServerView {
            name: "new".to_string(),
            kind: "stdio".to_string(),
            command: "uvx".to_string(),
            ..Default::default()
        };
        let name = update_mcp_server_core("old", &input).expect("更新应成功");
        assert_eq!(name, "new");

        let out: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("读回配置"))
                .expect("合法 JSON");
        assert!(out["mcp"].get("old").is_none(), "旧 key 必须移除");
        assert_eq!(out["mcp"]["new"]["command"], "uvx");
        assert!(out["mcp"]["new"].get("args").is_none(), "未填参数时应省略旧 args");
        assert_eq!(out["mcp"]["new"]["enabled_tools"][0], "t1", "未知字段必须保留");

        assert!(
            update_mcp_server_core("missing", &input).is_err(),
            "目标不存在必须报错"
        );
    }

    /// 删除：移除条目；目标不存在时报错。
    #[test]
    fn mcp_delete_removes_entry() {
        let t = temp_config_dir("mcp_delete");
        let path = t.dir.join("tigerAgent.json");
        std::fs::write(
            &path,
            r#"{"mcp":{"a":{"type":"stdio","command":"x"},"b":{"type":"http","url":"https://e.com/mcp"}}}"#,
        )
        .expect("写入样本配置");

        delete_mcp_server_core("a").expect("删除应成功");
        let out: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("读回配置"))
                .expect("合法 JSON");
        assert!(out["mcp"].get("a").is_none());
        assert!(out["mcp"].get("b").is_some(), "其它 MCP 不得受影响");

        assert!(delete_mcp_server_core("a").is_err(), "重复删除必须报错");
    }

    /// 校验：名称字符 / stdio 命令 / http URL / 超时上限 / 类型缺省。
    #[test]
    fn mcp_validation_rules() {
        let validator = |v: McpServerView| validate_mcp_input(&v);

        assert!(validator(McpServerView {
            name: "  ".into(), kind: "stdio".into(), command: "npx".into(), ..Default::default()
        })
        .is_err(), "空名称");
        assert!(validator(McpServerView {
            name: "a b".into(), kind: "stdio".into(), command: "npx".into(), ..Default::default()
        })
        .is_err(), "非法字符");
        assert!(validator(McpServerView {
            name: "a".into(), kind: "stdio".into(), ..Default::default()
        })
        .is_err(), "stdio 缺命令");
        assert!(validator(McpServerView {
            name: "a".into(), kind: "http".into(), ..Default::default()
        })
        .is_err(), "http 缺 URL");
        assert!(validator(McpServerView {
            name: "a".into(), kind: "http".into(), url: "ftp://x".into(), ..Default::default()
        })
        .is_err(), "非 http(s) 协议");
        assert!(validator(McpServerView {
            name: "a".into(), kind: "stdio".into(), command: "npx".into(), timeout: 3601, ..Default::default()
        })
        .is_err(), "超时超上限");

        let (name, kind) = validate_mcp_input(&McpServerView {
            name: " ok ".into(), command: "npx".into(), ..Default::default()
        })
        .expect("合法配置应通过");
        assert_eq!(name, "ok", "名称应去首尾空白");
        assert_eq!(kind, "stdio", "缺省类型应为 stdio");
    }

    /// 列表：缺 type 视为 stdio，按名称排序。
    #[test]
    fn mcp_list_defaults_and_sorts() {
        let root = serde_json::json!({ "mcp": {
            "zeta": { "type": "http", "url": "https://z.example/mcp", "headers": { "Authorization": "Bearer x" } },
            "alpha": { "command": "npx" }
        }});
        let list = mcp_servers_from_value(&root);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].name, "alpha");
        assert_eq!(list[0].kind, "stdio", "缺省 type 必须回退 stdio");
        assert_eq!(list[1].name, "zeta");
        assert_eq!(list[1].url, "https://z.example/mcp");
        assert_eq!(list[1].headers["Authorization"], "Bearer x");
    }
}

#[cfg(test)]
mod sse_sub_agent_filter_tests {
    use super::*;

    fn ev(data: serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "type": "message", "payload": { "type": "created", "payload": data } })
    }

    #[test]
    fn normal_session_uuid_is_forwarded() {
        let p = ev(serde_json::json!({ "id": "m1", "session_id": "05068656-be01-43b1-aaa5-f9dffaa95e3d", "role": "assistant" }));
        assert!(!is_sub_agent_event(&p));
    }

    #[test]
    fn openai_style_nested_session_dropped() {
        let p = ev(serde_json::json!({ "session_id": "f16a88b6-fc15-496b-a03c-6ebdfe54b1c3$$call_abc123" }));
        assert!(is_sub_agent_event(&p));
    }

    #[test]
    fn qwen_style_nested_session_dropped() {
        // 真实事故样本（tigerAgent_debug 2026-09）：$$call_ 前缀不匹配导致误转发
        let p = serde_json::json!({ "type": "run_complete", "payload": { "type": "updated", "payload": {
            "session_id": "c5a4abbd-ec37-42ef-9e4f-e691f131b83a$$chatcmpl-tool-b577aa9f6c9ceb61",
            "run_id": "run-1788225954786-v2gyqeynm", "error": "context deadline exceeded" } } });
        assert!(is_sub_agent_event(&p));
    }

    #[test]
    fn tool_body_with_dollarsigns_not_misjudged() {
        // shell `$$` 出现在消息正文中不得误判为子 Agent（event_data.contains 旧写法会踩）
        let p = ev(serde_json::json!({ "session_id": "05068656-be01-43b1-aaa5-f9dffaa95e3d", "role": "tool", "content": "kill -INT -$$ 12345" }));
        assert!(!is_sub_agent_event(&p));
    }

    #[test]
    fn events_without_session_id_forwarded() {
        assert!(!is_sub_agent_event(&serde_json::json!({ "type": "config_changed" })));
        assert!(!is_sub_agent_event(&serde_json::json!({ "raw": "not-json" })));
    }
}

#[cfg(test)]
mod file_url_tests {
    use super::*;

    #[test]
    fn decodes_percent_encoded_file_urls() {
        assert_eq!(
            decode_file_url("file:///Users/a%20b/%E4%B8%AD.txt"),
            "/Users/a b/中.txt"
        );
        assert_eq!(decode_file_url("file://localhost/Users/x.txt"), "/Users/x.txt");
        assert_eq!(decode_file_url("/plain/path.txt"), "/plain/path.txt");
        assert_eq!(decode_file_url("file:///Users/100%.txt"), "/Users/100%.txt");
    }
}

#[cfg(test)]
mod server_workdir_tests {
    use super::*;

    #[test]
    fn selects_default_then_first_and_ignores_empty() {
        let view = serde_json::json!({
            "work_directories": [
                { "path": "/srv/a", "is_default": false },
                { "path": "/srv/b", "is_default": true }
            ]
        });
        assert_eq!(default_server_workdir(&view).as_deref(), Some("/srv/b"));

        let view = serde_json::json!({
            "work_directories": [{ "path": "/srv/a", "is_default": false }]
        });
        assert_eq!(default_server_workdir(&view).as_deref(), Some("/srv/a"));

        let view = serde_json::json!({ "work_directories": [] });
        assert_eq!(default_server_workdir(&view), None);

        let view = serde_json::json!({ "work_directories": [{ "path": "  " }] });
        assert_eq!(default_server_workdir(&view), None);
    }
}

#[cfg(test)]
mod cloud_provider_view_tests {
    use super::*;

    /// 服务端 /v1/settings 会把代码内置 provider（tigerAgent/agent-models）一并列出，
    /// 但它没有 base_url/api_key、不可编辑删除：设置列表只能出现用户添加的云端模型。
    #[test]
    fn builtin_and_local_providers_are_not_user_manageable() {
        let view = serde_json::json!({
            "providers": [
                {
                    "key": "tigerAgent",
                    "name": "tigerAgent",
                    "models": [{ "id": "agent-models", "context_window": 200000 }]
                },
                {
                    "key": "local",
                    "name": "Local",
                    "models": [{ "id": "localModel" }]
                },
                {
                    "key": "mycloud",
                    "name": "My Cloud",
                    "base_url": "https://example.invalid/v1",
                    "has_key": true,
                    "models": [{ "id": "m1", "context_window": 128000, "supports_images": true }]
                }
            ]
        });

        let list = cloud_providers_from_settings(&view);
        assert_eq!(list.len(), 1, "内置/本地 provider 不得进入可管理列表");
        assert_eq!(list[0].key, "mycloud");
        assert_eq!(list[0].model_id, "m1");
        assert!(list[0].has_key);
        assert!(list[0].supports_images);
    }
}
