# Active Context

## Current Work
- 版本发布：已完成 v2.1.2 发布，包含 `daily-cloudcode-pa.googleapis.com` 拦截崩溃修复；当前关注相关 Google / Copilot 请求的稳定性。
- CI 修复：正在处理 GitHub Actions 的跨平台构建稳定性，重点是 Windows 的 `node-gyp` Python 绑定，以及 macOS 下 Xray 资源参与 universal 合并导致的打包失败。

## Recent Changes
- [CI] **GitHub Actions 构建修复**：
    - 在 `.github/workflows/build-and-release.yml` 中显式将 `PYTHON`、`npm_config_python`、`NODE_GYP_FORCE_PYTHON` 绑定到 `actions/setup-python` 提供的 Python 3.10，避免 Windows 上 `node-gyp` 落回 Python 3.12 并触发 `distutils` 缺失错误。
    - 增加 CI 调试输出，便于在日志中确认 `node-gyp` 实际使用的 Python 解释器。
    - 已确认此前移除 macOS `universal` DMG 只是临时止血，不是根因修复。
    - 根因是上游 Xray 的 macOS 二进制可能已经是 fat/universal Mach-O，electron-builder 在合并 universal App 时又会对 `extra/xray/xray` 再次执行 `lipo`，从而因架构重叠报错。
    - 现改为在 `packages/gui/scripts/download-xray.js` 中对 macOS 的 Xray 二进制先按目标架构执行 `lipo -thin` 裁剪，再在 `packages/gui/vue.config.js` 中恢复 `universal` DMG 构建。
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
- 观察 v2.1.2 发布后的 `daily-cloudcode-pa.googleapis.com` 及其他 Google APIs 拦截路径的实际运行情况。
- 观察修复后的 GitHub Actions `build-and-release` / `test-and-upload` 是否在 Windows / macOS / Linux 三个平台稳定通过，尤其确认 macOS `universal` DMG 已恢复正常产出。
- 如需要对外发布补丁版本，更新 `CHANGELOG.md` 并走 `submit.sh` 发布流程。

## Active Considerations
- **发布流程**: 在打包 Xray Core 后可能会导致应用程序整体大小略有增加（约十几MB），需要观察下载体验的影响。后续需保持对 Xray-core release 版本的关注，在必要时再次发起内置核心更新的变更。
- **拦截器健壮性**: Mitmproxy 的请求拦截链路中，`agent.options` 不能假定存在；后续新增规则需继续采用空值安全访问，避免类似空指针问题再次出现。