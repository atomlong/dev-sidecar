# Changelog

All notable changes to this project will be documented in this file.

## [v2.1.0] - 2026-02-14

### Added
- **Xray Plugin**: Integrated Xray Core as a plugin, supporting advanced proxy protocols like VLESS, VMess, Trojan, and ShadowSocks.
- **Reality Support**: Added full support for VLESS/Trojan Reality protocol, including strict validation to prevent core crashes.
- **Tunnel Protocol**: Introduced `tunnel://` pseudo-protocol to support transparent HTTP CONNECT tunneling to local proxies.
- **Global Deduplication**: Implemented intelligent global deduplication for proxy nodes across multiple subscription sources.
- **Configuration**: Enhanced configuration schema to support plugin settings and routing rules.

### Fixed
- Fixed Reality protocol validation issues (shortId hex check, publicKey length check).
- Fixed Xray Core crash when using incompatible transport protocols (e.g., WebSocket) with Reality.
- Fixed potential port conflicts by implementing dynamic port allocation for Xray.

### Changed
- Updated `mitmproxy` to support dynamic hot reloading of interception rules.
- Optimized subscription parsing logic to handle various link formats and edge cases.