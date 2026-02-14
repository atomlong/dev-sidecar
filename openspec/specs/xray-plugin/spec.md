# Spec: xray-plugin

## Purpose
Integrate Xray Core as a plugin to support advanced proxy protocols (VLESS, VMess, Trojan, etc.) and rule-based routing for specific domains.

## Requirements

### Requirement: Plugin Configuration Schema
The system SHALL define a configuration schema for the Xray plugin in `config.json`.

#### Scenario: Configuration Fields
- **WHEN** the plugin configuration is initialized or saved
- **THEN** it SHALL support the following fields:
  - `enabled`: (Boolean) Enable/disable the plugin.
  - `binPath`: (String) Absolute path to the Xray core binary (supports Windows/Linux/macOS paths).
  - `localPort`: (Number) Local port for Xray inbound (default: 10801). If 0, a random available port will be selected. If non-zero and occupied, the plugin SHALL fail to start.
  - `subscriptions`: (Array<String>) List of subscription URLs.
  - `nodes`: (Array<String>) List of manually added node links (vmess://, vless://, etc.).
  - `rules`: (Array<Object>) Routing rules definition. Each rule contains:
    - `domain`: (String|Array<String>) Target domain(s) (e.g., `openai.com`).
    - `outboundTag`: (String) Optional Xray outbound tag. Supported values: `balancer-proxy` (default), `direct`, `block`, or specific node tags.
  - `probeUrl`: (String) URL for latency testing (default: `https://www.google.com/generate_204`).
  - `probeInterval`: (Number) Interval in seconds for probing (default: 300).

### Requirement: Manage Xray Process Lifecycle
The system SHALL manage the lifecycle of the Xray Core subprocess, including starting, stopping, and restarting it based on plugin status.

#### Scenario: Start Xray
- **WHEN** the Xray plugin is enabled and started
- **THEN** the system SHALL determine the actual listening port:
  - If `localPort` is configured (non-zero), use it. If occupied, **FAIL** with an error log.
  - If `localPort` is 0, find a random available port.
- **AND** the system SHALL save the actual runtime port to `context.config.get().server.setting.xrayPort` (for `mitmproxy` to resolve port 0)
- **AND** the system SHALL generate the configuration with this runtime port
- **AND** the system SHALL spawn the Xray binary process using the `binPath` from configuration
- **AND** the system SHALL log the process PID, actual runtime port, and stdout/stderr
- **AND** the system SHALL expose the runtime port to the GUI for display

#### Scenario: Stop Xray
- **WHEN** the Xray plugin is disabled or the application shuts down
- **THEN** the system SHALL send a termination signal (SIGTERM) to the Xray process
- **AND** the system SHALL verify the process has exited

#### Scenario: Auto-Restart
- **WHEN** the Xray process exits unexpectedly (non-zero code)
- **THEN** the system SHALL attempt to restart the process automatically

### Requirement: Parse Proxy Subscriptions
The system SHALL parse subscription URLs to extract proxy node configurations.

#### Scenario: Parse Subscription Content
- **WHEN** a subscription URL is fetched
- **THEN** the system SHALL detect if the response body is Base64 encoded
- **IF** Base64 encoded: Decode it to get the node list (handling URL-safe base64 and standard base64, and fixing padding)
- **IF** Not Base64 encoded: Treat the body directly as a newline-separated list of links
- **AND** the system SHALL robustly clean each link:
  - Trim whitespace (leading/trailing)
  - Remove illegal characters (like control characters)
  - Handle URL encoding issues
- **AND** the system SHALL filter out empty lines and comments

#### Scenario: Parse Various Protocols
- **WHEN** a link URI is extracted from the subscription or `nodes`
- **THEN** the system SHALL parse it into a valid Xray `outbound` configuration object, extracting all relevant fields:
  - **Common**: `address`, `port`, `uuid`/`password`, `network` (tcp/kcp/ws/h2/quic/grpc), `security` (tls/reality/xtls).
  - **Transport Settings**: `ws-opts` (path, headers), `grpc-opts` (serviceName), `http-opts` (path, host), `quic-opts`, `kcp-opts` (seed).
  - **TLS/Reality Settings**: `sni` (serverName), `fp` (fingerprint), `alpn`, `flow` (xtls-rprx-vision), `pbk` (publicKey), `sid` (shortId).
  - **Protocols**:
    - `vmess://`: Base64 JSON (v2rayN format).
    - `vless://`: URI Scheme (standard Xray format).
    - `trojan://`: URI Scheme.
    - `ss://`: URI Scheme (SIP002) or Legacy Base64.
- **AND** the system SHALL filter out invalid or unsupported links

### Requirement: Generate Xray Configuration
The system SHALL dynamically generate a valid `config.json` file for Xray based on current settings and subscription nodes.

#### Scenario: Generate Config File
- **WHEN** the plugin initializes or configuration changes
- **THEN** the system SHALL create a `config.json` file at `path.join(userBasePath, 'xray', 'config.json')` (e.g., `~/.dev-sidecar/xray/config.json`) containing:
  - An `inbound` listening on the configured `localPort` (SOCKS/HTTP)
  - `outbounds` for all parsed proxy nodes (each assigned a unique `tag`), plus `direct` and `block`
  - An `observatory` configuration using `probeUrl` and `probeInterval`
  - A `balancer` configuration to select the optimal node
  - `routing` rules generated from the plugin's `rules` configuration, mapping `domain` to `outboundTag`

### Requirement: Inject Interception Rules
The system SHALL dynamically inject interception rules into the global proxy configuration to route specific traffic to the Xray plugin.

#### Scenario: Inject Rules on Start (Skip Strategy)
- **WHEN** the Xray plugin starts
- **THEN** the system SHALL iterate through the configured `rules`
- **FOR EACH** rule domain:
  - Check if a rule already exists in `context.config.get().server.intercepts`.
  - **IF** exists: Log a warning ("Rule for {domain} already exists, skipping Xray injection") and **DO NOT** inject.
  - **ELSE** (not exists): Inject the new rule targeting the Xray tunnel using the **runtime allocated port** (e.g., `proxy: tunnel://127.0.0.1:<runtimePort>`).
- **AND** the system SHALL trigger a Mitmproxy hot reload (via IPC message) to apply the new rules immediately without restarting the server.

#### Scenario: Remove Rules on Stop
- **WHEN** the Xray plugin stops
- **THEN** the system SHALL iterate through the **injected** rules (only those successfully added by the plugin)
- **AND** remove them from `context.config`
- **AND** the system SHALL trigger a Mitmproxy hot reload to remove the rules from the active proxy.