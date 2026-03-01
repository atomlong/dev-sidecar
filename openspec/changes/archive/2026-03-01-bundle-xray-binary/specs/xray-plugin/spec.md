## MODIFIED Requirements

### Requirement: Plugin Configuration Schema
The system SHALL define a configuration schema for the Xray plugin in `config.json`.

#### Scenario: Configuration Fields
- **WHEN** the plugin configuration is initialized or saved
- **THEN** it SHALL support the following fields:
  - `enabled`: (Boolean) Enable/disable the plugin.
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
- **AND** the system SHALL resolve the built-in Xray binary located in the app's `extra` resources directory (ignoring any user-provided path).
- **AND** the system SHALL ensure the Xray database files (`geoip.dat` and `geosite.dat`) are available in the directory of the executed Xray binary.
- **AND** the system SHALL spawn the Xray binary process using the resolved built-in path.
- **AND** the system SHALL log the process PID, actual runtime port, and stdout/stderr
- **AND** the system SHALL expose the runtime port to the GUI for display

#### Scenario: Stop Xray
- **WHEN** the Xray plugin is disabled or the application shuts down
- **THEN** the system SHALL send a termination signal (SIGTERM) to the Xray process
- **AND** the system SHALL verify the process has exited

#### Scenario: Auto-Restart
- **WHEN** the Xray process exits unexpectedly (non-zero code)
- **THEN** the system SHALL attempt to restart the process automatically