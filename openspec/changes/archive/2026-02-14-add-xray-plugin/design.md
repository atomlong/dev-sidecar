# Xray Plugin Design

## Context

DevSideCar intercepts HTTPS traffic using a Node.js-based `mitmproxy`. Currently, it supports forwarding to standard HTTP/HTTPS proxies. However, accessing services like ChatGPT often requires advanced proxy protocols (VLESS, VMess, Reality, Trojan, Shadowsocks) or specific routing rules that are best handled by specialized cores like Xray.

To support this without reimplementing complex protocols in Node.js, we will integrate Xray Core as a subprocess and route specific traffic from DevSideCar to Xray via a local loopback interface.

## Goals / Non-Goals

**Goals:**
*   Implement a `tunnel://` protocol in `mitmproxy` to forward intercepted traffic to a local proxy (Xray) via HTTP CONNECT, preserving the original request target.
*   Create a `plugin.xray` module to manage the Xray process (start/stop/restart) and its configuration.
*   Support parsing various proxy sharing links to generate Xray's `outbound` configuration, including **Reality** protocol support for VLESS and Trojan.
*   Implement a load-balancing strategy using Xray's `Observatory`.
*   Automatically inject interception rules to route target traffic (e.g., `*.openai.com`) to the Xray plugin.

**Non-Goals:**
*   Reimplementing proxy protocols in Node.js.
*   Providing a full-featured UI for manual Xray configuration (focus is on subscription/link import).
*   Supporting all Xray features (focus is on outbound proxying).

## Decisions

### 1. Tunneling via `tunnel://` Pseudo-Protocol

We will introduce a `tunnel://host:port` scheme in the interceptor configuration.
*   **Rationale**: The existing `http_proxy` logic modifies the request's `hostname` and `path` to target the proxy. For a transparent/intercepting proxy forwarding to another proxy (Xray), we need to establish a tunnel (HTTP CONNECT) to the Xray inbound, but keep the *inner* request's `hostname` and `path` unchanged.
*   **Implementation**: Modify `doProxy` in `mitmproxy` to detect `tunnel://`. If detected, use `util.getTunnelAgent` to create an agent connected to the local Xray port.
*   **Port Zero Resolution**: Support `tunnel://127.0.0.1:0`. If port is `0`, resolve it to the actual runtime port of the Xray plugin (read from `context.server.setting.xrayPort`), allowing dynamic ports to be used in manual configuration.

### 2. Xray Configuration Management

The plugin will dynamically generate `config.json` for Xray.
*   **Inbounds**: SOCKS/HTTP inbound on a local port.
    *   **Port Selection**: Checks `config.localPort`.
        *   **Strict Mode**: If set (non-zero), strictly attempts to use it. If occupied, the plugin **fails to start**.
        *   **Auto Mode**: If 0, automatically finds a random free port.
        *   The actual runtime port is saved to context for rule injection and displayed in the GUI.
*   **Outbounds**: Generated from parsed subscription nodes. We will adapt robust parsing logic (reference: `subscribe-convert`) to handle:
    *   `vmess://`: Base64 decoding to JSON object (standard V2RayN format).
    *   `vless://`: URI scheme parsing with `URL` API to extract UUID, host, port, and query parameters (security, type, sni, etc.). **Support Reality parameters (`pbk`, `sid`, `fp`, `spx`, `sni`)**.
    *   `trojan://`: URI scheme parsing for Trojan protocol. **Support Reality parameters**.
    *   `ss://`: Base64 or URI scheme parsing for Shadowsocks.
*   **Routing**: Generates routing rules based on the plugin's `rules` configuration, mapping domains to specific `outboundTag`s (e.g., `balancer-proxy`, `direct`, `block`, or specific node tags).
*   **Observatory**: Configured to probe nodes for latency-based load balancing.

### 3. Rule Injection

We will inject interception rules at runtime by modifying the in-memory configuration object (`context.config.get().server.intercepts`).
*   **Rationale**: These rules are dynamic dependencies of the plugin's state.
*   **Conflict Resolution**:
    *   **Backup**: Before injecting a rule for a domain (e.g., `openai.com`), check if a rule already exists in the user config. If so, back it up to a plugin-internal state.
    *   **Overwrite**: Overwrite the rule with the Xray tunnel rule while the plugin is active.
    *   **Restore**: When the plugin stops, restore the original rule from backup (or delete if it didn't exist).
*   **Lifecycle**: Rules are added on `plugin.start()` and removed/restored on `plugin.close()`.

### 4. Dynamic Configuration Update via Hot Reload

Mitmproxy server runs in a separate process. To support dynamic injection of interception rules without restarting the server process, we will implement a hot reload mechanism.
*   **Implementation**:
    *   Refactor `mitmproxy/src/options.js` to expose runtime configuration objects (intercepts, whitelist, etc.) instead of sealing them in closures.
    *   Implement an IPC handler in the Mitmproxy process to receive configuration updates from the main process.
    *   When the Xray plugin modifies the global configuration, it sends an update message to the Mitmproxy process.
    *   Mitmproxy updates its internal rule sets (e.g., re-compiling regexes) on the fly.
*   **Benefit**: This allows zero-downtime activation and deactivation of the Xray plugin, providing a seamless user experience.

### 5. GUI Integration

We will add a new configuration page in the GUI.
*   **Component**: `xray.vue` in `packages/gui/src/view/pages/plugin/`.
*   **Features**:
    *   Enable/Disable switch.
    *   Subscription URL input (textarea for multiple).
    *   Manual Node input (textarea).
    *   Routing Rules editor (simple list of domains).
    *   Status display (Xray process status, probe results).
*   **Menu**: Register in `packages/gui/src/view/router/menu.js`.