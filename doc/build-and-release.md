# 构建与发布

> 范围：CI、服务端分发（桌面端默认不打包）、各平台打包与更新链路。

---

## 服务端分发（桌面端默认不打包服务端）

- **默认不打包、也不启动**：`tauri.conf.json` 不声明 `bundle.externalBin`，也没有 `beforeDevCommand`/`beforeBuildCommand` 钩子；安装包里**没有** Agent 二进制，运行时也不会拉起任何服务端进程。桌面端只有一种连接方式（`docs/tcp-tls-ecdsa.md`）：TCP + TLS 1.3 连接用户在服务器侧自行启动的服务端，设置页只粘贴一条连接串（地址 + 服务端指纹 + token），客户端不生成设备身份，也不依赖任何外部二进制。
- **可选“带服务端”构建**：如需回到内置 sidecar 方案，恢复 `bundle.externalBin = ["binaries/Agent"]` 并在 `build` 里加回 `beforeDevCommand`/`beforeBuildCommand = "node scripts/prepare-agent-binary.mjs"`；`scripts/prepare-agent-binary.mjs` 与 `pnpm agent:push` 仅在这个可选流程里仍有用。
- **服务端发布**：Go 侧编译产物（`tigerAgent.exe` / `tigerAgent`）单独分发（GitHub Release / 包管理器），用户自行安装并在服务器侧启动（`tigerAgent --host tcp://0.0.0.0:<端口>`，启动时打印客户端连接串），桌面端只连不管进程。

## Linux 打包与更新链路

- **Linux 打包 / 更新链路**：`tauri.conf.json` 的 `bundle.linux.deb.depends` 必须显式写（Tauri 2 不再用 dpkg-shlibdeps 自动推导依赖，留空会导致 `apt install ./Tiger_*.deb` 后缺 webkit2gtk 起不来）：`libwebkit2gtk-4.1-0`、`libgtk-3-0 | libgtk-3-0t64`（24.04 起改名为 t64，用 alternative 兼容）、`libayatana-appindicator3-1`（托盘，dlopen 加载，推导不到）。`lib.rs` 的托盘创建失败**不再阻断启动**（Linux 无 StatusNotifier 宿主时只打日志）。`types.rs` 的 `UpdateInfo` 有 `linux` 字段（`check_update` 的 linux 分支取它），update.json 需补 `"linux": {"appUrl","content"}` 才能在 Linux 上提示更新。

## 构建与发布

- CI：仓库根目录 `.github/workflows/build.yml`（服务端与桌面端统一的唯一 CI；原 `desktop/.github/workflows/build.yml`、`.github/workflows/release.yml` 已合并删除）— 标签触发（`v*`）或手动触发（`workflow_dispatch`）。**6 个任务并行编译**：服务端 `windows-latest` / `macos-latest` / `ubuntu-latest` 各一个，桌面端三个平台各一个；标签触发时六个任务全部成功后由 `publish` 任务汇总产物、生成 `checksums.txt` 并发布 GitHub Release（手动触发只上传 workflow artifact，不发布）。不再 checkout `adm-binaries`（默认不打包服务端）。桌面端三个平台：Windows x64（NSIS，自签名）、macOS aarch64（DMG，自签名）、Linux x86_64（`ubuntu-22.04` + deb/AppImage；用 22.04 是因为 AppImage 的 linuxdeploy 需要较老 glibc，构建前 apt 安装 webkit2gtk-4.1 等系统依赖）。桌面端步骤都在 `desktop/` 目录内执行 `pnpm tauri build --target ... --bundles ...`，不再用 `tauri-action` 发版（发布统一由 `publish` 任务做）。
- **macOS 必须 `--bundles app,dmg`**：Tauri 只勾 `dmg` 时，打完 dmg 会删掉中间产物 `.app`（tauri-bundler 里「Clean up .app if only building dmg or updater」），随后的「macOS 自签名」步骤就没有 `.app` 可签，CI 直接失败。真正的自签名靠 `tauri.conf.json` 的 `bundle.macOS.signingIdentity = "-"`（ad-hoc 签名，打包时连同 `entitlements.plist` 一起签），这样 **dmg 内那份 app 在生成 dmg 之前就已签好**；CI 里的自签名步骤只对保留下来的 `.app` 补签并 `codesign -vvv` 校验（它不改 dmg 里的副本）。本地 `pnpm tauri:build:macos` 同样带 `app`。
- 产物命名：服务端包名带 `_server`（`tigerAgent_<版本>_<Os>_<arch>_server.zip|tar.gz`），客户端安装包由 CI 的「重命名客户端产物」步骤在扩展名前插 `_desktop`（`Tiger_<版本>_aarch64_desktop.dmg`、`Tiger_<版本>_x64-setup_desktop.exe`、`Tiger_<版本>_amd64_desktop.deb|AppImage`）——Tauri 不支持自定义产物文件名，只能在打包后改名，改名发生在签名之后、上传之前。
- 服务端产物不再走 GoReleaser：`server-*` 任务用 `go build`（`CGO_ENABLED=0` + `GOEXPERIMENT=greenteagc` + 版本 ldflags）编译，再打成与 `.goreleaser.yml` 同名的包（`tigerAgent_<版本>_<Os>_<arch>_server.zip|tar.gz`，zip 同样包一层同名目录）；`completions/`、`manpages/tigerAgent.1.gz` 由各平台宿主二进制生成（Windows 上 manpage 压缩用 .NET `GZipStream`，不依赖 bash 的 `gzip`）。`.goreleaser.yml` 保留仅供本地 goreleaser 使用。
- 发布：`publish` 任务只汇总带 `_server` / `_desktop` 后缀的产物（旧命名或无后缀的文件直接跳过），生成 `checksums.txt`，先清空该标签 Release 的既有资产再上传（同一标签重跑不会残留上一轮文件），用 `softprops/action-gh-release` 发布（标签带 `-` 时标为 pre-release），发布说明由 GitHub 自动生成。
- 可选带服务端构建按平台选包（`scripts/prepare-agent-binary.mjs` 的 `platformSpec`）：Windows `_Windows_x86_64[_server].zip`、macOS `_Darwin_arm64[_server].tar.gz`、Linux `_Linux_x86_64[_server].tar.gz`（仅 x86_64；`_server` 在正则里可选，兼容旧包名），新增平台需同时加匹配规则与 CI matrix。
- 服务端更新：编译 Go 侧（`build.ps1` / `build.sh`）后单独分发；可选流程才需要 `pnpm agent:push` 覆盖 `adm-binaries` 远端。
- **发布前手动跑一次 agent 行为 eval**：`Agent/scripts/eval.sh`（Windows `Agent\scripts\eval.ps1`），退出码 `0` 通过 / `1` 回归（需查 `out/eval/summary.md` 的翻转表再决定是否发） / `2` 跳过（无云端模型）。**eval 不接入构建链路**，`build.ps1` / `build.sh` 不会自动调用它，漏跑等于没有门禁。规则见 [agent-eval-harness-plan.md](agent-eval-harness-plan.md)。
- 发布：`pnpm tauri:build:<平台>` 然后 `pnpm sign:<平台>`。
- 图标：`python scripts/generate-icons.py` 从 `src-tauri/icons/source.png` 生成。

## 发布镜像到公开仓库

- **为什么要镜像**：源码、CI 和原始 Release 都在私有开发仓库 `litai686/TigerAgent`，而用户下载走公开仓库 `litai686/tiger`（`desktop/README.md` 指向它的 Releases）。两个仓库的 Release 不会自动同步，所以发版后要手动跑一次镜像脚本。
- **脚本**：仓库根目录 `sync-release.sh`（Windows 上 `bash sync-release.sh`，脚本未提交可执行位时同理）。本机已经用 `gh auth login` 或 HTTPS 方式登录过 GitHub 时，**不需要再配令牌**，直接跑即可。默认源 `litai686/TigerAgent`、目标 `litai686/tiger`，可用 `--src-repo` / `--dst-repo` 覆盖；`--tag` 指定源仓库某个版本，默认取**最近一次已发布**的 Release（`/releases/latest` 取不到时回退到 Release 列表里第一条非草稿）。镜像内容：标题、说明正文、全部附件、pre-release 标记；非 pre-release 时带 `make_latest`，把它设为目标仓库的 latest。
- **可重跑**：目标仓库已有同名 tag 时走 PATCH 更新标题/说明，同名附件先删后传（GitHub 不接受重名上传）。源里已删掉的附件、其他 tag 的 Release 都不动，要下线某个版本得手工删目标仓库的 Release。`--dry-run` 只读两个仓库并打印计划。
- **tag 不会带源码**：两个仓库历史无关，目标仓库缺该 tag 时由 Release API 在 `--target` 指定的分支/提交上新建（默认目标仓库默认分支），tag 只代表版本号，不对应目标仓库里的源码提交——不要把目标仓库当源码仓库用。
- **认证与依赖**：令牌按顺序取——`GH_TOKEN` / `GITHUB_TOKEN` 环境变量 → `gh auth token`（本机装过 gh 且登录过就直接可用）→ git 凭据管理器里存过的 GitHub HTTPS 令牌（Git Credential Manager 存的就是 OAuth/PAT，Windows 上 HTTPS `git push` 过一次通常就有）→ 明文 `~/.git-credentials`。**SSH key 不够**：它只能 push，调 Releases API 必须有 HTTP 令牌。都没有就手工建：classic PAT 勾 `repo` 即可（私有源仓库读 + 目标仓库写），或 fine-grained 选中两个仓库给 `Contents: Read and write`（<https://github.com/settings/tokens>）；CI 里跨仓库时 Actions 自带的 `GITHUB_TOKEN` 也不行。**诊断要点**：没有可用令牌时 GitHub 对私有仓库一律回 `404`（和「仓库不存在 / 没有 Release」同一个状态码），所以脚本会先探 `/repos/{owner}/{repo}` 再判断，报「看不到仓库」就是缺令牌或无权限；`令牌来源:` 那行会告诉你这次用的是哪一层。依赖只有 `curl` + `python`（解析 JSON），不需要 `gh` / `jq`。说明正文末尾默认追加一行「镜像自上游 …」，`--no-footer` 可关掉。
