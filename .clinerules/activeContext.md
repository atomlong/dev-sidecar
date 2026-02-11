# Active Context

## Current Work
- 初始化 Memory Bank 文档。
- 分支调整：将 `master` 分支上的错误提交转移至 `develop`，并重置 `master` 至 v2.0.1。

## Recent Changes
- [Act Mode] 合并 `master` 的提交 (83c8afc, 7ba64d3) 到 `develop`。
- [Act Mode] 重置 `master` 分支到 `5a9fa187` (v2.0.1)。
- [Docs] 创建 `.clinerules/` 下的 Memory Bank 文件。

## Next Steps
- 确认项目构建和运行状态（可选）。
- 根据用户需求进行后续开发。

## Active Considerations
- **分支策略**: 采用 Git Flow 变体，`master` 为稳定分支，`develop` 为开发主分支。
- **配置管理**: 用户配置位于 `user.json`，需注意升级时的兼容性。
- **代理冲突**: 注意与其他代理软件的端口冲突或系统代理抢占问题。