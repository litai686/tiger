//! 平台相关的进程工具。
//!
//! 本机硬件采集（CPU / 内存 / GPU 枚举）已随「硬件信息改由服务端提供」移除：
//! `pages/index.rs` 的 `get_system_info` 只读服务端 `GET /v1/system/info`。

/// 让子进程独立于父进程启动（Unix 上创建新会话/进程组），
/// 这样关闭时才能用 `kill -9 -<pgid>` 一次性杀掉整棵进程树，避免孤儿残留。
#[cfg(not(target_os = "windows"))]
pub fn spawn_detached(cmd: &mut std::process::Command) -> std::io::Result<std::process::Child> {
    use std::os::unix::process::CommandExt;
    // process_group(0) 表示新建进程组，pgid 等于新进程自身的 pid
    cmd.process_group(0);
    // Command 的 builder 方法（args/stdout/stderr/env 等）均返回 &mut Self，
    // 因此调用方传入的链式表达式类型为 &mut Command，这里按可变引用接收，
    // spawn(&mut self) 同样基于可变引用执行。
    cmd.spawn()
}
