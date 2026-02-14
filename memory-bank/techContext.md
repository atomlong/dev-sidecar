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
└── README.md
```

## Constraints
- **Certificate**: Requires root certificate installation for HTTPS interception.
- **Port**: Default proxy port is 1181. Xray uses a dynamic port (default 10801 or random).
- **System Proxy**: Modifies global system proxy settings, potential conflict with other VPN/Proxy tools.
- **Platform Specifics**: Windows/Mac/Linux handling for CA installation and proxy settings varies significantly. Linux requires GNOME for automatic system proxy.