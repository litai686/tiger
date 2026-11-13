# Rust 后端（桌面端，`src-tauri/src/`）

> 范围：Rust 侧命令地图、应用自升级、下载链路与平台差异。构建/发布流程见 `doc/build-and-release.md`。

---

## 模块与关键命令

| 模块 | 关键命令 |
|--------|-------------|
| `index.rs` | `get_system_info`（底部硬件栏）, `check_update`, `download_app_update`, `install_app_update`（应用自升级，见下） |
| `settings.rs` | `save_settings'（原子写入：`.tmp` + `rename`）, `load_settings`, `get_app_version`, `get_tauri_version` |
| `agent.rs` | `start_agent_server`, `stop_agent_server`, `get_agent_server_status`, `agent_http_request`, `agent_subscribe_events`, `agent_unsubscribe_events`, `check_adm_agent`, `get_adm_agent_version`, `add/list/update/delete_cloud_provider`, `probe_models_endpoint`（请求云端模型的 OpenAI 兼容 `{base}/models`，10s 超时，返回模型 ID 列表；走 Rust 是为了绕开 WebView 的 CORS，同 `fetch_skill_store`）、`check_git_repo`（撤销能力探测，见下） |

## 关键注意事项（自升级 / 下载 / 检测）

- **软件自升级（桌面端，静默下载 → 提示升级）**：启动 3 秒后的更新检查发现新版本时**不再弹窗**，改为后台静默下载安装包到 `app_data_dir/updates`（文件名 `ADM-<版本>-<URL 文件名>`；**必须带版本号**，否则下载地址不带版本号时同名文件会被断点续传逻辑当成"已下载完成"，用户升到的还是旧版本），下载完成后才弹窗询问是否立即升级。前端状态机在 `index.html`（`appUpdate{status: downloading|ready|error}`；统一入口 `window.ADM.startAppUpdate(result,{manual})`，settings 页「检查新版本」复用同一入口并在 manual 时展示下载进度）：选「稍后再说」保留安装包，重启后同名文件存在即秒回已就绪并再次提示；选「跳过此版本」写 localStorage `adm_skip_update_version`，静默检查不再打扰、手动检查仍提示。Rust 端两个命令（`pages/index.rs`，已在 `lib.rs` 注册）：`download_app_update(version,url)`（发 `app-update-progress` 事件、下载前清理其它版本残留包）、`install_app_update(path)`（只允许运行 updates 目录内的文件 → 拉起/执行安装 → `cleanup_processes` + `app.exit(0)`；安装包 Windows 用 `DETACHED_PROCESS|CREATE_NEW_PROCESS_GROUP` 并尝试脱离 Job，macOS 走 `open <dmg>`，Linux 按扩展名分流——**deb 必须走包管理器，直接 exec 会 ENOEXEC**：`pkexec --disable-internal-agent env DEBIAN_FRONTEND=noninteractive apt-get install -y --allow-downgrades --no-install-recommends <deb>`，输出重定向到 `<包名>.install.log` 且必须等退出码（失败/授权取消时保持应用运行，弹窗展示 `sudo apt install` 指引与 apt 输出尾段；`--disable-internal-agent` 防止 pkexec 内部文本代理从 null stdin 读密码把弹窗挂到超时），AppImage 则在 `$APPIMAGE` 存在时用临时文件 + rename 覆盖当前 AppImage 后再启动，否则只补可执行位拉起）。该命令为 async + `spawn_blocking`：Linux 等待安装可能耗时数十秒，不能占住 async 运行时。前端失败标题按 `appUpdate.phase`（download/install）区分，安装阶段失败用 `getErrorMessage` 原样展示后端中文指引（**不能走 friendlyError**——指引里含 `sudo`/路径等英文会被整段丢弃，只剩"操作失败，任务中断"，这正是 0.7.4→0.7.5 Linux 升级报错的成因）。安装包目录用 `app_data_dir` 而非 exe 目录（Program Files 下不可写）。升级提示会等其它弹窗关闭后再弹（`updateDialogOwner !== "app-update"` 时挂起），避免互相覆盖。
- **撤销能力探测（`check_git_repo`）**：Agent 的「撤销」靠 admAgent 每轮开始前的 git 工作树快照回退文件改动，非 git 仓库（或机器没装 git）时服务端只能删消息、文件改动留在原地。`check_git_repo(path)` 在目标目录跑 `git rev-parse --is-inside-work-tree`，返回 `{git_installed, is_repo}`——两个字段必须分开：spawn 的 `NotFound` = 没装 git，装了但不是仓库 = 另一条提示语。**不要改成只看 `.git` 目录**：工作目录可能是仓库子目录，`.git` 也可能是文件（worktree / submodule）。前端 `undo.js` 按工作目录缓存结果，只在确认弹窗里加提示、不禁用撤销入口（对话记录仍能回滚）。
- **硬件优先级**：`hwinfo` 插件数据覆盖 `sysinfo`。

## 平台差异

- **Windows**：`main.rs` 中的 `#![windows_subsystem = "windows"]` + `build.rs` 中的 `/SUBSYSTEM:WINDOWS` 隐藏控制台。
- **Linux**：数据目录（config.json / agent 数据）与 macOS 一致走用户数据目录（`config.rs` 的 `get_data_dir` → `~/.local/share/com.adm.admapp`）——deb 装在 `/usr/bin`、AppImage 是只读挂载点，写 exe 同目录必然失败；桌面端**默认不打包服务端**，本地模式按「程序目录 → PATH」查找用户自行安装的 `admAgent`/`tigerAgent`（`agent.rs` 的 `resolve_local_agent`），远程模式则完全不启动本地服务端。

## 进程清理

- **窗口关闭**：`on_window_event` 走 `cleanup_processes`——只清理 admAgent server 子进程（本进程拉起的才杀），不再有本地推理进程需要回收。
