# Changelog

All notable changes to this project will be documented in this file.

## [v2.1.5] - Unreleased

### Added
- Added targeted mitmproxy regression coverage for DNS-aware upgrade request handling.
- Added automatic Xray SQLite cache migration from the legacy `nodes` layout to split `node_runtime` and `node_payload` storage.
- Added one-time retirement metadata and post-retirement compaction for migrated Xray caches so existing installations can reclaim disk space without losing cached nodes.

### Changed
- Changed Xray cache writes and reads to treat the hot/cold SQLite schema as the authoritative store after migration, and to stop maintaining the legacy `nodes` table once retirement completes.
- Changed stage 2 large-subscription synchronization to flush accepted-node batches less frequently, reducing real Linux service peak memory from roughly 1.1 GB to about 550 MB in the current baseline verification.

### Fixed
- Fixed WebSocket and other HTTP upgrade requests to reuse the normal DNS resolution path, restoring Copilot Web chat message sending when those requests pass through DevSidecar.
- Fixed migrated Xray caches falling back to legacy-row assumptions after retirement, which could otherwise break empty-cache and follow-up refresh behavior.

## [v2.1.4] - 2026-05-20

### Added
- Added Xray subscription provenance tracking in the SQLite cache, including per-configured-subscription metadata and subscription-to-node references.
- Added stage 3 per-subscription usable-node summaries written to `stage3-last-round.json` after complete cache refresh rounds.
- Added `subscriptionStaleAfterDays` to control when stale subscription metadata can be cleaned up after stage 3 confirms no usable nodes remain.

### Changed
- Upgraded `better-sqlite3` to `12.10.0` in both `@docmirror/dev-sidecar` and `@docmirror/dev-sidecar-gui` to match the packaged Electron 41 runtime.
- Changed the GUI packaging pipeline to rebuild Electron native dependencies before `electron:build` and to bundle `better-sqlite3`, `bindings`, and `file-uri-to-path` into `app.asar.unpacked`.
- Changed Xray subscription synchronization so duplicate subscription URLs are tracked as separate configured entries by occurrence order.
- Changed subscription availability accounting to count only nodes that were actually usable in the current complete stage 3 round, rather than treating retained cache entries as current availability.
- Changed Xray probe logs to distinguish batch cache probes from egress metadata probes.

### Fixed
- Fixed packaged Linux builds failing to read the existing Xray SQLite cache, which previously surfaced as `Xray SQLite cache is unavailable` during startup and background refresh.
- Fixed packaged Linux startup path resolution so renderer assets load from the packaged app root and Xray resources resolve from `resources/extra`.
- Fixed packaged Linux startup crashes caused by `electron-updater` export-shape differences.
- Fixed stale subscription cleanup semantics so subscription metadata is removed only when it is older than the configured threshold and no cache nodes still reference it; `nodes` rows remain governed by stage 3 unusable-node probing.
- Fixed egress metadata probes being started for nodes that already have both `country` and `owner` metadata.
- Fixed lingering egress metadata Xray child processes by stopping them via the real child PID instead of relying on `child.killed` state.
- Fixed macOS GitHub Actions packaging by forcing a single `electron-builder` 26.8.1 dependency chain under pnpm, avoiding mixed 22.x/26.x builder modules during desktop builds.

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