# System Patterns

## Architecture
DevSidecar 采用 Monorepo 架构，所有子包位于 `packages/` 目录下。整体架构分为 GUI 层、核心控制层和代理服务层。

```mermaid
flowchart TD
    User[User] <--> GUI[GUI (Electron/Vue)]
    GUI <-->|IPC| Main[Main Process (background.js)]
    Main <-->|Direct Call| Core[Core (@docmirror/dev-sidecar)]
    Core -->|Control| Proxy[Mitmproxy (@docmirror/mitmproxy)]
    Core -->|Control| Xray[Xray Plugin (xray-core)]
    Core -->|Manage| Plugins[Other Plugins (Git, NPM, etc.)]
    
    Proxy <-->|Intercept/Forward| Internet[Internet]
    Proxy <-->|Tunnel (HTTP CONNECT)| Xray
    Xray <-->|VLESS/VMess| Internet
    Proxy <-->|Intercept| App[Local Apps (Browser, Git, etc.)]
```

## Key Components

### 1. GUI (`@docmirror/dev-sidecar-gui`)
- **Render Process**: Vue 2 + Ant Design Vue。提供配置界面、日志展示、开关控制。
- **Main Process (`background.js`)**: Electron 主进程。
    - 负责窗口管理、托盘图标。
    - 监听 IPC 消息。
    - 调用 `DevSidecar.api` (来自 Core) 来启动/停止服务。

### 2. Core (`@docmirror/dev-sidecar`)
- **Entry (`index.js` -> `expose.js`)**: 暴露 API 给 GUI 使用。
- **Config (`config-api.js`)**: 管理用户配置 (user.json) 和默认配置。支持 HTTP/HTTPS 及 FILE (本地文件) 协议加载远程配置。
- **System Interaction**:
    - `modules/proxy`: 设置/取消系统代理 (使用 `@starknt/sysproxy` 或 Linux `gsettings`)。
    - `shell/scripts/setup-ca.js`: 安装和信任 CA 证书。
- **Plugin Architecture**:
    - 支持模块化插件。
    - **Xray Plugin**: 
        - 负责下载订阅、解析节点（支持 Reality 等高级协议）。
        - 生成 Xray 配置文件 (`gen_config.js`)。
        - 管理 Xray 子进程。
        - 动态注入 `tunnel://` 拦截规则到 Mitmproxy。

### 3. Mitmproxy (`@docmirror/mitmproxy`)
- **Server**: 启动 HTTP/HTTPS 代理服务器。
- **Interceptor (`lib/interceptor`)**: 核心拦截逻辑。
    - `requestReplace`: 请求修改。
    - `redirect`: 重定向。
    - `abort`: 阻断请求。
    - **Tunnel Support**: 识别 `tunnel://` 协议，建立 HTTP Tunnel 连接至上游代理（如 Xray），实现透明代理。
- **DNS (`lib/dns`)**: 实现 DNS 优选逻辑 (DoH/DoT)。
- **TLS (`lib/proxy/tls`)**: 处理 HTTPS 证书动态生成和 SNI 伪装。

## Design Patterns
- **Monorepo**: 使用 pnpm workspace 管理多包依赖。
- **Plugin System**: Core 通过插件机制 (`modules/plugin`) 扩展功能 (如 Git 加速配置、NPM 代理配置、Xray 集成)。
- **IPC Communication**: GUI 与后台逻辑分离，通过 Electron IPC 通信，但在 `background.js` 中直接引用 Core 包（因为是 Node 环境）。
- **Singleton**: 代理服务和配置管理器通常以单例模式运行。
- **Hot Reload**: 支持动态更新拦截规则和配置，无需重启代理服务。

## Data Flow
1.  **启动**: GUI -> Main Process -> Core.startup() -> 启动 Mitmproxy -> 启动 Xray Plugin -> 设置系统代理。
2.  **请求处理 (普通)**: App -> System Proxy -> Mitmproxy -> (Interceptor Check) -> (DNS Lookup) -> Target Server。
3.  **请求处理 (Xray)**: App -> System Proxy -> Mitmproxy -> (Match Rule: `tunnel://`) -> Mitmproxy Tunnel Agent -> Xray Core (Local Port) -> VLESS/VMess -> Target Server.
4.  **日志**: Proxy/Core -> LogUtil -> GUI Log Viewer (通过 IPC 或文件读取)。