# Active Context

## Current Work
- 版本发布：已完成 v2.1.2 发布，包含 `daily-cloudcode-pa.googleapis.com` 拦截崩溃修复；当前关注相关 Google / Copilot 请求的稳定性。
- CI 修复：正在处理 GitHub Actions 的跨平台构建稳定性，重点是 Windows 的 `node-gyp` Python 绑定，以及 macOS 下 Xray 资源参与 universal 合并导致的打包失败。
- 工作流增强：已完成 `submit.sh --push-public` 冲突自动化改造与测试，当前正按 `.clinerules/workflows/submit.md` 执行提交与同步。

## Recent Changes
- [Workflow] **`submit.sh` 公共同步增强**：
    - `--push-public` 现改为通过 `git cherry` 做 patch-id aware 去重，只同步真正尚未进入公共分支的 public commit，避免等价补丁被重复 cherry-pick。
    - 公共同步前会自动启用 `git rerere` 与 `rerere.autoupdate`，复用历史冲突解决结果。
    - 新增环境变量 `SUBMIT_PUBLIC_CONFLICT_STRATEGY=ours|theirs`，当首次 `git cherry-pick -x --allow-empty` 冲突时，可自动 `--abort` 后使用 `git cherry-pick -X <strategy>` 重试一次。
    - 若 rerere 或自动策略已把冲突清空，则脚本会自动执行 `git cherry-pick --continue`；若仍有未解决冲突，则保留现场并提示人工处理。
    - 已通过 `bash -n submit.sh` 语法检查、临时仓库 patch-id 跳过测试、以及真实文本冲突的自动重试策略测试。
- [CI] **GitHub Actions 构建修复**：
    - 在 `.github/workflows/build-and-release.yml` 中显式将 `PYTHON`、`npm_config_python`、`NODE_GYP_FORCE_PYTHON` 绑定到 `actions/setup-python` 提供的 Python 3.10，避免 Windows 上 `node-gyp` 落回 Python 3.12 并触发 `distutils` 缺失错误。
    - 增加 CI 调试输出，便于在日志中确认 `node-gyp` 实际使用的 Python 解释器。
    - 已确认此前移除 macOS `universal` DMG 只是临时止血，不是根因修复。
    - 根因已进一步细化：上游 Xray 的 macOS 二进制既可能是 fat/universal Mach-O，也可能已经是目标架构的 thin Mach-O；此前无条件执行 `lipo -thin` 会在 GitHub Actions 的 macOS arm64 runner 上因为输入文件本身就是单架构而失败。
    - 现改为在 `packages/gui/scripts/download-xray.js` 中先通过 `lipo -archs` 检测实际架构：若已是目标单架构则直接跳过，若为 fat/universal 且包含目标架构才执行 `lipo -thin`，再由 `electron-builder` 继续生成 `universal` DMG。
    - `.github/workflows/test-and-upload.yml` 也同步固定 `node-gyp` Python 解释器，避免测试工作流与发布工作流行为不一致。
- [Release] **v2.1.2**：
    - 同步升级 package 版本到 2.1.2。
    - 更新 `CHANGELOG.md`，记录 `daily-cloudcode-pa.googleapis.com` 拦截崩溃修复。
- [Fix] **`daily-cloudcode-pa.googleapis.com` 拦截崩溃修复**：
    - 将 `sni`、`proxy`、`unVerifySsl`、普通请求与 Upgrade 请求路径中对 `rOptions.agent.options.rejectUnauthorized` 的直接访问改为空值安全读取。
    - `daily-cloudcode-pa.googleapis.com` 现已可正常拦截，测试通过。
- [Release] **v2.1.1**:
    - 全线升级包版本至 2.1.1。
    - 更新 `CHANGELOG.md`，反映 Xray Core 的内置化调整。
- [Plugin] **Xray 深度集成 (Out-of-the-box)**:
    - 移除了所有需要用户手动配置 `binPath` 的代码和 UI 元素。
    - 新增了自动构建下载脚本 `scripts/download-xray.js`，支持根据操作系统下载全平台的 Xray 二进制和数据库文件。
    - 修改了 `vue.config.js` 使用 electron-builder 的 `extraResources` 配合宏按需打入所需的特定平台可执行文件。
    - 统一内部工具路径引用，通过 `getXrayExePath` 获取。
- [Documentation]:
    - 同步更新了 `doc/wiki/Xray插件使用说明.md`。

## Next Steps
- 确认本次 `submit.sh` 改动的 private/public 远程同步结果，并在需要时继续发布流程。
- 若需要进一步接近真实环境验证，可在实际仓库上演练一次 `./submit.sh --push-public`，并优先确认私有 `gitlab` remote 的可达性。
- 观察 v2.1.2 发布后的 `daily-cloudcode-pa.googleapis.com` 及其他 Google APIs 拦截路径的实际运行情况。
- 重新触发并观察修复后的 GitHub Actions `build-and-release` / `test-and-upload` 是否在 Windows / macOS / Linux 三个平台稳定通过，尤其确认 macOS `universal` DMG 已恢复正常产出。
- 如需要对外发布补丁版本，更新 `CHANGELOG.md` 并走 `submit.sh` 发布流程。

## Active Considerations
- **发布流程**: 在打包 Xray Core 后可能会导致应用程序整体大小略有增加（约十几MB），需要观察下载体验的影响。后续需保持对 Xray-core release 版本的关注，在必要时再次发起内置核心更新的变更。
- **拦截器健壮性**: Mitmproxy 的请求拦截链路中，`agent.options` 不能假定存在；后续新增规则需继续采用空值安全访问，避免类似空指针问题再次出现。
- **分支纪律**: `develop` 属于私有分支，禁止推送到公共仓库；公共发布面应始终通过 `submit.sh --push-public` 同步到 `master` / `feature/*`。
- **同步策略**: 当前 public sync 已具备 patch-id 去重、rerere 复用与一次性自动冲突重试能力，但若私有 `gitlab` remote 不可达，后续完整提交流程仍需先恢复网络连通性。