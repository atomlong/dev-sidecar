# Active Context

## Current Work
- 准备发布 v2.1.0 版本。
- 完善 CI/CD 流程，支持从 CHANGELOG 自动生成 Release Notes。
- 修复 `submit.sh` 脚本在处理中文文件名时的转义问题。

## Recent Changes
- [Release] **v2.1.0**:
    - 全线升级包版本至 2.1.0。
    - 新增 `CHANGELOG.md`。
    - 优化 GitHub Actions 工作流，使用 `softprops/action-gh-release` 并自动提取变更日志。
- [DevOps] **Submit 脚本修复**:
    - 在 `submit.sh` 中强制关闭 git `core.quotePath`，解决中文文件名提交失败的问题。
- [Plugin] **Xray 集成**:
    - 新增 `packages/core/src/modules/plugin/xray` 模块。
    - 实现订阅解析 (`parser.js`)，支持 Base64、VLESS、VMess、Trojan、SS 等协议。
    - 支持 Reality 协议配置，并增加了严格的校验逻辑。
    - 实现了全局节点去重。
- [Mitmproxy] **Tunnel 支持**:
    - 支持 `tunnel://` 伪协议，允许通过 HTTP CONNECT 将流量透明转发给 Xray 核心。
    - 实现了动态拦截规则注入 (`injectRules`) 和热重载 (`hot reload`)。

## Next Steps
- 执行提交并推送，触发 v2.1.0 发布流程。
- 监控 Release 构建状态。

## Active Considerations
- **发布流程**: 确保 CHANGELOG 格式规范，以便脚本正确提取 Release Notes。
- **Git 配置**: `submit.sh` 会修改本地 `git config`，这通常是安全的，但需留意对其他工具的影响（通常是正向的）。