# 构建与发布

> 范围：CI、服务端分发（桌面端默认不打包）、各平台打包与更新链路。

---

## 服务端分发（桌面端默认不打包服务端）

- **默认不打包**：`tauri.conf.json` 不声明 `bundle.externalBin`，也没有 `beforeDevCommand`/`beforeBuildCommand` 钩子；安装包里**没有** admAgent 二进制。桌面端两种连接模式（`docs/tcp-tls-ed25519.md` §11）：`local` 连本机已安装的服务端（先查程序目录、再查 `PATH` 里的 `admAgent`/`tigerAgent`，都找不到且本机没有已运行的 server 时直接报错并引导改用远程模式），`remote` 连远端 TLS 服务端。设备身份由本机 rcgen 自签（`common/device_identity.rs`），不依赖任何外部二进制。
- **可选“带服务端”构建**：如需回到内置 sidecar 方案，恢复 `bundle.externalBin = ["binaries/admAgent"]` 并在 `build` 里加回 `beforeDevCommand`/`beforeBuildCommand = "node scripts/prepare-agent-binary.mjs"`；`scripts/prepare-agent-binary.mjs` 与 `pnpm agent:push` 仅在这个可选流程里仍有用。
- **服务端发布**：Go 侧编译产物（`tigerAgent.exe` / `tigerAgent`）单独分发（GitHub Release / 包管理器），用户自行安装并加入 PATH，或只在远端服务器部署后用桌面端 `remote` 模式连接。

## Linux 打包与更新链路

- **Linux 打包 / 更新链路**：`tauri.conf.json` 的 `bundle.linux.deb.depends` 必须显式写（Tauri 2 不再用 dpkg-shlibdeps 自动推导依赖，留空会导致 `apt install ./adm.deb` 后缺 webkit2gtk 起不来）：`libwebkit2gtk-4.1-0`、`libgtk-3-0 | libgtk-3-0t64`（24.04 起改名为 t64，用 alternative 兼容）、`libayatana-appindicator3-1`（托盘，dlopen 加载，推导不到）。`lib.rs` 的托盘创建失败**不再阻断启动**（Linux 无 StatusNotifier 宿主时只打日志）。`types.rs` 的 `UpdateInfo` 有 `linux` 字段（`check_update` 的 linux 分支取它），update.json 需补 `"linux": {"appUrl","content"}` 才能在 Linux 上提示更新。

## 构建与发布

- CI：仓库根目录 `.github/workflows/build.yml`（服务端与桌面端统一的唯一 CI；原 `desktop/.github/workflows/build.yml`、`.github/workflows/release.yml` 已合并删除）— 标签触发（`v*`）或手动触发（`workflow_dispatch`）。**6 个任务并行编译**：服务端 `windows-latest` / `macos-latest` / `ubuntu-latest` 各一个，桌面端三个平台各一个；标签触发时六个任务全部成功后由 `publish` 任务汇总产物、生成 `checksums.txt` 并发布 GitHub Release（手动触发只上传 workflow artifact，不发布）。不再 checkout `adm-binaries`（默认不打包服务端）。桌面端三个平台：Windows x64（NSIS，自签名）、macOS aarch64（DMG，自签名）、Linux x86_64（`ubuntu-22.04` + deb/AppImage；用 22.04 是因为 AppImage 的 linuxdeploy 需要较老 glibc，构建前 apt 安装 webkit2gtk-4.1 等系统依赖）。桌面端步骤都在 `desktop/` 目录内执行 `pnpm tauri build --target ... --bundles ...`，不再用 `tauri-action` 发版（发布统一由 `publish` 任务做）。
- 服务端产物不再走 GoReleaser：`server-*` 任务用 `go build`（`CGO_ENABLED=0` + `GOEXPERIMENT=greenteagc` + 版本 ldflags）编译，再打成与 `.goreleaser.yml` 同名的包（`tigerAgent_<版本>_<Os>_<arch>.zip|tar.gz`，zip 同样包一层同名目录）；`completions/`、`manpages/tigerAgent.1.gz` 由各平台宿主二进制生成（Windows 上 manpage 压缩用 .NET `GZipStream`，不依赖 bash 的 `gzip`）。`.goreleaser.yml` 保留仅供本地 goreleaser 使用。
- 发布：`publish` 任务汇总服务端 + 桌面端共 6 个 workflow artifact，生成 `checksums.txt`，用 `softprops/action-gh-release` 发布（标签带 `-` 时标为 pre-release），发布说明由 GitHub 自动生成。
- 可选带服务端构建按平台选包（`scripts/prepare-agent-binary.mjs` 的 `platformSpec`）：Windows `_Windows_x86_64.zip`、macOS `_Darwin_arm64.tar.gz`、Linux `_Linux_x86_64.tar.gz`（仅 x86_64），新增平台需同时加匹配规则与 CI matrix。
- 服务端更新：编译 Go 侧（`build.ps1` / `build.sh`）后单独分发；可选流程才需要 `pnpm agent:push` 覆盖 `adm-binaries` 远端。
- **发布前手动跑一次 agent 行为 eval**：`admAgent/scripts/eval.sh`（Windows `admAgent\scripts\eval.ps1`），退出码 `0` 通过 / `1` 回归（需查 `out/eval/summary.md` 的翻转表再决定是否发） / `2` 跳过（无云端模型）。**eval 不接入构建链路**，`build.ps1` / `build.sh` 不会自动调用它，漏跑等于没有门禁。规则见 [admAgent-eval-harness-plan.md](admAgent-eval-harness-plan.md)。
- 发布：`pnpm tauri:build:<平台>` 然后 `pnpm sign:<平台>`。
- 图标：`python scripts/generate-icons.py` 从 `src-tauri/icons/source.png` 生成。
