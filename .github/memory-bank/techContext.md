# Tech Context

## Technology Stack

### Core Technologies
- **Runtime**: Node.js (Electron 内置)
- **Package Manager**: pnpm (Workspaces enabled)
- **UI Framework**: Vue.js 2.x
- **Desktop Framework**: Electron 19.x
- **UI Component Library**: Ant Design Vue 1.x

### Key Libraries
- **Proxy**: Custom implementation based on `http`/`net` and `node-forge`.
- **Tunneling**: Xray Core (integrated via plugin).
- **System Proxy**: 
    - Windows/macOS: `@starknt/sysproxy` (Native addon).
    - Linux: `gsettings` (via `child_process`).
- **Process Management**: `spawn-sync`, `node-powershell`.
- **Logging**: `log4js`.
- **Utils**: `lodash`, `json5`.

## Development Environment
- **OS Support**: Windows, macOS, Linux (Ubuntu/Debian).
- **Node Version**: Recommended Node 14+ or 16+ (Electron 19 uses Node 16.14.2).
- **Setup**:
    - `pnpm install`: Install dependencies.
    - `pnpm run electron:serve` (in `packages/gui`): Start dev server.

## DevOps & Release
- **CI/CD**: GitHub Actions (`.github/workflows/build-and-release.yml`).
- **Build Tool**: `electron-builder`.
- **Release Automation**: 
    - 自动从 `CHANGELOG.md` 提取版本更新日志。
    - 使用 `softprops/action-gh-release` 发布 GitHub Release。
- **Version Control**: `submit.sh` 脚本管理开发/发布分支流程，支持私有/公共仓库分离。
- **Current Release Prep**: `v2.1.4` 当前只同步四个工作区包版本（core / cli / gui / mitmproxy）；根 `package.json` 无版本号。Linux 安装版已成功重新构建并安装为 `2.1.4`。

## Project Structure
```text
/
├── packages/
│   ├── cli/            # Command Line Interface
│   ├── core/           # Core logic, config, plugins
│   │   ├── modules/plugin/xray # Xray Plugin logic
│   ├── gui/            # Electron + Vue frontend
│   └── mitmproxy/      # Proxy server implementation
├── .npmrc              # pnpm configuration
├── pnpm-workspace.yaml # Workspace definition
├── CHANGELOG.md        # Release notes
└── README.md
```

## Constraints
- **Certificate**: Requires root certificate installation for HTTPS interception.
- **Port**: Default proxy port is 31181. Xray uses a dynamic port (default 10801 or random).
- **System Proxy**: Modifies global system proxy settings, potential conflict with other VPN/Proxy tools.
- **Platform Specifics**: Windows/Mac/Linux handling for CA installation and proxy settings varies significantly. Linux requires GNOME for automatic system proxy.
- **Xray Cache Gatekeeping**: `subscriptionSyncLowWatermark` 通过 SQLite 过滤计数决定是否跳过远端订阅抓取；`cacheRefreshEnabled` 会直接控制第三阶段调度与后续定时刷新。
- **Xray Local Input State**: 第二阶段现使用 `nodes_cache.state.json` sidecar 文件记录本地输入签名。状态文件与 `nodes_cache.sqlite` 同目录，采用 JSON 文本、临时文件写入后原子 `rename` 覆盖；缺失或损坏时自动回退到完整第二阶段。
- **Xray Subscription Provenance**: SQLite cache 通过 `nodes.node_key`、`subscriptions`、`subscription_node_refs` 记录订阅来源关系；重复订阅 URL 需按配置 occurrence 区分。阶段 3 汇总文件为 `stage3-last-round.json`，只应使用完整轮次的实际可用节点更新订阅可用性。
- **Xray Probe Lifecycle**: 临时 probe 进程必须按真实 PID 停止和确认；日志需区分 `Xray 批次探测进程` 与 `Xray 出口元数据探测进程`。已有 `country` 与 `owner` 的节点不应启动 egress metadata probe。