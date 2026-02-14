# Active Context

## Current Work
- 完成 Xray 插件开发与集成，支持更强大的代理协议（VLESS, VMess, Reality 等）。
- 验证并修复了 Reality 协议在特定配置下的崩溃问题（短 ID、公钥长度、传输协议兼容性）。
- 实现了全局节点去重逻辑。

## Recent Changes
- [Plugin] **Xray 集成**:
    - 新增 `packages/core/src/modules/plugin/xray` 模块。
    - 实现订阅解析 (`parser.js`)，支持 Base64、VLESS、VMess、Trojan、SS 等协议。
    - 支持 Reality 协议配置，并增加了严格的校验逻辑（防止无效配置导致 Xray 崩溃）。
    - 实现了全局节点去重，防止多订阅源导致重复节点。
- [Mitmproxy] **Tunnel 支持**:
    - 支持 `tunnel://` 伪协议，允许通过 HTTP CONNECT 将流量透明转发给 Xray 核心。
    - 实现了动态拦截规则注入 (`injectRules`) 和热重载 (`hot reload`)。
- [Core] 支持 `file://` 协议作为远程配置源，允许加载本地配置文件。
- [CI/CD] 修复 GitHub Action 在 Windows 环境下的构建错误 (Python 3.10)。
- [Docs] 初始化 Memory Bank。

## Next Steps
- 监控 Xray 插件的稳定性。
- 考虑未来支持链式代理配置（目前 Xray 原生支持但插件配置生成逻辑需微调）。

## Active Considerations
- **Xray 兼容性**: 确保 parser 能处理各种不规范的订阅链接（已增加多项容错处理）。
- **端口管理**: Xray 插件自动管理端口，需确保不与主代理冲突。
- **分支策略**: 采用 Git Flow 变体，`master` 为稳定分支，`develop` 为开发主分支。