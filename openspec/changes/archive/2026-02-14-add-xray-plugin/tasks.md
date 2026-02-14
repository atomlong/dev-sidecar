## 1. Mitmproxy Modifications

- [x] 1.1 Verify and update `packages/mitmproxy/src/lib/proxy/common/util.js` to ensure `getTunnelAgent` supports both HTTP and HTTPS targets.
- [x] 1.2 Modify `packages/mitmproxy/src/lib/interceptor/impl/req/proxy.js` to detect `tunnel://` scheme, creating a tunnel agent without rewriting the request target.
- [x] 1.3 Implement Hot Reload mechanism in Mitmproxy: Refactor `options.js` to expose runtime config, and add IPC handler in `index.js` to update config dynamically.

## 2. Xray Plugin Core

- [x] 2.1 Create plugin directory structure at `packages/core/src/modules/plugin/xray/`.
- [x] 2.2 Create `packages/core/src/modules/plugin/xray/config.js` defining default configuration (enabled, binPath, localPort, subscriptions, nodes, rules, etc.).
- [x] 2.3 Implement `packages/core/src/modules/plugin/xray/process.js` to handle spawning, stopping, and restarting the Xray binary, including log redirection.
- [x] 2.5 Implement `packages/core/src/modules/plugin/xray/port-finder.js` (or similar utility) to dynamically allocate a free port. Logic: try configured `localPort` first; if occupied/zero, pick random free port.
- [x] 2.4 Register the new plugin in `packages/core/src/modules/plugin/index.js`.

## 3. Configuration & Subscriptions

- [x] 3.1 Implement `packages/core/src/modules/plugin/xray/parser.js` to parse Base64 subscription content and standard `vmess://` / `vless://` / `trojan://` / `ss://` URIs into Xray outbound objects (Reference: `subscribe-convert`). **Add Reality support for VLESS/Trojan (params: pbk, sid, fp, spx, sni).**
- [x] 3.2 Implement `packages/core/src/modules/plugin/xray/gen_config.js` to generate a complete Xray `config.json` with inbounds, outbounds (from parser), observatory, and routing rules.

## 4. Integration & Logic

- [x] 4.1 Implement `packages/core/src/modules/plugin/xray/index.js` to orchestrate the lifecycle: download subscription -> generate config -> start process.
- [x] 4.2 Implement interception rule injection in `index.js`: on start, add `tunnel://` rules to `context.config.get().server.intercepts`; on stop, remove them.
- [x] 4.3 Implement dynamic configuration update: In `index.js`, trigger Mitmproxy hot reload (via `server.reload()`) after injecting/removing rules.

## 5. GUI Implementation

- [x] 5.1 Create `packages/gui/src/view/pages/plugin/xray.vue` component with configuration forms (switch, subscriptions, nodes, rules).
- [x] 5.2 Update `packages/gui/src/view/router/index.js` to register the new route `/plugin/xray`.
- [x] 5.3 Update `packages/gui/src/view/router/menu.js` to add the Xray menu item.

## 6. Verification

- [x] 6.1 Verify Xray process startup, shutdown, and auto-restart reliability from GUI.
- [x] 6.2 Verify Xray configuration generation (correct JSON structure in `userBasePath/xray/config.json`).
- [x] 6.3 Verify Subscription Parsing: Enter a subscription URL in GUI -> Verify nodes appear in `config.json`.
- [x] 6.4 Verify Manual Nodes: Enter a `vmess://` or `vless://` link in GUI -> Verify nodes appear in `config.json`.
- [x] 6.5 Verify Routing Rules: Add a domain (e.g. `test.com`) in GUI -> Verify traffic to `test.com` is intercepted and routed through Xray.
- [x] 6.6 Verify End-to-End: DevSideCar -> `tunnel://` -> Xray -> Target (e.g., `curl -x 127.0.0.1:port https://openai.com` or via browser).
