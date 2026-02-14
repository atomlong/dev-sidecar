# Add Xray Plugin Support

## Why

DevSideCar currently lacks native support for advanced proxy protocols (like VLESS, VMess, Trojan, Shadowsocks, Reality) which are essential for accessing services with strict firewall rules (e.g., ChatGPT). Integrating Xray Core will provide these capabilities along with advanced routing and load balancing, while maintaining DevSideCar's ease of use for traffic interception.

## What Changes

*   **Xray Integration**: Create a new plugin `packages/core/src/modules/plugin/xray` to manage the Xray process lifecycle (start, stop, restart).
*   **Tunnel Protocol Support**: Modify `packages/mitmproxy` to support a custom `tunnel://` protocol. This allows DevSideCar to forward intercepted HTTPS traffic to a local SOCKS/HTTP proxy (Xray's inbound) via a `CONNECT` tunnel, without modifying the original request's hostname or path.
*   **Subscription Management**: Implement parsing for subscription URLs that return Base64 encoded node lists.
*   **Node Link Parsing**: Support parsing individual `vmess://`, `vless://`, `trojan://`, and `ss://` (Shadowsocks) sharing links into Xray configuration.
*   **Traffic Routing**: Automatically inject interception rules into DevSideCar to route specific domains (e.g., `*.openai.com`) through the Xray plugin.
*   **Load Balancing**: Utilize Xray's built-in `Observatory` and `Balancer` for automatic node selection and failover.
*   **GUI Support**: Add a new configuration page in DevSideCar's GUI for managing Xray settings (subscription links, routing rules).

## Capabilities

### New Capabilities

*   `xray-plugin`: Management of Xray process, configuration generation (inbounds, outbounds, routing), and subscription parsing.
*   `mitmproxy-tunnel`: Support for `tunnel://` scheme in `mitmproxy`'s interceptor logic to enable forwarding to local proxies.

### Modified Capabilities

(None - No existing formal specs)

## Impact

*   **Codebase**:
    *   **Core**:
        *   New directory: `packages/core/src/modules/plugin/xray/`.
        *   Modified `packages/mitmproxy` to handle `tunnel://`.
    *   **GUI**:
        *   New component: `packages/gui/src/view/pages/plugin/xray.vue`.
        *   Modified routing: `packages/gui/src/view/router/index.js` and `menu.js`.
*   **Configuration**:
    *   New `plugin.xray` section in `config.json` for enabling the plugin, setting subscriptions, and defining rules.
*   **Dependencies**:
    *   Requires Xray binary (downloaded or bundled).