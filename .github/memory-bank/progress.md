# Progress

## Status
- **Current Version**: 2.1.3 (Release Prep)
- **Development Branch**: `develop`
- **Stable Branch**: `master`

## Completed Features
- [x] **CI Build Stability**:
    - GitHub Actions 工作流已显式固定 `node-gyp` 使用 `actions/setup-python` 安装的 Python 3.10，降低 Windows 平台因 Python 3.12 缺少 `distutils` 导致的原生模块重编译失败风险。
    - 已定位 macOS `universal` 打包失败根因为：Xray 的 macOS 二进制在进入 electron-builder 的 universal 合并流程前需要按实际架构状态处理；若是 fat/universal 需要先裁剪，若本身已是目标单架构则不能再无条件执行 `lipo -thin`。
    - 已在 `packages/gui/scripts/download-xray.js` 中加入 `lipo -archs` 架构检测，仅对 fat/universal 的 macOS Xray 二进制执行 `lipo -thin`，并在已为目标单架构时直接复用，恢复 `universal` DMG 构建链路。
    - `build-and-release.yml` 与 `test-and-upload.yml` 已同步固定 Python 解释器，避免两个工作流在 Windows 原生模块重建行为上出现漂移。
- [x] **Submit Workflow Hardening**:
    - `submit.sh --push-public` 已改为基于 `git cherry` 做 patch-id aware 去重，避免公共分支重复同步等价补丁。
    - 公共同步会自动启用 `git rerere` / `rerere.autoupdate`，复用历史冲突解决结果。
    - 默认使用 `ours` 自动收敛 `--push-public` 冲突，并支持 `SUBMIT_PUBLIC_CONFLICT_STRATEGY=theirs` 覆盖默认策略。
    - 在 `git cherry-pick -X <strategy>` 仍有未合并路径时，会继续对剩余冲突文件执行 `--ours/--theirs` 强制收敛并自动 `git cherry-pick --continue`。
    - 当自动解决后发现 cherry-pick 已变成空提交时，会自动执行 `git cherry-pick --skip`，避免脚本停在公共分支等待人工处理。
    - 已移除自动代理探测 / git proxy 自动改写逻辑，避免脚本隐式修改网络配置。
    - 已新增 `--sync-upstream`，支持把 `docmirror/dev-sidecar` 的公共更新合并到本地公共分支并回灌到 `develop`，同时显式排除 `upstream` remote 的推送路径。
    - 已修复 `--push-public` 对已领先远程的公共分支误做 `git pull --rebase` 的问题，改为按 ahead/behind 状态选择跳过、fast-forward 或 merge，避免真实仓库执行时掉进 detached HEAD 的 rebase 冲突状态。
    - 已完成 shell 语法检查、patch-id skip 集成测试，以及真实文本冲突场景下的自动重试策略测试。
- [x] **DevOps**: 
    - 自动化 Release Notes 生成 (Based on CHANGELOG)。
    - `submit.sh` 脚本优化（修复中文文件名支持）。
- [x] **Xray Plugin**: 
    - 内置打包 Xray Core 二进制文件与 `*.dat` 资源（自动下载构建），开箱即用，无需手动配置 `binPath`。
    - 集成 Xray Core，支持 VLESS, VMess, Trojan, ShadowSocks, Reality 等高级协议。
    - 支持订阅解析与自动更新。
    - 支持 `tunnel://` 透明代理转发。
    - 支持全局节点去重。
    - 已新增 `subscriptionSyncLowWatermark`，允许在有效缓存已足够时跳过第二阶段远端订阅抓取。
    - 已新增 `cacheRefreshEnabled`，允许显式关闭第三阶段后台周期探测。
    - 已新增 `nodes_cache.state.json` 本地输入状态文件；当订阅已跳过且手工节点签名未变化时，第二阶段可整段跳过。
    - 第一阶段快速复检已改为直接复用缓存 `country` / `owner`，不再启动 egress metadata probe。
    - egress metadata 临时 Xray 进程已改为在拿到出口 IP 后立即停止，避免空闲子进程泄漏。
    - 第一阶段现支持 `allowedOwners`，可按 owner 名称做大小写不敏感匹配与排除，例如 `!cloudflare`。
    - 第一阶段 bootstrap 候选选择已改为边筛边取，达到 `bootstrapCandidateLimit` 即停止，减少大缓存场景下的冷启动拖延。
    - 第二阶段已恢复为轻量缓存同步：保留旧缓存已存在的 `country` / `owner` 等 metadata，但不再对全量候选主动回填，避免阻塞第三阶段。
    - 当前同时支持“第二阶段快速完成后进入第三阶段”和“缓存优先 + 第三阶段关闭”的两种运行模式。
- [x] **Release v2.1.3 Prep**:
    - 已同步升级四个工作区 package 版本至 2.1.3。
    - 已更新并收缩 `CHANGELOG.md` 的 v2.1.3 条目。
    - 已重新构建一版 2.1.3 Linux 安装包。
    - 已通过运行日志验证：在个人配置 `subscriptionSyncLowWatermark=1`、`cacheRefreshEnabled=false` 下，第二阶段会跳过 245 个订阅 URL 抓取，第三阶段会在缓存同步后明确跳过。
    - 已重新部署到 `/opt/dev-sidecar`，第一次重启成功写出 `nodes_cache.state.json`，第二次重启已在系统日志中验证“订阅跳过且本地输入未变化 => 第二阶段整段跳过”。
- [x] **Release v2.1.2**:
    - 同步升级各 package 版本至 2.1.2。
    - 更新 `CHANGELOG.md`，记录 `daily-cloudcode-pa.googleapis.com` 拦截崩溃修复。
    - 验证 `daily-cloudcode-pa.googleapis.com` 可正常拦截。
- [x] **Mitmproxy Robustness**:
    - 修复 `agent.options` 为空导致的拦截崩溃问题。
    - `sni`、`proxy`、`unVerifySsl`、普通请求与 Upgrade 请求路径已改为空值安全访问。
    - 已验证 `daily-cloudcode-pa.googleapis.com` 可正常拦截。
- [x] **Configuration**: 支持 HTTP/HTTPS/FILE 协议加载远程配置。
- [x] **Core Proxy**: HTTP/HTTPS 拦截与代理。
- [x] **DNS Optimization**: DNS 优选与智能解析。
- [x] **GitHub Acceleration**: SNI 伪装、Release 加速、Clone 加速。
- [x] **NPM Acceleration**: Registry 切换与代理。
- [x] **GUI**: Electron 桌面应用，支持配置与日志查看。
- [x] **System Integration**: 自动安装根证书 (Windows/Mac/Linux)，自动设置系统代理。

## Known Issues
- [ ] Windows 下关机/重启时若未退出应用，可能导致系统代理未还原（已在 1.8.9 修复，但需持续关注）。
- [ ] 部分 Linux 系统下系统代理设置可能不生效或需要 root 权限（目前仅支持 GNOME `gsettings`）。
- [ ] 与其他代理软件（如 Watt Toolkit、Clash）共存时可能存在端口冲突。
- [ ] 当前 Xray staged workflow 已有定向测试与真实日志验证，但距离完整发布回归仍有差距，发布前仍应至少复查核心构建与关键运行态日志。
- [ ] `nodes_cache.state.json` 当前只覆盖手工节点签名；若后续需要把更多本地来源纳入“本地输入未变化”的判定，需扩展签名范围并同步升级语义版本。
- [ ] 部分节点会因域名本身解析失败而长期缺少 country / owner，例如 `sg1n.asasone.cyou` 当前解析结果为 `NXDOMAIN`；这类节点的清理策略仍需进一步确认。

## Roadmap
- [ ] **v2.2.0**: 增强插件系统，支持更多自定义脚本。
- [ ] **UI/UX**: 优化设置界面交互，支持暗色模式（已部分支持）。
- [ ] **Platform**: 更好的 Linux 支持（Snap/Flatpak 打包）。