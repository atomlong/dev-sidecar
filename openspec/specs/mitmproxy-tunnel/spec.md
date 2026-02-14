# Spec: mitmproxy-tunnel

## Purpose
Enable Mitmproxy to support HTTP CONNECT tunneling to a local proxy (like Xray) via a `tunnel://` pseudo-protocol, allowing transparent traffic redirection.

## Requirements

### Requirement: Support Tunnel Pseudo-Protocol
The system SHALL support a `tunnel://` pseudo-protocol in the proxy configuration string to establish an HTTP CONNECT tunnel to a local proxy.

#### Scenario: Intercept Tunnel Request
- **WHEN** an intercepted request matches a rule with `proxy: "tunnel://host:port"`
- **THEN** the system SHALL parse the host and port
- **IF** the port is `0`:
  - The system SHALL resolve it using `context.setting.xrayPort` (injected by the Xray plugin)
- **THEN** the system SHALL create an HTTP/HTTPS Tunnel Agent connected to the resolved host and port
- **AND** the system SHALL assign this agent to the request options (`rOptions.agent`)
- **AND** the system SHALL NOT modify the request's original `hostname`, `port`, or `path` (preserving the original destination)

#### Scenario: Log Tunnel Connection
- **WHEN** a request is successfully tunneled
- **THEN** the system SHALL log the interception action with `proxy: tunnel://...` in the response header `DS-Interceptor` and console logs