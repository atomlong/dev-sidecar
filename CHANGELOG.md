# Changelog

All notable changes to this project will be documented in this file.

## [v2.1.3] - 2026-05-16

### Added
- Added staged Xray workflow controls, including startup filters and cache refresh settings.
- Added Xray stage-gating options: `subscriptionSyncLowWatermark` and `cacheRefreshEnabled`.

### Changed
- Changed Xray startup to prefer stable nodes from the previous SQLite cache and to reuse cached `country`/`owner` metadata during stage 1 quick recheck.
- Changed post-start refresh into a multi-source cache rebuild with optional remote subscription fetching, followed by optional stage 3 cache-only probing.
- Changed stage 3 to use fixed rotating SQLite rowid batches and to keep only live cache entries with current metadata.

### Fixed
- Fixed Xray cache persistence to retain `stable`/`delay`/`country`/`owner` metadata for later startup selection.
- Fixed packaged Linux runtime cache access by bundling the missing `better-sqlite3` runtime dependencies.
- Fixed idle egress metadata probe process leaks by stopping temporary Xray instances immediately after exit-IP detection.
- Fixed Linux packaging noise by skipping RPM targets automatically when `rpmbuild` is unavailable and by bundling required Xray platform resources.
- Fixed stage 3 batch acceptance to require full observatory coverage before write-back, preventing partial-metrics misdeletion.
- Fixed SQLite shrink behavior after large stage 3 deletions by allowing aggressive incremental vacuum when the cache file is mostly free pages.

## [v2.1.2] - 2026-04-07

### Fixed
- Hardened the mitmproxy interception pipeline against missing `agent.options` values, fixing crashes on `daily-cloudcode-pa.googleapis.com` and related Google API requests.
- Added null-safe `rejectUnauthorized` access across request, upgrade, SNI, proxy, and unVerifySsl handlers.
- Pinned GitHub Actions native module rebuilds to Python 3.10, avoiding Windows build failures caused by Python 3.12 removing `distutils`.
- Restored macOS `universal` DMG packaging by thinning bundled Xray binaries to the target architecture before electron-builder performs universal `lipo` merging.
- Fixed macOS CI on arm64 runners by skipping `lipo -thin` when the downloaded Xray binary is already a single-architecture Mach-O for the target arch.
- Synchronized `build-and-release.yml` and `test-and-upload.yml` so cross-platform build behavior and macOS artifact outputs remain consistent.

## [v2.1.1] - 2026-03-01

### Added
- **Built-in Xray Core**: DevSideCar now bundles the Xray Core binaries and necessary `.dat` database files for all major platforms (Windows, macOS, Linux). Users no longer need to manually download or configure the `binPath`. The plugin is truly out-of-the-box.

### Changed
- Removed the manual `binPath` configuration option from the UI and backend logic.
- Automated downloading of specific Xray versions during the build process, reducing setup complexity.
- Updated documentation to reflect the new out-of-the-box Xray plugin experience.

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