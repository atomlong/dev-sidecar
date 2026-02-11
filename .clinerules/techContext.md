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
- **System Proxy**: `@starknt/sysproxy` (Native addon for system proxy settings).
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
│   ├── gui/            # Electron + Vue frontend
│   └── mitmproxy/      # Proxy server implementation
├── .npmrc              # pnpm configuration
├── pnpm-workspace.yaml # Workspace definition
└── README.md
```

## Constraints
- **Certificate**: Requires root certificate installation for HTTPS interception.
- **Port**: Default proxy port is 1181 (may vary).
- **System Proxy**: Modifies global system proxy settings, potential conflict with other VPN/Proxy tools.
- **Platform Specifics**: Windows/Mac/Linux handling for CA installation and proxy settings varies significantly.