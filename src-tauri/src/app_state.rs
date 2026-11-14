use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

/// Agent 服务端会话：每个 workspace 一个独立会话，持有该 workspace 的
/// SSE 转发任务。服务端由用户自行启动（TCP + TLS），桌面端不管理其进程。
pub struct AgentServerSession {
    /// SSE 转发任务停止标志
    pub sse_stop: Arc<AtomicBool>,
    /// SSE 转发任务句柄
    pub sse_task: Option<tokio::task::JoinHandle<()>>,
    /// 工作区 ID（与 HashMap key 相同，保留用于调试/日志）
    #[allow(dead_code)]
    pub workspace_id: String,
    /// 客户端 ID（UUID）
    pub client_id: String,
}

pub struct AppState {
    /// 多 workspace 会话（按 workspace_id 索引）
    pub agent_sessions: Mutex<HashMap<String, AgentServerSession>>,
    /// 当前激活的 workspace ID（用于微信路由等需要"当前 tab"的场景）
    pub active_workspace_id: Mutex<Option<String>>,
    /// 连接服务端 / 建 workspace 会话的单飞锁
    pub agent_start_lock: tokio::sync::Mutex<()>,
    /// config.json 读-改-写 互斥锁（防止前端操作与微信端指令并发写 config.json 互相覆盖）
    pub config_write_lock: std::sync::Mutex<()>,
    /// 系统托盘是否创建成功。托盘菜单是「退出」的唯一入口，因此关闭窗口前必须判断：
    /// 托盘不可用（Linux 缺 libayatana-appindicator3 / 桌面无 StatusNotifier 宿主）时
    /// 只能直接退出，隐藏窗口会让进程留在后台且界面里再也无法退出
    pub tray_available: AtomicBool,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            agent_sessions: Mutex::new(HashMap::new()),
            active_workspace_id: Mutex::new(None),
            agent_start_lock: tokio::sync::Mutex::new(()),
            config_write_lock: std::sync::Mutex::new(()),
            tray_available: AtomicBool::new(false),
        }
    }
}
