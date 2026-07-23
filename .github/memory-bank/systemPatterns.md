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
        - 当前采用明确的三阶段流水线：
            - 第一阶段：从旧缓存中按 `allowedCountries`、`allowedOwners`、延迟条件筛出少量候选，做启动前快速复检，仅用于尽快拉起 Xray。
            - 第二阶段：默认会汇总本地源（运行配置备份、旧缓存、手动节点），并仅在有效缓存数低于 `subscriptionSyncLowWatermark` 时抓取远端订阅；若订阅已跳过且 `nodes_cache.state.json` 记录的本地输入签名与当前一致，则整段第二阶段直接跳过。第二阶段还负责同步订阅 provenance 和订阅到节点引用，但不把保留缓存计为当前可用。
            - 第三阶段：仅在 `cacheRefreshEnabled !== false` 时运行；按批次探测缓存节点，并在探测成功后补充 `country` / `owner` 等 metadata，同时逐步淘汰不可用节点。完整轮次结束后按本轮实际可用节点生成 per-subscription usable-node summary。
        - 第一阶段的 `bootstrapCandidateLimit` 表示“启动前最多进入快速复检的候选节点上限”，不是第三阶段那种批处理 batch size。
        - Xray cache SQLite 现在包含订阅 provenance：`nodes.node_key` 作为稳定节点 key，`subscriptions` 保存每个配置项订阅，`subscription_node_refs` 保存订阅到节点引用；重复订阅 URL 通过 occurrence 区分。
        - `subscriptionStaleAfterDays` 属于阶段 3 语义；只有阶段 3 完整轮次确认订阅长期无可用节点且无节点引用时，才能清理订阅 metadata，不能用它删除 `nodes` 行。

### 3. Mitmproxy (`@docmirror/mitmproxy`)
- **Server**: 启动 HTTP/HTTPS 代理服务器。
- **Interceptor (`lib/interceptor`)**: 核心拦截逻辑。
    - `requestReplace`: 请求修改。
    - `redirect`: 重定向。
    - `abort`: 阻断请求。
    - **Tunnel Support**: 识别 `tunnel://` 协议，建立 HTTP Tunnel 连接至上游代理（如 Xray），实现透明代理。
- **DNS (`lib/dns`)**: 实现 DNS 优选逻辑 (DoH/DoT)。
- **TLS (`lib/proxy/tls`)**: 处理 HTTPS 证书动态生成和 SNI 伪装。
- **Parallel Request Paths**:
    - 普通 HTTP/HTTPS 请求走 `createRequestHandler`，WebSocket / HTTP upgrade 请求走 `createUpgradeHandler`。
    - 这两条入口在 DNS、SNI、compat agent、lookup 注入上的语义必须保持一致；`createRequestHandler` 当前是 upgrade 路径的对齐基线。
    - 一旦 upgrade 路径保留了旧 API 或旧兼容逻辑，最典型的表现就是普通页面与短请求正常，但聊天、流式推送或其他基于 upgrade 的连接在握手前失败。

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

## Xray Metadata Notes
- 第一阶段为了避免拖慢冷启动，只消费缓存里已有的 `country` / `owner`；启动前快速复检不再启动 egress metadata probe。
- 第二阶段会保留上一次缓存中已有的 metadata，不会把已存在的 `country` / `owner` 清掉；当候选集未变化时，会跳过缓存重写。
- 第二阶段的本地输入状态 sidecar 文件固定命名为 `nodes_cache.state.json`，与 `nodes_cache.sqlite` 同目录；当前签名只覆盖 `cfg.nodes` 解析后的手工节点集合，不覆盖 `liveConfigBak`。
- 第三阶段的 `annotateProbeEntries` 仍是主动 metadata 补全的主入口；如果用户关闭 `cacheRefreshEnabled`，则自动 metadata 校正也会一起停掉。若节点已有 `country` 和 `owner`，则不应再启动 egress metadata probe。
- `subscriptionSyncLowWatermark` 的判断依赖 SQLite `countCacheEntries()` 与 stable/maxDelay/country/owner 过滤，目标是统计“对第一阶段真正有意义的有效缓存数”。
- Probe 进程日志需要区分批次探测与出口元数据探测；残留 egress probe 排查时先看父进程清理链路、cmdline、socket 和 PID 状态，避免只靠延长超时掩盖问题。
- egress metadata 查询必须有两层退出保障：单次 HTTP proxy 请求使用 `AbortController` + hard timeout，整个 `detectEgressAddressThroughProxy()` 调用再由外层绝对超时保护，确保 `finally { controller.stop() }` 有机会执行。

## Linux cgroup 内存管理模式 (v2.2.3)

### systemd service 配置
- `pkg/linux/dev-sidecar.service` 默认值：`MemoryHigh=280M` + `StartupMemoryHigh=300M`
- `StartupMemoryHigh` 在启动阶段生效（允许冷启动 ~282MB 峰值不触发 throttling），service 进入 active 后自动切换到 `MemoryHigh`
- 部署脚本 `install_devSideCar.sh` 的 drop-in `10-devsidecar-setup.conf` 覆盖 `MemoryHigh=280M`（环境特定），不覆盖 `StartupMemoryHigh`（用主单元默认 300M）

### cgroup v2 page cache 记账规则
- page cache 按**首次触发 read 的进程所属 cgroup**记账
- 热启动：文件已在系统 page cache（之前跑过），复用不重新记账 → dev-sidecar cgroup 不涨
- 冷启动：文件不在 page cache，从磁盘读入 → 计入 dev-sidecar cgroup → peak 更高
- `memory.reclaim` 是同步立即生效的，但被回收的 file pages 会被后续 read 重新读入（`workingset_refault_file` 计数器反映）

### xray probe cgroup 隔离
- `probe.js` spawn xray 后立即 `moveProcessToIsolatedCgroup(pid)` 移到 `dev-sidecar-xray-probe.scope`
- xray probe 的 file cache（读 SQLite 800MB+）不计入 dev-sidecar.service 的 MemoryHigh
- helper 脚本 `/usr/lib/dev-sidecar/xray-probe-cgroup.sh`，sudoers NOPASSWD

### 多层 memory.reclaim 回收点
- `expose.js` `reclaimStartupMemory()`：启动前 200M
- `expose.js` proxy.start() 后：动态 100-350M（基于 `memory.current`）
- `xray/index.js` SQLite 读取前：动态 100-300M
- `xray/index.js` stage3 计数前后：各 150M
- 所有回收通过 `reclaimCgroupMemory()` 调用（`cache.js`），有 sudo fallback（`sudo -n /usr/lib/dev-sidecar/reclaim-memory.sh`）

### gsettings 无桌面跳过
- `set-system-proxy/index.js` Linux 分支检测 `/usr/bin/gsettings` 和 `/tmp/.X11-unix/X<n>` socket
- 无桌面环境跳过 gsettings → 不派生 dbus-launch/dbus-daemon/dconf-service → 省 ~6MB RSS
- WSL2/无头服务器下所有工具（apt/curl/git/npm/Docker/Chrome）都不读 gsettings 代理

### mitmproxy V8 堆
- `--max-old-space-size=96` 固定值（mitmproxy 稳态堆 ~15MB，6 倍余量）
- 只影响 mitmproxy Node.js 子进程，不影响 xray probe（Go 二进制，隔离 cgroup）