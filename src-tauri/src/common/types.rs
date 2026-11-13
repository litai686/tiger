use serde::{Deserialize, Serialize};

#[derive(Serialize, Clone)]
pub struct SystemInfo {
    pub total_ram: u64,
    pub used_ram: u64,
    pub total_vram: u64,
    pub used_vram: u64,
    pub has_gpu: bool,
    pub cpu_usage: f32,
    pub cpu_physical_cores: usize,
    pub cpu_logical_cores: usize,
    /// 每张显卡的详细信息（多卡时含多张，单卡/无卡时长度为 1 或 0）
    pub gpus: Vec<GpuInfo>,
}

#[derive(Serialize, Clone, Debug)]
pub struct GpuInfo {
    /// 显卡名称，如 "NVIDIA GeForce RTX 4090"
    pub name: String,
    /// 总显存（字节），0 = 未知；集成显卡该值不可信（共享内存不计入）
    pub total_vram: u64,
    /// 已用显存（字节），0 = 未知
    pub used_vram: u64,
    /// 是否为集成显卡（核显）
    pub is_integrated: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WorkDirEntry {
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub is_default: bool,
}

fn default_thinking_enabled() -> bool { true }

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Settings {
/// 已弃用：单个工作目录（迁移到 agent_workdirs 后仅用于向后兼容读取）
#[serde(default)]
pub agent_workdir: String,
    /// 工作目录列表（数组模式），is_default=true 的为当前默认目录
    #[serde(default)]
    pub agent_workdirs: Vec<WorkDirEntry>,
    /// Agent 默认 Provider（如 "local" / "xiaomimimo" 等）
#[serde(default)]
pub agent_default_provider: String,
#[serde(default = "default_thinking_enabled")]
pub agent_thinking_enabled: bool,
/// Agent 推理强度（low / medium / high）
#[serde(default)]
pub agent_reasoning_effort: String,
/// Agent 采样温度
#[serde(default)]
pub agent_temperature: Option<f64>,
/// 调试模式：开启后在软件根目录记录 admAgent API/SSE 交互日志（每次重启自动清空）
#[serde(default)]
pub debug_logging: bool,
/// 界面语言（"zh" 中文 / "en" English，空或未知回退中文）
#[serde(default)]
pub language: String,
/// Agent 多模态模型（图片识别）："provider/model" 复合键，如 "admAgent/adm-models"（默认）。
/// 空或缺失 = 内置 adm-models；同步写入 admAgent.json 顶层 agent_vision_model 供 vision 子命令读取
#[serde(default)]
pub agent_vision_model: String,
/// HTTP 代理配置（同步写入 admAgent.json 顶层 agent_proxy，供 admAgent 读取并应用到 LLM 客户端和 HTTP 工具）
#[serde(default)]
pub agent_proxy: AgentProxyConfig,
/// 开启所有工具调用：关闭 admAgent 内置的 bash 命令黑名单（sudo / apt / systemctl 等提权、
/// 包管理与系统管理命令变为可调用），同步写入 admAgent.json 的 options.bash_allow_all
#[serde(default)]
pub agent_allow_all_tools: bool,
/// 同目录多会话并行：允许同一工作目录内多个会话同时运行（服务端本就按会话分发，
/// 开启后桌面端不再拦截新会话的发送）。
/// 注意：默认关闭，且这里必须用 `#[serde(default)]`（= false）与 `Settings::default()`
/// 保持一致——`load_settings` 在 config.json 缺失时返回 `Settings::default()`，
/// 若字段默认值与之相反，全新安装下开关的实际状态会与文档/UI 文案矛盾。
#[serde(default)]
pub agent_concurrent_sessions: bool,
/// 压缩上下文时自动提取记忆规则：关闭后 admAgent 每次上下文压缩不再把会话里的
/// 约束/决策沉淀进跨会话项目记忆（已有条目保留并继续注入）。
/// 同步写入 admAgent.json 的 options.project_memory_sync。
/// 默认开启，故用 `Option<bool>` 表达「未设置」：`Settings::default()`（config.json
/// 缺失、解析失败、首次写盘等路径直接落盘的那一份）给的是 None，不会被当成用户
/// 主动「关闭」写进磁盘；None 一律按开启处理（前端 `!== false`、Rust `unwrap_or(true)`）。
#[serde(default, skip_serializing_if = "Option::is_none")]
pub agent_project_memory_sync: Option<bool>,
/// 服务端连接模式与远程配置（docs/tcp-tls-ed25519.md §11.2）。
/// 缺失 = 本地模式（同机 sidecar，不启用 TLS）。
#[serde(default)]
pub server: ServerSettings,
}

/// 服务端连接设置。
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct ServerSettings {
    /// "local"（默认）或 "remote"。空值按 local 处理。
    #[serde(default)]
    pub mode: String,
    /// 远程服务端配置（mode=remote 时使用）
    #[serde(default)]
    pub remote: RemoteServerConfig,
}

/// 远程服务端配置：地址 + 服务端 SPKI pin。
/// 只保存公开信息；设备私钥/证书在 `<app_data>/device/`（§11.4）。
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct RemoteServerConfig {
    /// 服务端地址，`host:port`（如 192.168.1.20:18471）
    #[serde(default)]
    pub addr: String,
    /// SNI，默认 `tigerAgent.local`（与服务端 SAN 一致）
    #[serde(default)]
    pub sni: String,
    /// 服务端 SPKI 指纹 `sha256:...`（带外获取，不能靠首连探测）
    #[serde(default)]
    pub fingerprint: String,
    /// 首次配对成功时间（仅展示）
    #[serde(default)]
    pub paired_at: String,
}

/// 代理配置（仅 admAgent 使用，桌面端业务请求不走代理）
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct AgentProxyConfig {
    /// 是否启用代理
    #[serde(default)]
    pub enabled: bool,
    /// 代理地址，如 "http://127.0.0.1:7890" 或 "socks5://127.0.0.1:1080"
    #[serde(default)]
    pub url: String,
}

// ===== 自动更新相关结构 =====

#[derive(Serialize, Deserialize, Clone)]
pub struct PlatformUpdate {
    #[serde(rename = "appUrl")]
    pub app_url: String,
    pub content: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct UpdateInfo {
    pub version: String,
    #[serde(rename = "admAgentVersion")]
    pub adm_agent_version: Option<String>,
    pub windows: Option<PlatformUpdate>,
    #[serde(rename = "mac")]
    pub mac_os: Option<PlatformUpdate>,
    /// update.json 的 `linux` 字段（AppImage / deb 的下载地址，缺失则该平台不提示下载）
    pub linux: Option<PlatformUpdate>,
}

#[derive(Serialize, Clone)]
pub struct UpdateCheckResult {
    pub has_update: bool,
    pub remote_version: String,
    pub current_version: String,
    pub download_url: Option<String>,
    pub changelog_url: Option<String>,
}
