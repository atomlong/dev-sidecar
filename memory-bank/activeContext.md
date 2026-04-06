# Active Context

## Current Work
- 版本发布：已完成 v2.1.2 发布，包含 `daily-cloudcode-pa.googleapis.com` 拦截崩溃修复；当前关注相关 Google / Copilot 请求的稳定性。

## Recent Changes
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
- 如需要对外发布补丁版本，更新 `CHANGELOG.md` 并走 `submit.sh` 发布流程。

## Active Considerations
- **发布流程**: 在打包 Xray Core 后可能会导致应用程序整体大小略有增加（约十几MB），需要观察下载体验的影响。后续需保持对 Xray-core release 版本的关注，在必要时再次发起内置核心更新的变更。
- **拦截器健壮性**: Mitmproxy 的请求拦截链路中，`agent.options` 不能假定存在；后续新增规则需继续采用空值安全访问，避免类似空指针问题再次出现。