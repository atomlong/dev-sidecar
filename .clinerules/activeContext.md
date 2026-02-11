# Active Context

## Current Work
- 初始化 Memory Bank 文档。
- 分支调整：将 `master` 分支上的错误提交转移至 `develop`，并重置 `master` 至 v2.0.1。

## Recent Changes
- [Core] 支持 `file://` 协议作为远程配置源，允许加载本地配置文件。
- [CI/CD] 修复 GitHub Action 在 Windows 环境下的构建错误 (Python 3.10)。
- [Release] 发布 v2.0.1。
- [Docs] 初始化 Memory Bank。

## Next Steps
- 提交 `file://` 协议支持的代码。
- 确认项目构建和运行状态（可选）。

## Active Considerations
- **分支策略**: 采用 Git Flow 变体，`master` 为稳定分支，`develop` 为开发主分支。
- **配置管理**: 用户配置位于 `user.json`，需注意升级时的兼容性。
- **代理冲突**: 注意与其他代理软件的端口冲突或系统代理抢占问题。