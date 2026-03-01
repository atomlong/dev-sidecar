# Active Context

## Current Work
- 发布 v2.1.1 版本，以提供无需手动配置的 Xray Core 集成（开箱即用）。
- 使用 OpenSpec 工作流成功完成了内置 Xray 核心相关的逻辑梳理和代码实现，并已归档变更。

## Recent Changes
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
- 通过执行提交并推送代码（运行 `submit.sh`）以触发 GitHub Actions 的发布构建流程，让用户能获取 v2.1.1 版本的更新。

## Active Considerations
- **发布流程**: 在打包 Xray Core 后可能会导致应用程序整体大小略有增加（约十几MB），需要观察下载体验的影响。后续需保持对 Xray-core release 版本的关注，在必要时再次发起内置核心更新的变更。
